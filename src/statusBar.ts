import * as vscode from 'vscode';
import { MonitorConfig, layoutKey } from './config';
import { bar, contextReadout, formatDuration, formatPercent, worstLevel } from './render';
import { Level, Metric, MetricId, UsageModel } from './types';

const COLORS: Record<Level, string> = {
  normal: 'claudeMonitor.normalForeground',
  warning: 'claudeMonitor.warningForeground',
  critical: 'claudeMonitor.criticalForeground',
};

const TITLES: Record<MetricId, string> = {
  session: '5-hour session',
  week: '7-day week',
  context: 'Context window',
};

/**
 * Renders the meters as one status bar item per metric, so each can carry its own
 * colour — a single item only supports one foreground for the whole string.
 */
export class StatusBar implements vscode.Disposable {
  private items: vscode.StatusBarItem[] = [];
  private layout = '';

  dispose(): void {
    this.disposeItems();
  }

  hide(): void {
    for (const item of this.items) {
      item.hide();
    }
  }

  render(model: UsageModel, config: MonitorConfig, bridgeInstalled: boolean): void {
    const shown = config.segments
      .map((id) => model.metrics.find((m) => m.id === id))
      .filter((m): m is Metric => m !== undefined);

    this.ensureItems(config, shown.length);

    const tooltip = buildTooltip(model, config, bridgeInstalled);
    const overall = worstLevel(shown.map((m) => m.level));
    let index = 0;

    if (config.showLabel) {
      const item = this.items[index++];
      item.text = overall === 'normal' ? 'Claude' : `Claude $(${overall === 'critical' ? 'error' : 'warning'})`;
      item.tooltip = tooltip;
      item.command = 'claudeMonitor.showDetails';
      applyColor(item, overall, model.stale, config);
      item.show();
    }

    for (const metric of shown) {
      const item = this.items[index++];
      item.text = renderMetric(metric, config);
      item.tooltip = tooltip;
      item.command = 'claudeMonitor.showDetails';
      applyColor(item, metric.level, model.stale, config, metric.id === 'context');
      item.show();
    }
  }

  /** A single "connect me" item shown while the bridge is not installed. */
  renderSetup(config: MonitorConfig): void {
    this.ensureItems(config, 0, 'setup');
    const item = this.items[0];
    item.text = 'Claude $(plug)';
    item.command = 'claudeMonitor.installBridge';
    const tooltip = new vscode.MarkdownString(
      '**Claude Usage Monitor**\n\n' +
        'Not connected to Claude Code yet.\n\n' +
        'Click to install the status line bridge that reports your context window and ' +
        'subscription limits.',
    );
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    item.color = undefined;
    item.backgroundColor = undefined;
    item.show();
  }

  private ensureItems(config: MonitorConfig, metricCount: number, mode = 'meters'): void {
    const key = `${mode}|${layoutKey(config)}|${metricCount}`;
    if (key === this.layout && this.items.length > 0) {
      return;
    }
    this.disposeItems();

    const count = mode === 'setup' ? 1 : (config.showLabel ? 1 : 0) + metricCount;
    for (let i = 0; i < count; i++) {
      // Descending priority keeps the items in the order we create them.
      this.items.push(vscode.window.createStatusBarItem(config.alignment, config.priority - i));
    }
    this.layout = key;
  }

  private disposeItems(): void {
    for (const item of this.items) {
      item.dispose();
    }
    this.items = [];
    this.layout = '';
  }
}

function renderMetric(metric: Metric, config: MonitorConfig): string {
  const parts = [metric.label];

  const drawn = bar(metric.percent, config.barLength, config.style);
  if (drawn.length > 0) {
    parts.push(drawn);
  }

  if (metric.id === 'context') {
    // The context meter reads out its own token count; `showPercentage` governs the
    // rate limit meters, which have no token count to show.
    const readout = contextReadout(
      metric.usedTokens,
      metric.totalTokens,
      metric.percent,
      config.contextDisplay,
    );
    if (readout.length > 0) {
      parts.push(readout);
    }
  } else {
    if (config.showPercentage || config.style === 'percent') {
      parts.push(formatPercent(metric.percent));
    }
    if (config.showResetCountdown && metric.resetsInSeconds !== undefined) {
      parts.push(`$(history) ${formatDuration(metric.resetsInSeconds)}`);
    }
  }

  return parts.join(' ');
}

function applyColor(
  item: vscode.StatusBarItem,
  level: Level,
  stale: boolean,
  config: MonitorConfig,
  isContext = false,
): void {
  if (stale) {
    item.color = new vscode.ThemeColor('claudeMonitor.staleForeground');
    item.backgroundColor = undefined;
    return;
  }
  const colorId = level === 'normal' && isContext ? 'claudeMonitor.contextForeground' : COLORS[level];
  item.color = new vscode.ThemeColor(colorId);
  item.backgroundColor =
    config.highlightBackground && level === 'critical'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : undefined;
}

export function buildTooltip(
  model: UsageModel,
  config: MonitorConfig,
  bridgeInstalled: boolean,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.isTrusted = true;

  md.appendMarkdown('**Claude Code usage**\n\n');
  md.appendMarkdown('| | Used | Resets |\n|---|---:|---|\n');
  for (const id of config.segments) {
    const metric = model.metrics.find((m) => m.id === id);
    if (!metric) {
      continue;
    }
    const resets =
      metric.resetsAt !== undefined
        ? `${formatDuration(metric.resetsInSeconds)} (${new Date(metric.resetsAt).toLocaleString()})`
        : '—';
    md.appendMarkdown(`| ${TITLES[id]} | ${formatPercent(metric.percent)} | ${resets} |\n`);
  }
  md.appendMarkdown('\n');

  for (const id of config.segments) {
    const metric = model.metrics.find((m) => m.id === id);
    for (const line of metric?.detail ?? []) {
      md.appendMarkdown(`${escapeMarkdown(line)}\n\n`);
    }
  }

  if (model.model) {
    md.appendMarkdown(`Model: ${escapeMarkdown(model.model)}\n\n`);
  }
  if (model.costUsd !== undefined) {
    md.appendMarkdown(`Session cost: $${model.costUsd.toFixed(2)}\n\n`);
  }
  if (model.cwd) {
    md.appendMarkdown(`Session: \`${model.cwd}\`\n\n`);
  }
  if (model.observedAt !== undefined) {
    md.appendMarkdown(`Updated ${formatDuration((Date.now() - model.observedAt) / 1000)} ago\n\n`);
  }
  if (model.rateLimitsUnavailable) {
    md.appendMarkdown(
      '$(info) Claude Code is not reporting subscription limits. These are only sent for ' +
        'Claude.ai subscription accounts, after the first response of a session.\n\n',
    );
  }
  if (model.stale) {
    md.appendMarkdown('$(info) No Claude Code session has reported recently.\n\n');
  }
  if (!bridgeInstalled) {
    md.appendMarkdown('$(warning) The status line bridge is not installed.\n\n');
  }

  md.appendMarkdown(
    '[Refresh](command:claudeMonitor.refresh) · [Settings](command:claudeMonitor.openSettings)',
  );
  return md;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}
