import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MAX_BACKOFF_MS, hasWindows, nextPollDelayMs, parseCredential, parseUsage } from '../src/limitsApi';
import {
  DEFAULT_CONTEXT_WINDOW,
  LARGE_CONTEXT_WINDOW,
  contextTokens,
  isLargeContextModel,
  resolveContextWindow,
  windowForFamily,
} from '../src/transcript';

test('parses the usage endpoint the way Claude Code renders it', () => {
  const limits = parseUsage({
    five_hour: { utilization: 58, resets_at: '2026-08-27T14:00:00.000Z' },
    seven_day: { utilization: 14.4, resets_at: '2026-08-31T09:00:00.000Z' },
    seven_day_sonnet: { utilization: 3, resets_at: null },
  });

  assert.equal(limits.fiveHour!.usedPercent, 58);
  assert.equal(limits.fiveHour!.resetsAt, Date.parse('2026-08-27T14:00:00.000Z'));
  assert.equal(limits.sevenDay!.usedPercent, 14.4);
  assert.equal(limits.sevenDaySonnet!.resetsAt, undefined);
  assert.equal(hasWindows(limits), true);
});

test('accepts a reset time sent as epoch seconds or milliseconds', () => {
  const seconds = parseUsage({ five_hour: { utilization: 1, resets_at: 1_800_000_000 } });
  const millis = parseUsage({ five_hour: { utilization: 1, resets_at: 1_800_000_000_000 } });
  assert.equal(seconds.fiveHour!.resetsAt, 1_800_000_000_000);
  assert.equal(millis.fiveHour!.resetsAt, 1_800_000_000_000);
});

test('an account with no windows parses to no windows rather than to zeroes', () => {
  const limits = parseUsage({ five_hour: null, seven_day: { utilization: null } });
  assert.equal(limits.fiveHour, undefined);
  assert.equal(limits.sevenDay, undefined);
  assert.equal(hasWindows(limits), false);
  assert.deepEqual(parseUsage('not json at all'), {});
});

test('reads the OAuth token out of a credentials file', () => {
  const credential = parseCredential(
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat-example',
        expiresAt: 1_800_000_000_000,
        subscriptionType: 'team',
      },
    }),
    'file',
  );

  assert.equal(credential!.accessToken, 'sk-ant-oat-example');
  assert.equal(credential!.expiresAt, 1_800_000_000_000);
  assert.equal(credential!.subscriptionType, 'team');
  assert.equal(credential!.source, 'file');
  assert.equal(parseCredential('{}', 'file'), undefined);
  assert.equal(parseCredential('truncated…', 'keychain'), undefined);
});

test('the context reading leaves out the tokens the window is not holding', () => {
  const used = contextTokens({
    input_tokens: 12,
    cache_read_input_tokens: 120_000,
    cache_creation_input_tokens: 9_400,
    output_tokens: 5_000,
  });
  assert.equal(used, 129_412);
});

test('the 1M marker is recognised wherever it appears', () => {
  assert.equal(isLargeContextModel('claude-opus-5[1m]'), true);
  assert.equal(isLargeContextModel('sonnet[1m]'), true);
  assert.equal(isLargeContextModel('claude-opus-5'), false);
  assert.equal(isLargeContextModel(undefined), false);
});

test('each family gets the window Claude Code gives it, not the model maximum', () => {
  // Sonnet 5 is a 1M-context model, but Claude Code runs it at 200K unless the 1M
  // variant is picked — which is why the family table cannot be the API's own.
  assert.equal(windowForFamily('claude-sonnet-5'), DEFAULT_CONTEXT_WINDOW);
  assert.equal(windowForFamily('claude-haiku-4-5'), DEFAULT_CONTEXT_WINDOW);
  assert.equal(windowForFamily('claude-opus-5'), LARGE_CONTEXT_WINDOW);
  assert.equal(windowForFamily('claude-fable-5'), LARGE_CONTEXT_WINDOW);
  assert.equal(windowForFamily('opus'), LARGE_CONTEXT_WINDOW);
  // Pre-5 Opus was offered at 200K too, so it needs the marker like Sonnet does.
  assert.equal(windowForFamily('claude-opus-4-8'), undefined);
  assert.equal(windowForFamily('some-other-model'), undefined);
});

test('a 1M Opus session is recognised from the transcript alone', () => {
  // The transcript records `claude-opus-5` with the marker stripped. Opus ships only
  // with its 1M window, so the family answers what the marker cannot.
  const resolved = resolveContextWindow('claude-opus-5', 0, 130_000, undefined);
  assert.equal(resolved.size, LARGE_CONTEXT_WINDOW);
  assert.equal(resolved.source, 'family');
});

test('a Sonnet forced to 1M is recognised from the marker', () => {
  const plain = resolveContextWindow('claude-sonnet-5', 0, 40_000, undefined);
  assert.equal(plain.size, DEFAULT_CONTEXT_WINDOW);
  assert.equal(plain.source, 'family');

  const forced = resolveContextWindow('claude-sonnet-5', 0, 40_000, 'sonnet[1m]');
  assert.equal(forced.size, LARGE_CONTEXT_WINDOW);
  assert.equal(forced.source, 'marker');
});

test('a session past 200K tokens overrides a 200K family verdict', () => {
  const resolved = resolveContextWindow('claude-sonnet-5', 0, 240_000, undefined);
  assert.equal(resolved.size, LARGE_CONTEXT_WINDOW);
  assert.equal(resolved.source, 'observed');
});

test('an unrecognised model falls back to 200K and says so', () => {
  const resolved = resolveContextWindow('some-future-model', 0, 1_000, undefined);
  assert.equal(resolved.size, DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolved.source, 'default');
});

test('a healthy poll uses the plain configured interval', () => {
  assert.equal(nextPollDelayMs(60_000, 0), 60_000);
});

test('a run of unavailable results backs off exponentially, capped', () => {
  assert.equal(nextPollDelayMs(60_000, 1), 120_000);
  assert.equal(nextPollDelayMs(60_000, 2), 240_000);
  assert.equal(nextPollDelayMs(60_000, 3), 480_000);
  // Keeps doubling well past what any sane refresh interval would need, so it must
  // saturate rather than overflow or grow unbounded.
  assert.equal(nextPollDelayMs(60_000, 20), MAX_BACKOFF_MS);
});

test('a Retry-After longer than the doubled wait wins', () => {
  assert.equal(nextPollDelayMs(60_000, 1, 10 * 60_000), 10 * 60_000);
  // But a short Retry-After does not cut the backoff short.
  assert.equal(nextPollDelayMs(60_000, 3, 1_000), 480_000);
});

test('the setting overrides every other signal', () => {
  const resolved = resolveContextWindow('claude-opus-5[1m]', 500_000, 0, 'opus[1m]');
  assert.equal(resolved.size, 500_000);
  assert.equal(resolved.source, 'setting');
});
