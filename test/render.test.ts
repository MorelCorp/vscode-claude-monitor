import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bar, formatDuration, formatPercent, formatTokens, levelFor, worstLevel } from '../src/render';

test('bar fills proportionally', () => {
  assert.equal(bar(0, 5, 'dots'), '○○○○○');
  assert.equal(bar(100, 5, 'dots'), '●●●●●');
  assert.equal(bar(40, 5, 'dots'), '●●○○○');
  assert.equal(bar(50, 4, 'blocks'), '██░░');
  assert.equal(bar(60, 5, 'ascii'), '[###--]');
});

test('bar lights the first cell for any non-zero usage', () => {
  assert.equal(bar(1, 5, 'dots'), '●○○○○');
  assert.equal(bar(0.1, 5, 'dots'), '●○○○○');
});

test('bar clamps out-of-range and unknown values', () => {
  assert.equal(bar(140, 5, 'dots'), '●●●●●');
  assert.equal(bar(-10, 5, 'dots'), '○○○○○');
  assert.equal(bar(undefined, 5, 'dots'), '○○○○○');
  assert.equal(bar(50, 5, 'percent'), '');
});

test('formatPercent rounds and handles unknown', () => {
  assert.equal(formatPercent(7.4), '7%');
  assert.equal(formatPercent(99.6), '100%');
  assert.equal(formatPercent(undefined), '--%');
});

test('formatDuration is compact', () => {
  assert.equal(formatDuration(21 * 60), '21m');
  assert.equal(formatDuration(3 * 86400 + 2 * 3600), '3d 2h');
  assert.equal(formatDuration(3 * 86400), '3d');
  assert.equal(formatDuration(3900), '1h 5m');
  assert.equal(formatDuration(30), '<1m');
  assert.equal(formatDuration(0), 'now');
  assert.equal(formatDuration(-5), 'now');
  assert.equal(formatDuration(undefined), '--');
});

test('formatTokens abbreviates', () => {
  assert.equal(formatTokens(128_431), '128k');
  assert.equal(formatTokens(1_240_000), '1.2M');
  assert.equal(formatTokens(420), '420');
});

test('levelFor respects thresholds', () => {
  assert.equal(levelFor(10, 70, 90), 'normal');
  assert.equal(levelFor(70, 70, 90), 'warning');
  assert.equal(levelFor(90, 70, 90), 'critical');
  assert.equal(levelFor(undefined, 70, 90), 'normal');
});

test('an inverted critical threshold collapses into the warning threshold', () => {
  // critical < warning would otherwise make "critical" unreachable; instead the
  // warning band closes and everything at or above the warning threshold is critical.
  assert.equal(levelFor(79, 80, 50), 'normal');
  assert.equal(levelFor(85, 80, 50), 'critical');
  assert.equal(levelFor(95, 80, 50), 'critical');
});

test('worstLevel picks the highest', () => {
  assert.equal(worstLevel(['normal', 'warning', 'normal']), 'warning');
  assert.equal(worstLevel(['warning', 'critical']), 'critical');
  assert.equal(worstLevel([]), 'normal');
});
