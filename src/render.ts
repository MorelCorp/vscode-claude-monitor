import { Level } from './types';

export type BarStyle = 'dots' | 'blocks' | 'ascii' | 'percent';

const GLYPHS: Record<Exclude<BarStyle, 'percent'>, { full: string; empty: string; open: string; close: string }> = {
  dots: { full: '●', empty: '○', open: '', close: '' },
  blocks: { full: '█', empty: '░', open: '', close: '' },
  ascii: { full: '#', empty: '-', open: '[', close: ']' },
};

/**
 * Draw a `length`-cell meter for `percent`.
 *
 * Any non-zero usage lights the first cell, so "barely started" never reads as
 * "nothing used", and a cell only fills once its share is fully consumed.
 */
export function bar(percent: number | undefined, length: number, style: BarStyle): string {
  if (style === 'percent') {
    return '';
  }
  const g = GLYPHS[style];
  if (percent === undefined || !Number.isFinite(percent)) {
    return g.open + g.empty.repeat(length) + g.close;
  }
  const clamped = Math.max(0, Math.min(100, percent));
  let filled = Math.floor((clamped / 100) * length);
  if (clamped > 0 && filled === 0) {
    filled = 1;
  }
  if (clamped >= 100) {
    filled = length;
  }
  return g.open + g.full.repeat(filled) + g.empty.repeat(length - filled) + g.close;
}

/** `93` -> `93%`, `7.4` -> `7%`, unknown -> `--%`. */
export function formatPercent(percent: number | undefined): string {
  if (percent === undefined || !Number.isFinite(percent)) {
    return '--%';
  }
  return `${Math.round(Math.max(0, Math.min(100, percent)))}%`;
}

/**
 * Compact countdown: `3d 2h`, `1h 5m`, `21m`, `<1m`. Past due reads `now`.
 */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return '--';
  }
  if (seconds <= 0) {
    return 'now';
  }
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return '<1m';
}

/** `128431` -> `128k`, `1_240_000` -> `1.2M`. */
export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens)) {
    return '--';
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return `${Math.round(tokens)}`;
}

export function levelFor(percent: number | undefined, warning: number, critical: number): Level {
  if (percent === undefined || !Number.isFinite(percent)) {
    return 'normal';
  }
  // A critical threshold below the warning threshold would otherwise be unreachable.
  const crit = Math.max(warning, critical);
  if (percent >= crit) {
    return 'critical';
  }
  if (percent >= warning) {
    return 'warning';
  }
  return 'normal';
}

const LEVEL_RANK: Record<Level, number> = { normal: 0, warning: 1, critical: 2 };

export function worstLevel(levels: Level[]): Level {
  return levels.reduce<Level>((worst, l) => (LEVEL_RANK[l] > LEVEL_RANK[worst] ? l : worst), 'normal');
}
