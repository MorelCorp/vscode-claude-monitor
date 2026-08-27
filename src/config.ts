import * as vscode from 'vscode';
import { BarStyle, ContextDisplay } from './render';
import { MetricId } from './types';

export interface MonitorConfig {
  enabled: boolean;
  segments: MetricId[];
  style: BarStyle;
  barLength: number;
  showPercentage: boolean;
  showResetCountdown: boolean;
  contextDisplay: ContextDisplay;
  showLabel: boolean;
  warningThreshold: number;
  criticalThreshold: number;
  contextWarningThreshold: number;
  contextCriticalThreshold: number;
  highlightBackground: boolean;
  notifications: 'off' | 'critical' | 'warning';
  alignment: vscode.StatusBarAlignment;
  priority: number;
  restrictContextToWorkspace: boolean;
  staleAfterMinutes: number;
  hideWhenNoData: boolean;
  transcriptFallback: boolean;
  /** 0 means "work it out from the model and the session". */
  contextWindowSize: number;
  rateLimitsSource: RateLimitsSource;
  rateLimitsRefreshSeconds: number;
  pollIntervalSeconds: number;
  promptToConnect: boolean;
}

/**
 * Where the 5-hour and 7-day meters get their numbers. `auto` uses the status line
 * payload when it carries limits and the usage endpoint otherwise, which today
 * always means the endpoint.
 */
export type RateLimitsSource = 'auto' | 'api' | 'statusLine' | 'off';

const VALID_SEGMENTS: MetricId[] = ['session', 'week', 'context'];

export function readConfig(): MonitorConfig {
  const c = vscode.workspace.getConfiguration('claudeMonitor');

  const rawSegments = c.get<string[]>('segments', ['session', 'week', 'context']);
  const segments = rawSegments.filter((s): s is MetricId =>
    VALID_SEGMENTS.includes(s as MetricId),
  );

  return {
    enabled: c.get<boolean>('enabled', true),
    segments: segments.length > 0 ? dedupe(segments) : VALID_SEGMENTS,
    style: c.get<BarStyle>('style', 'dots'),
    barLength: clamp(c.get<number>('barLength', 5), 3, 20),
    showPercentage: c.get<boolean>('showPercentage', false),
    showResetCountdown: c.get<boolean>('showResetCountdown', true),
    contextDisplay: c.get<ContextDisplay>('contextDisplay', 'tokens+percent'),
    showLabel: c.get<boolean>('showLabel', true),
    warningThreshold: clamp(c.get<number>('warningThreshold', 70), 1, 100),
    criticalThreshold: clamp(c.get<number>('criticalThreshold', 90), 1, 100),
    contextWarningThreshold: clamp(c.get<number>('contextWarningThreshold', 75), 1, 100),
    contextCriticalThreshold: clamp(c.get<number>('contextCriticalThreshold', 90), 1, 100),
    highlightBackground: c.get<boolean>('highlightBackground', false),
    notifications: c.get<'off' | 'critical' | 'warning'>('notifications', 'critical'),
    alignment:
      c.get<string>('alignment', 'right') === 'left'
        ? vscode.StatusBarAlignment.Left
        : vscode.StatusBarAlignment.Right,
    priority: c.get<number>('priority', 100),
    restrictContextToWorkspace: c.get<string>('contextSource', 'workspace') === 'workspace',
    staleAfterMinutes: Math.max(1, c.get<number>('staleAfterMinutes', 30)),
    hideWhenNoData: c.get<boolean>('hideWhenNoData', false),
    transcriptFallback: c.get<boolean>('transcriptFallback', true),
    contextWindowSize: Math.max(0, c.get<number>('contextWindowSize', 0)),
    rateLimitsSource: c.get<RateLimitsSource>('rateLimits.source', 'auto'),
    rateLimitsRefreshSeconds: clamp(c.get<number>('rateLimits.refreshSeconds', 60), 15, 3600),
    pollIntervalSeconds: clamp(c.get<number>('pollIntervalSeconds', 5), 1, 300),
    promptToConnect: c.get<boolean>('promptToConnect', true),
  };
}

/** Changing these means the status bar items have to be torn down and rebuilt. */
export function layoutKey(config: MonitorConfig): string {
  return [
    config.alignment,
    config.priority,
    config.showLabel ? 'label' : 'no-label',
    config.segments.join(','),
  ].join('|');
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
