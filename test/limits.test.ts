import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { hasWindows, parseCredential, parseUsage } from '../src/limitsApi';
import {
  DEFAULT_CONTEXT_WINDOW,
  LARGE_CONTEXT_WINDOW,
  contextTokens,
  isLargeContextModel,
  resolveContextWindow,
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

test('a 1M session is detected from the configured model, not the transcript', () => {
  // Transcripts record the API model name with the marker stripped, so the model on
  // the turn itself says nothing about the window size.
  const fromTranscript = resolveContextWindow('claude-opus-5', 0, 130_000, undefined);
  assert.equal(fromTranscript.size, DEFAULT_CONTEXT_WINDOW);

  const fromSettings = resolveContextWindow('claude-opus-5', 0, 130_000, 'opus[1m]');
  assert.equal(fromSettings.size, LARGE_CONTEXT_WINDOW);
  assert.equal(fromSettings.source, 'model');
});

test('a session past 200K tokens has settled the question itself', () => {
  const resolved = resolveContextWindow('claude-opus-5', 0, 240_000, undefined);
  assert.equal(resolved.size, LARGE_CONTEXT_WINDOW);
  assert.equal(resolved.source, 'observed');
});

test('the setting overrides every other signal', () => {
  const resolved = resolveContextWindow('claude-opus-5[1m]', 500_000, 0, 'opus[1m]');
  assert.equal(resolved.size, 500_000);
  assert.equal(resolved.source, 'setting');
});
