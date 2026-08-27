import * as fs from 'fs';
import * as path from 'path';
import { Snapshot, StatusLinePayload } from './types';
import { stateDir } from './paths';

const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Reads the snapshots the bridge writes, newest first.
 *
 * Snapshots older than a day are deleted on the way past: sessions come and go and
 * nothing prunes the directory otherwise.
 */
export function readSnapshots(now = Date.now()): Snapshot[] {
  const dir = stateDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const snapshots: Snapshot[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) {
      continue;
    }
    const file = path.join(dir, name);
    let observedAt: number;
    try {
      observedAt = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (now - observedAt > MAX_SNAPSHOT_AGE_MS) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Best effort; a snapshot we cannot delete is merely ignored below.
      }
      continue;
    }
    const payload = parseSnapshot(file);
    if (payload) {
      snapshots.push({ payload, observedAt, file });
    }
  }

  return snapshots.sort((a, b) => b.observedAt - a.observedAt);
}

function parseSnapshot(file: string): StatusLinePayload | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim().length === 0) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as StatusLinePayload;
  } catch {
    // A half-written file. The bridge writes atomically, so the next poll gets it.
    return undefined;
  }
}

/** The newest snapshot that actually carries subscription limits. */
export function pickRateLimitSnapshot(snapshots: Snapshot[]): Snapshot | undefined {
  return snapshots.find(
    (s) => s.payload.rate_limits?.five_hour !== undefined || s.payload.rate_limits?.seven_day !== undefined,
  );
}

/**
 * The newest snapshot from a session running inside one of `folders`.
 *
 * Context windows are per-conversation, so showing another window's session would be
 * actively misleading. Falls back to the newest snapshot anywhere when `restrict` is
 * false or nothing matches.
 */
export function pickContextSnapshot(
  snapshots: Snapshot[],
  folders: string[],
  restrict: boolean,
): Snapshot | undefined {
  const withContext = snapshots.filter((s) => s.payload.context_window !== undefined);
  if (folders.length > 0) {
    const local = withContext.find((s) => belongsTo(s.payload, folders));
    if (local) {
      return local;
    }
  }
  return restrict ? undefined : withContext[0];
}

function belongsTo(payload: StatusLinePayload, folders: string[]): boolean {
  const candidates = [
    payload.workspace?.project_dir,
    payload.workspace?.current_dir,
    payload.cwd,
    ...(payload.workspace?.added_dirs ?? []),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);

  return candidates.some((c) => folders.some((f) => isSameOrInside(c, f) || isSameOrInside(f, c)));
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(normalize(parent), normalize(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalize(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
