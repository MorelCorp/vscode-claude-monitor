import * as fs from 'fs';
import * as path from 'path';
import {
  bridgeScriptPath,
  chainFilePath,
  monitorDir,
  stateDir,
  toShellPath,
  userSettingsPath,
} from './paths';

export interface BridgeStatus {
  installed: boolean;
  /** The statusLine command currently configured in Claude Code's settings, if any. */
  currentCommand?: string;
  /** The command we will delegate to (the one that was there before we took over). */
  chainedCommand?: string;
  settingsPath: string;
  scriptPath: string;
}

/**
 * The `statusLine` command we install into Claude Code.
 *
 * Claude Code runs statusLine commands through a POSIX shell (Git Bash on Windows),
 * so a single `sh` script covers every platform. It must be cheap: Claude Code runs
 * it on every status line repaint.
 */
function bridgeScript(dir: string): string {
  const shellDir = toShellPath(dir);
  return `#!/bin/sh
# Claude usage bridge - installed by the "Claude Usage Monitor" VS Code extension.
#
# Claude Code pipes its status line JSON into this script. We snapshot that JSON so
# the extension can read it, then hand stdin to whatever status line command was
# configured before, so the terminal status line keeps working unchanged.
#
# Safe to delete: run "Claude Monitor: Disconnect from Claude Code" in VS Code to
# also clean up the settings entry that points here.

set -u

DIR="${shellDir}"
STATE_DIR="$DIR/state"
CHAIN_FILE="$DIR/chain"

input=$(cat)

mkdir -p "$STATE_DIR" 2>/dev/null || true

sid=$(printf '%s' "$input" | grep -o '"session_id":"[^"]*"' | head -n 1 | cut -d'"' -f4)
case "$sid" in
  '' | *[!A-Za-z0-9._-]*) sid="unknown" ;;
esac

tmp="$STATE_DIR/.$sid.$$.tmp"
if printf '%s' "$input" > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$STATE_DIR/$sid.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null
fi

if [ -s "$CHAIN_FILE" ]; then
  printf '%s' "$input" | sh -c "$(cat "$CHAIN_FILE")"
  exit $?
fi

# Nothing to delegate to: print a minimal line so the terminal status line is not blank.
dir_name=$(printf '%s' "$input" | grep -o '"current_dir":"[^"]*"' | head -n 1 | cut -d'"' -f4)
model=$(printf '%s' "$input" | grep -o '"display_name":"[^"]*"' | head -n 1 | cut -d'"' -f4)
ctx=$(printf '%s' "$input" | grep -o '"used_percentage":[0-9.]*' | head -n 1 | cut -d: -f2)

line=$(basename "\${dir_name:-.}")
if [ -n "$model" ]; then line="$line | $model"; fi
if [ -n "$ctx" ]; then
  ctx=$(printf '%s' "$ctx" | cut -d. -f1)
  line="$line | ctx $ctx%"
fi
printf '%s' "$line"
`;
}

interface ClaudeSettings {
  statusLine?: { type?: string; command?: string; padding?: number };
  [key: string]: unknown;
}

function readSettings(file: string): ClaudeSettings {
  if (!fs.existsSync(file)) {
    return {};
  }
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw.length === 0) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object.`);
  }
  return parsed as ClaudeSettings;
}

function writeSettings(file: string, settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, `${file}.claude-monitor-backup-${stamp}`);
  }
  const tmp = `${file}.claude-monitor.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function status(): BridgeStatus {
  const settingsPath = userSettingsPath();
  const scriptPath = bridgeScriptPath();
  let currentCommand: string | undefined;
  try {
    currentCommand = readSettings(settingsPath).statusLine?.command;
  } catch {
    currentCommand = undefined;
  }
  let chainedCommand: string | undefined;
  try {
    const chain = fs.readFileSync(chainFilePath(), 'utf8').trim();
    chainedCommand = chain.length > 0 ? chain : undefined;
  } catch {
    chainedCommand = undefined;
  }
  return {
    installed: pointsAtBridge(currentCommand, scriptPath) && fs.existsSync(scriptPath),
    currentCommand,
    chainedCommand,
    settingsPath,
    scriptPath,
  };
}

function pointsAtBridge(command: string | undefined, scriptPath: string): boolean {
  if (!command) {
    return false;
  }
  return command.includes(toShellPath(scriptPath)) || command.includes(scriptPath);
}

/**
 * Write the bridge script and point Claude Code's `statusLine` at it, preserving any
 * command that was already configured so it still runs.
 */
export function install(): BridgeStatus {
  const dir = monitorDir();
  fs.mkdirSync(stateDir(), { recursive: true });

  const scriptPath = bridgeScriptPath();
  fs.writeFileSync(scriptPath, bridgeScript(dir), { mode: 0o755 });
  // writeFileSync only applies `mode` when creating the file, so set it explicitly.
  fs.chmodSync(scriptPath, 0o755);

  const settingsPath = userSettingsPath();
  const settings = readSettings(settingsPath);
  const existing = settings.statusLine;
  const existingCommand = existing?.command;

  if (existingCommand && !pointsAtBridge(existingCommand, scriptPath)) {
    fs.writeFileSync(chainFilePath(), `${existingCommand}\n`, 'utf8');
  }

  settings.statusLine = {
    type: 'command',
    command: `sh ${quoteForShell(toShellPath(scriptPath))}`,
    ...(existing?.padding !== undefined ? { padding: existing.padding } : {}),
  };
  writeSettings(settingsPath, settings);

  return status();
}

/** Undo {@link install}, restoring the previously configured statusLine command. */
export function uninstall(): void {
  const settingsPath = userSettingsPath();
  const scriptPath = bridgeScriptPath();
  const settings = readSettings(settingsPath);

  if (pointsAtBridge(settings.statusLine?.command, scriptPath)) {
    let chained: string | undefined;
    try {
      const raw = fs.readFileSync(chainFilePath(), 'utf8').trim();
      chained = raw.length > 0 ? raw : undefined;
    } catch {
      chained = undefined;
    }
    if (chained) {
      settings.statusLine = {
        type: 'command',
        command: chained,
        ...(settings.statusLine?.padding !== undefined ? { padding: settings.statusLine.padding } : {}),
      };
    } else {
      delete settings.statusLine;
    }
    writeSettings(settingsPath, settings);
  }

  rmQuietly(chainFilePath());
  rmQuietly(scriptPath);
}

function rmQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Nothing we can do, and nothing the user needs to hear about.
  }
}

/** Single-quote a path for `sh`, escaping any embedded single quotes. */
export function quoteForShell(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
