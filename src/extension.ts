import * as fs from 'fs';
import * as vscode from 'vscode';
import * as bridge from './bridge';
import { MonitorConfig, readConfig } from './config';
import { keychainService, LimitsPoller, readCredential } from './limitsApi';
import { claudeConfigDir, monitorDir, stateDir } from './paths';
import { formatDuration, formatPercent } from './render';
import { readSnapshots } from './stateStore';
import { StatusBar } from './statusBar';
import { readConfiguredModel, resolveContextWindow } from './transcript';
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
let limits: LimitsPoller;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Claude Usage Monitor');
  config = readConfig();
  statusBar = new StatusBar();
  limits = new LimitsPoller(() => refresh());
  context.subscriptions.push(output, statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeMonitor.refresh', () => {
      void limits.refresh();
      refresh();
    }),
    vscode.commands.registerCommand('claudeMonitor.showDiagnostics', () => void showDiagnostics()),
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

/** Assemble the current reading from every source the settings allow. */
function currentUsage(): UsageModel {
  return buildUsageModel(readSnapshots(), {
    folders: workspaceFolders(),
    restrictContextToWorkspace: config.restrictContextToWorkspace,
    warningThreshold: config.warningThreshold,
    criticalThreshold: config.criticalThreshold,
    contextWarningThreshold: config.contextWarningThreshold,
    contextCriticalThreshold: config.contextCriticalThreshold,
    staleAfterMinutes: config.staleAfterMinutes,
    transcriptFallback: config.transcriptFallback,
    contextWindowSize: config.contextWindowSize,
    // `pending` rather than `undefined`, so the very first paint does not claim the
    // lookup is switched off.
    limits: apiLimitsEnabled() ? (limits.current() ?? { status: 'pending' }) : undefined,
    now: Date.now(),
  });
}

function apiLimitsEnabled(): boolean {
  return config.rateLimitsSource === 'auto' || config.rateLimitsSource === 'api';
}

function refresh(): void {
  if (!statusBar) {
    return;
  }
  if (!config.enabled) {
    statusBar.hide();
    return;
  }

  const model = currentUsage();
  const installed = isBridgeInstalled();
  const nothingKnown = model.metrics.every((m) => m.percent === undefined);

  // The bridge is only one of the sources now, so the setup prompt is reserved for
  // the case where nothing at all has a number to show.
  if (nothingKnown && !installed) {
    statusBar.renderSetup(config);
    return;
  }
  if (config.hideWhenNoData && nothingKnown) {
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
  const model = currentUsage();

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
  items.push({ label: '$(pulse) Diagnostics' });
  items.push({ label: '$(gear) Settings' });

  const choice = await vscode.window.showQuickPick(items, {
    title: 'Claude Code usage',
    placeHolder: model.estimated
      ? 'Context estimated from the transcript — connect the bridge for the exact window'
      : 'Claude Code usage',
  });

  if (!choice) {
    return;
  }
  if (choice.label.includes('Refresh')) {
    void limits.refresh();
    refresh();
  } else if (choice.label.includes('Diagnostics')) {
    await showDiagnostics();
  } else if (choice.label.includes('Settings')) {
    void vscode.commands.executeCommand('claudeMonitor.openSettings');
  } else if (choice.label.includes('Connect to Claude Code')) {
    await installBridge();
  } else if (choice.label.includes('Connected to Claude Code')) {
    await uninstallBridge();
  }
}

/**
 * Dump every source's state to the output channel.
 *
 * Blank meters have several possible causes — no bridge, a bridge no running session
 * has picked up yet, no login on this machine, a non-subscription account — and they
 * all look identical in the status bar.
 */
async function showDiagnostics(): Promise<void> {
  const lines: string[] = [];
  const now = Date.now();
  const folders = workspaceFolders();

  lines.push(`Claude Usage Monitor diagnostics — ${new Date(now).toISOString()}`);
  lines.push(`Config directory: ${claudeConfigDir()}`);
  lines.push('');

  lines.push('Status line bridge');
  try {
    const status = bridge.status();
    lines.push(`  installed: ${status.installed}`);
    lines.push(`  script: ${status.scriptPath}`);
    lines.push(`  settings: ${status.settingsPath}`);
    lines.push(`  statusLine command: ${status.currentCommand ?? '(none)'}`);
  } catch (error) {
    lines.push(`  could not read Claude Code settings: ${describe(error)}`);
  }
  const snapshots = readSnapshots();
  lines.push(`  snapshots: ${snapshots.length} in ${stateDir()}`);
  for (const snapshot of snapshots.slice(0, 5)) {
    const age = formatDuration((now - snapshot.observedAt) / 1000);
    const where = snapshot.payload.workspace?.current_dir ?? snapshot.payload.cwd ?? '?';
    lines.push(`    ${age} ago · ${where}`);
  }
  if (snapshots.length === 0) {
    lines.push('    None. Claude Code only runs the status line command in the terminal UI,');
    lines.push('    and only for sessions started after the bridge was installed.');
  }
  lines.push('');

  lines.push('Context window');
  const configured = readConfiguredModel(folders);
  const resolved = resolveContextWindow(configured, config.contextWindowSize, 0, configured);
  lines.push(`  claudeMonitor.contextWindowSize: ${config.contextWindowSize || 'auto'}`);
  lines.push(`  configured model: ${configured ?? '(not set — Claude Code decides)'}`);
  lines.push(`  size without the bridge: ${resolved.size.toLocaleString()} (${resolved.source})`);
  lines.push('');

  lines.push('Subscription limits');
  lines.push(`  claudeMonitor.rateLimits.source: ${config.rateLimitsSource}`);
  const credential = readCredential();
  lines.push(
    credential
      ? `  login found via ${credential.source}${credential.source === 'keychain' ? ` ("${keychainService()}")` : ''}`
      : '  no Claude Code login found on this machine',
  );
  if (credential?.expiresAt !== undefined) {
    lines.push(`  token expires: ${new Date(credential.expiresAt).toISOString()}`);
  }
  if (credential?.subscriptionType) {
    lines.push(`  subscription: ${credential.subscriptionType}`);
  }
  const reading = apiLimitsEnabled() ? await limits.refresh() : undefined;
  if (!apiLimitsEnabled()) {
    lines.push('  usage endpoint: disabled by settings');
  } else if (!reading) {
    lines.push('  usage endpoint: not read yet');
  } else if (reading.status === 'ok') {
    lines.push(`  usage endpoint: ok (${reading.source}), read ${new Date(reading.fetchedAt).toISOString()}`);
    for (const [name, window] of Object.entries(reading.limits)) {
      if (window) {
        const resets = window.resetsAt ? new Date(window.resetsAt).toISOString() : 'unknown';
        lines.push(`    ${name}: ${window.usedPercent.toFixed(1)}% used, resets ${resets}`);
      }
    }
  } else {
    lines.push(`  usage endpoint: ${reading.status}${'message' in reading ? ` — ${reading.message}` : ''}`);
  }

  output.appendLine(lines.join('\n'));
  output.appendLine('');
  output.show(true);
}

async function installBridge(): Promise<void> {
  const before = bridge.status();
  const detail =
    `This writes a small script to ${before.scriptPath} and points the ` +
    `"statusLine" entry of ${before.settingsPath} at it.\n\n` +
    (before.currentCommand && !before.installed
      ? `Your existing status line command will still run:\n${before.currentCommand}\n\n`
      : '') +
    'Terminal Claude Code sessions then send that script the exact size and fill of ' +
    'their context window, which is more accurate than reading the transcript. ' +
    'Nothing leaves your machine.\n\n' +
    'The 5-hour and 7-day meters do not come from here — the status line payload has ' +
    'never carried rate limits — so they work with or without this.';

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
      'Connected. The exact context window appears once a terminal Claude Code session responds — restart any running sessions to pick up the change.',
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
    'Claude Usage Monitor can read the exact context window from Claude Code. Connect the status line bridge?',
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

  limits.stop();
  if (config.enabled && apiLimitsEnabled()) {
    limits.start(config.rateLimitsRefreshSeconds * 1000);
  } else {
    limits.reset();
  }
}

function stopTimers(): void {
  limits?.stop();
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
