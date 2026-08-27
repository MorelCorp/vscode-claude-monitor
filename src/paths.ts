import * as os from 'os';
import * as path from 'path';

/**
 * Claude Code's config directory. `CLAUDE_CONFIG_DIR` wins when set, matching the CLI.
 */
export function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(untilde(override.trim()));
  }
  return path.join(os.homedir(), '.claude');
}

/** Where this extension keeps the bridge script and its snapshots. */
export function monitorDir(): string {
  return path.join(claudeConfigDir(), 'claude-monitor');
}

export function stateDir(): string {
  return path.join(monitorDir(), 'state');
}

export function bridgeScriptPath(): string {
  return path.join(monitorDir(), 'bridge.sh');
}

/** Holds the statusLine command that was configured before we took over, if any. */
export function chainFilePath(): string {
  return path.join(monitorDir(), 'chain');
}

export function userSettingsPath(): string {
  return path.join(claudeConfigDir(), 'settings.json');
}

export function projectsDir(): string {
  return path.join(claudeConfigDir(), 'projects');
}

/**
 * Claude Code encodes a project's absolute path into a directory name by replacing
 * every non-alphanumeric character with a dash.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** A path usable inside the POSIX shell Claude Code runs statusLine commands in. */
export function toShellPath(p: string): string {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

function untilde(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
