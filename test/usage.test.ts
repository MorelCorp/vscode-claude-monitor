import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildUsageModel, BuildOptions } from '../src/usage';
import { LimitsResult } from '../src/limitsApi';
import { Snapshot, StatusLinePayload } from '../src/types';

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);

function options(overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    folders: ['/home/user/project'],
    restrictContextToWorkspace: true,
    warningThreshold: 70,
    criticalThreshold: 90,
    contextWarningThreshold: 75,
    contextCriticalThreshold: 90,
    staleAfterMinutes: 30,
    transcriptFallback: false,
    contextWindowSize: 0,
    now: NOW,
    ...overrides,
  };
}

function snapshot(payload: StatusLinePayload, agoMs = 1000, file = 'a.json'): Snapshot {
  return { payload, observedAt: NOW - agoMs, file };
}

const FULL: StatusLinePayload = {
  session_id: 'abc',
  cwd: '/home/user/project',
  model: { id: 'claude-opus-5', display_name: 'Opus 5' },
  workspace: { current_dir: '/home/user/project', project_dir: '/home/user/project' },
  context_window: {
    total_input_tokens: 150_000,
    context_window_size: 200_000,
    used_percentage: 75,
    current_usage: { input_tokens: 12, cache_read_input_tokens: 149_988, output_tokens: 500 },
  },
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: Math.floor(NOW / 1000) + 21 * 60 },
    seven_day: { used_percentage: 93, resets_at: Math.floor(NOW / 1000) + 3 * 86400 + 2 * 3600 },
  },
};

test('maps a full payload onto the three meters', () => {
  const model = buildUsageModel([snapshot(FULL)], options());

  const session = model.metrics.find((m) => m.id === 'session')!;
  assert.equal(session.percent, 42);
  assert.equal(session.level, 'normal');
  assert.equal(Math.round(session.resetsInSeconds!), 21 * 60);

  const week = model.metrics.find((m) => m.id === 'week')!;
  assert.equal(week.percent, 93);
  assert.equal(week.level, 'critical');

  const context = model.metrics.find((m) => m.id === 'context')!;
  assert.equal(context.percent, 75);
  assert.equal(context.level, 'warning');
  assert.equal(context.usedTokens, 150_000);
  assert.equal(context.totalTokens, 200_000);

  assert.equal(model.stale, false);
  assert.equal(model.estimated, false);
  assert.equal(model.rateLimitsUnavailable, false);
  assert.equal(model.model, 'Opus 5');
});

test('rate limits come from the newest session that reports them, whatever its folder', () => {
  const elsewhere = snapshot(
    { ...FULL, cwd: '/somewhere/else', workspace: { current_dir: '/somewhere/else' } },
    1_000,
    'elsewhere.json',
  );
  const local = snapshot(
    {
      session_id: 'local',
      cwd: '/home/user/project',
      workspace: { current_dir: '/home/user/project' },
      context_window: { total_input_tokens: 20_000, context_window_size: 200_000, used_percentage: 10 },
    },
    5_000,
    'local.json',
  );

  const model = buildUsageModel([elsewhere, local], options());

  assert.equal(model.metrics.find((m) => m.id === 'session')!.percent, 42);
  // Context stays with this workspace's session rather than following the newer one.
  assert.equal(model.metrics.find((m) => m.id === 'context')!.percent, 10);
});

test('context stays unknown when no session in this workspace has reported', () => {
  const elsewhere = snapshot({ ...FULL, cwd: '/somewhere/else', workspace: { current_dir: '/somewhere/else' } });
  const model = buildUsageModel([elsewhere], options());
  assert.equal(model.metrics.find((m) => m.id === 'context')!.percent, undefined);
});

test('contextSource "any" falls back to the newest session anywhere', () => {
  const elsewhere = snapshot({ ...FULL, cwd: '/somewhere/else', workspace: { current_dir: '/somewhere/else' } });
  const model = buildUsageModel([elsewhere], options({ restrictContextToWorkspace: false }));
  assert.equal(model.metrics.find((m) => m.id === 'context')!.percent, 75);
});

const API_LIMITS: LimitsResult = {
  status: 'ok',
  fetchedAt: NOW - 5_000,
  source: 'keychain',
  limits: {
    fiveHour: { usedPercent: 58, resetsAt: NOW + 2 * 3600 * 1000 },
    sevenDay: { usedPercent: 14, resetsAt: NOW + 4 * 86400 * 1000 },
  },
};

test('the usage endpoint fills the limit meters the status line never carries', () => {
  const noLimits = snapshot({ ...FULL, rate_limits: undefined });
  const model = buildUsageModel([noLimits], options({ limits: API_LIMITS }));

  const session = model.metrics.find((m) => m.id === 'session')!;
  assert.equal(session.percent, 58);
  assert.equal(session.source, 'api');
  assert.equal(Math.round(session.resetsInSeconds!), 2 * 3600);

  const week = model.metrics.find((m) => m.id === 'week')!;
  assert.equal(week.percent, 14);
  assert.equal(model.rateLimitsUnavailable, false);
});

test('a status line that does carry limits still wins over the endpoint', () => {
  const model = buildUsageModel([snapshot(FULL)], options({ limits: API_LIMITS }));
  const session = model.metrics.find((m) => m.id === 'session')!;
  assert.equal(session.percent, 42);
  assert.equal(session.source, 'bridge');
});

test('flags accounts the endpoint reports no limits for', () => {
  const noLimits = snapshot({ ...FULL, rate_limits: undefined });
  const model = buildUsageModel(
    [noLimits],
    options({ limits: { status: 'ok', limits: {}, fetchedAt: NOW, source: 'file' } }),
  );
  assert.equal(model.rateLimitsUnavailable, true);
  assert.equal(model.metrics.find((m) => m.id === 'session')!.percent, undefined);
});

test('a blank limit meter says why it is blank', () => {
  const noLimits = snapshot({ ...FULL, rate_limits: undefined });
  const model = buildUsageModel([noLimits], options({ limits: { status: 'no-credentials' } }));
  const session = model.metrics.find((m) => m.id === 'session')!;
  assert.equal(session.percent, undefined);
  assert.match(session.detail.join(' '), /no Claude Code login/);
});

test('a fresh endpoint reading keeps the meters live with no bridge at all', () => {
  const model = buildUsageModel([], options({ limits: API_LIMITS }));
  assert.equal(model.stale, false);
  assert.equal(model.metrics.find((m) => m.id === 'week')!.percent, 14);
});

test('goes stale once nothing has reported for the configured window', () => {
  const model = buildUsageModel([snapshot(FULL, 45 * 60 * 1000)], options());
  assert.equal(model.stale, true);
});

test('no snapshots and no endpoint reading yields empty meters rather than throwing', () => {
  const model = buildUsageModel([], options());
  assert.equal(model.metrics.length, 3);
  assert.ok(model.metrics.every((m) => m.percent === undefined));
  assert.equal(model.stale, true);
  assert.equal(model.rateLimitsUnavailable, false);
});

test('a context window reported as null is treated as unknown', () => {
  const payload: StatusLinePayload = {
    ...FULL,
    context_window: { context_window_size: 200_000, used_percentage: null, current_usage: null },
  };
  const model = buildUsageModel([snapshot(payload)], options());
  assert.equal(model.metrics.find((m) => m.id === 'context')!.percent, undefined);
});

test('the transcript fallback carries a token count too', (t) => {
  const original = process.env.CLAUDE_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-monitor-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (original === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = original;
    }
  });

  const project = path.join(dir, 'projects', '-tmp-proj');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'session.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user' } }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 99_988,
            cache_creation_input_tokens: 0,
            // Excluded from the context reading: output only occupies the window
            // once it comes back as input on the next turn.
            output_tokens: 4_000,
          },
        },
      }),
    ].join('\n') + '\n',
  );
  process.env.CLAUDE_CONFIG_DIR = dir;

  const model = buildUsageModel(
    [],
    options({ folders: ['/tmp/proj'], transcriptFallback: true }),
  );
  const context = model.metrics.find((m) => m.id === 'context')!;

  assert.equal(model.estimated, true);
  assert.equal(context.usedTokens, 100_000);
  assert.equal(context.totalTokens, 200_000);
  assert.equal(context.percent, 50);
});
