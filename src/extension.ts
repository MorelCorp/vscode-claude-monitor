import * as fs from 'fs';
import * as vscode from 'vscode';
import * as bridge from './bridge';
import { MonitorConfig, readConfig } from './config';
import { monitorDir, stateDir } from './paths';
import { formatDuration, formatPercent } from './render';
import { readSnapshots } from './stateStore';
import { StatusBar } from './statusBar';
import { Level, MetricId, UsageModel } from './types';
import { buildUsageModel } from './usage';

const CONNECT_PROMPT_KEY = 'claudeMonitor.connectPromptDismissed';

let statusBar: StatusBar | undefined;
let watcher: fs.FSWatcher | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let refreshDebounce: NodeJS.Timeout | undefined;
let config: MonitorConfig;
let lastLevels = new Map<MetricId, Level>();
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Claude Usage Monitor');
  config = readConfig();
  statusBar = new StatusBar();
  context.subscriptions.push(output, statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeMonitor.refresh', () => refresh()),
    vscode.commands.registerCommand('claudeMonitor.showDetails', () => showDetails()),
    vscode.commands.registerCommand('claudeMonitor.installBridge', () => installBridge()),
    vscode.commands.registerCommand('claudeMonitor.uninstallBridge', () => uninstallBridge()),
    vscode.commands.registerCommand('claudeMonitor.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:morelcorp.claude-usage-monitor'),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeMonitor')) {
        config = readConfig();
        restartTimers();
        refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
    new vscode.Disposable(() => stopTimers()),
  );

  startWatching();
  restartTimers();
  refresh();
  void maybePromptToConnect(context);
}

export function deactivate(): void {
  stopTimers();
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

function refresh(): void {
  if (!statusBar) {
    return;
  }
  if (!config.enabled) {
    statusBar.hide();
    return;
  }

  const snapshots = readSnapshots();
  const installed = isBridgeInstalled();

  if (snapshots.length === 0 && !installed) {
    statusBar.renderSetup(config);
    return;
  }

  const model = buildUsageModel(snapshots, {
    folders: workspaceFolders(),
    restrictContextToWorkspace: config.restrictContextToWorkspace,
    warningThreshold: config.warningThreshold,
    criticalThreshold: config.criticalThreshold,
    contextWarningThreshold: config.contextWarningThreshold,
    contextCriticalThreshold: config.contextCriticalThreshold,
    staleAfterMinutes: config.staleAfterMinutes,
    transcriptFallback: config.transcriptFallback,
    now: Date.now(),
  });

  if (config.hideWhenNoData && model.metrics.every((m) => m.percent === undefined)) {
    statusBar.hide();
    return;
  }

  statusBar.render(model, config, installed);
  notifyOnThresholdCrossing(model);
}

function isBridgeInstalled(): boolean {
  try {
    return bridge.status().installed;
  } catch (error) {
    output.appendLine(`Could not read Claude Code settings: ${describe(error)}`);
    return false;
  }
}

/**
 * Warn once per crossing, not once per poll: a meter that sits at 95% for an hour
 * should not produce a notification every five seconds.
 */
function notifyOnThresholdCrossing(model: UsageModel): void {
  if (config.notifications === 'off' || model.stale) {
    return;
  }
  const floor: Level = config.notifications === 'warning' ? 'warning' : 'critical';
  const rank: Record<Level, number> = { normal: 0, warning: 1, critical: 2 };

  for (const metric of model.metrics) {
    if (!config.segments.includes(metric.id)) {
      continue;
    }
    const previous = lastLevels.get(metric.id) ?? 'normal';
    lastLevels.set(metric.id, metric.level);
    if (rank[metric.level] < rank[floor] || rank[metric.level] <= rank[previous]) {
      continue;
    }
    const name =
      metric.id === 'session' ? '5-hour session' : metric.id === 'week' ? '7-day' : 'Context window';
    const resets =
      metric.resetsInSeconds !== undefined
        ? ` Resets in ${formatDuration(metric.resetsInSeconds)}.`
        : '';
    const message = `Claude ${name} usage at ${formatPercent(metric.percent)}.${resets}`;
    const show =
      metric.level === 'critical' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(message, 'Details').then((choice) => {
      if (choice === 'Details') {
        void showDetails();
      }
    });
  }
}

async function showDetails(): Promise<void> {
  const snapshots = readSnapshots();
  const model = buildUsageModel(snapshots, {
    folders: workspaceFolders(),
    restrictContextToWorkspace: config.restrictContextToWorkspace,
    warningThreshold: config.warningThreshold,
    criticalThreshold: config.criticalThreshold,
    contextWarningThreshold: config.contextWarningThreshold,
    contextCriticalThreshold: config.contextCriticalThreshold,
    staleAfterMinutes: config.staleAfterMinutes,
    transcriptFallback: config.transcriptFallback,
    now: Date.now(),
  });

  const titles: Record<MetricId, string> = {
    session: '5-hour session limit',
    week: '7-day weekly limit',
    context: 'Context window',
  };

  const items: vscode.QuickPickItem[] = model.metrics.map((metric) => ({
    label: `${formatPercent(metric.percent)}  ${titles[metric.id]}`,
    description:
      metric.resetsInSeconds !== undefined ? `resets in ${formatDuration(metric.resetsInSeconds)}` : '',
    detail: metric.detail.join('  ·  '),
  }));

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  if (model.observedAt !== undefined) {
    items.push({
      label: '$(clock) Last report',
      description: `${formatDuration((Date.now() - model.observedAt) / 1000)} ago`,
      detail: model.cwd,
    });
  }
  const installed = isBridgeInstalled();
  items.push({
    label: installed ? '$(check) Connected to Claude Code' : '$(plug) Connect to Claude Code',
    description: installed ? 'select to disconnect' : 'select to install the status line bridge',
  });
  items.push({ label: '$(refresh) Refresh' });
  items.push({ label: '$(gear) Settings' });

  const choice = await vscode.window.showQuickPick(items, {
    title: 'Claude Code usage',
    placeHolder: model.estimated
      ? 'Context estimated from the transcript — connect the bridge for live limits'
      : 'Claude Code usage',
  });

  if (!choice) {
    return;
  }
  if (choice.label.includes('Refresh')) {
    refresh();
  } else if (choice.label.includes('Settings')) {
    void vscode.commands.executeCommand('claudeMonitor.openSettings');
  } else if (choice.label.includes('Connect to Claude Code')) {
    await installBridge();
  } else if (choice.label.includes('Connected to Claude Code')) {
    await uninstallBridge();
  }
}

async function installBridge(): Promise<void> {
  const before = bridge.status();
  const detail =
    `This writes a small script to ${before.scriptPath} and points the ` +
    `"statusLine" entry of ${before.settingsPath} at it.\n\n` +
    (before.currentCommand && !before.installed
      ? `Your existing status line command will still run:\n${before.currentCommand}\n\n`
      : '') +
    'Claude Code sends that script your context window size and, for subscription ' +
    'accounts, your 5-hour and 7-day limits. Nothing leaves your machine.';

  const choice = await vscode.window.showInformationMessage(
    'Connect Claude Usage Monitor to Claude Code?',
    { modal: true, detail },
    'Connect',
  );
  if (choice !== 'Connect') {
    return;
  }

  try {
    bridge.install();
    lastLevels = new Map();
    startWatching();
    refresh();
    void vscode.window.showInformationMessage(
      'Connected. Usage appears once a Claude Code session responds — restart any running sessions to pick up the change.',
    );
  } catch (error) {
    output.appendLine(`Install failed: ${describe(error)}`);
    output.show(true);
    void vscode.window.showErrorMessage(`Could not connect to Claude Code: ${describe(error)}`);
  }
}

async function uninstallBridge(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Disconnect Claude Usage Monitor from Claude Code?',
    { modal: true, detail: 'Removes the status line bridge and restores your previous status line command.' },
    'Disconnect',
  );
  if (choice !== 'Disconnect') {
    return;
  }
  try {
    bridge.uninstall();
    refresh();
    void vscode.window.showInformationMessage('Disconnected from Claude Code.');
  } catch (error) {
    output.appendLine(`Uninstall failed: ${describe(error)}`);
    output.show(true);
    void vscode.window.showErrorMessage(`Could not disconnect: ${describe(error)}`);
  }
}

async function maybePromptToConnect(context: vscode.ExtensionContext): Promise<void> {
  if (!config.enabled || !config.promptToConnect) {
    return;
  }
  if (context.globalState.get<boolean>(CONNECT_PROMPT_KEY)) {
    return;
  }
  if (isBridgeInstalled() || readSnapshots().length > 0) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'Claude Usage Monitor can show your context window and subscription limits in the status bar.',
    'Connect',
    'Not now',
    "Don't ask again",
  );
  if (choice === 'Connect') {
    await installBridge();
  } else if (choice === "Don't ask again") {
    await context.globalState.update(CONNECT_PROMPT_KEY, true);
  }
}

/**
 * Watch the snapshot directory. The poll timer in {@link restartTimers} is the
 * safety net: `fs.watch` is unreliable over network and container filesystems, and
 * the countdowns need repainting anyway.
 */
function startWatching(): void {
  watcher?.close();
  watcher = undefined;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    watcher = fs.watch(stateDir(), { persistent: false }, () => {
      if (refreshDebounce) {
        clearTimeout(refreshDebounce);
      }
      refreshDebounce = setTimeout(() => refresh(), 150);
    });
    watcher.on('error', (error) => {
      output.appendLine(`Watch on ${monitorDir()} failed, falling back to polling: ${describe(error)}`);
      watcher?.close();
      watcher = undefined;
    });
  } catch (error) {
    output.appendLine(`Could not watch ${stateDir()}, falling back to polling: ${describe(error)}`);
  }
}

function restartTimers(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  pollTimer = setInterval(() => refresh(), config.pollIntervalSeconds * 1000);
}

function stopTimers(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  if (refreshDebounce) {
    clearTimeout(refreshDebounce);
    refreshDebounce = undefined;
  }
  watcher?.close();
  watcher = undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
