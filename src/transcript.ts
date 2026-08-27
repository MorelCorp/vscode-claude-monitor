import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir, encodeProjectDir, projectsDir, userSettingsPath } from './paths';

const TAIL_BYTES = 512 * 1024;
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const LARGE_CONTEXT_WINDOW = 1_000_000;

/** How the context window size was arrived at, for the tooltip to own up to. */
export type WindowSizeSource = 'setting' | 'model' | 'observed' | 'default';

export interface TranscriptEstimate {
  usedTokens: number;
  contextWindowSize: number;
  windowSizeSource: WindowSizeSource;
  percent: number;
  model?: string;
  observedAt: number;
  sessionId?: string;
  cwd: string;
}

/**
 * Estimate the context window from Claude Code's own transcript.
 *
 * Used only until the bridge reports for the first time. Rate limits are not in the
 * transcript at all, so this covers the context meter and nothing else.
 */
export function estimateContext(
  folders: string[],
  windowSizeOverride = 0,
): TranscriptEstimate | undefined {
  let best: TranscriptEstimate | undefined;
  for (const folder of folders) {
    const estimate = estimateForFolder(folder, windowSizeOverride);
    if (estimate && (!best || estimate.observedAt > best.observedAt)) {
      best = estimate;
    }
  }
  return best;
}

function estimateForFolder(folder: string, windowSizeOverride: number): TranscriptEstimate | undefined {
  const dir = path.join(projectsDir(), encodeProjectDir(path.resolve(folder)));
  const transcript = newestTranscript(dir);
  if (!transcript) {
    return undefined;
  }

  const entry = lastAssistantUsage(transcript.file);
  if (!entry) {
    return undefined;
  }

  const usedTokens = contextTokens(entry.usage);
  const window = resolveContextWindow(
    entry.model,
    windowSizeOverride,
    usedTokens,
    readConfiguredModel([folder]),
  );

  return {
    usedTokens,
    contextWindowSize: window.size,
    windowSizeSource: window.source,
    percent: (usedTokens / window.size) * 100,
    model: entry.model,
    observedAt: transcript.mtimeMs,
    sessionId: entry.sessionId,
    cwd: folder,
  };
}

/**
 * What the next request will have to carry, which is what "context used" means.
 *
 * Output tokens are excluded to match Claude Code's own reading: they are billed
 * against the turn that produced them, and only reappear here once they are part of
 * the prompt on the following turn.
 */
export function contextTokens(usage: UsageEntry['usage']): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function newestTranscript(dir: string): { file: string; mtimeMs: number } | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { file: string; mtimeMs: number } | undefined;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      const { mtimeMs } = fs.statSync(file);
      if (!best || mtimeMs > best.mtimeMs) {
        best = { file, mtimeMs };
      }
    } catch {
      continue;
    }
  }
  return best;
}

export interface UsageEntry {
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model?: string;
  sessionId?: string;
}

/**
 * Walk the tail of a JSONL transcript backwards for the most recent assistant turn.
 *
 * Transcripts run to tens of megabytes, so only the tail is read; the first line of
 * the slice is dropped because it is almost certainly cut in half.
 */
function lastAssistantUsage(file: string): UsageEntry | undefined {
  let text: string;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) {
      return undefined;
    }
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    text = buffer.toString('utf8');
    if (start > 0) {
      text = text.slice(text.indexOf('\n') + 1);
    }
  } catch {
    return undefined;
  }

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0 || !line.startsWith('{')) {
      continue;
    }
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== 'assistant' || record?.isSidechain === true) {
      continue;
    }
    const usage = record?.message?.usage;
    if (!usage || typeof usage !== 'object') {
      continue;
    }
    return { usage, model: record?.message?.model, sessionId: record?.sessionId };
  }
  return undefined;
}

/**
 * Work out how big the context window is when the bridge is not there to say.
 *
 * Transcripts record the API model name with the 1M marker stripped —
 * `claude-opus-5`, never `claude-opus-5[1m]` — so a 1M session is indistinguishable
 * from a 200K one on the transcript alone. The configured model is checked for the
 * marker, and a session that has already passed 200K tokens has answered the
 * question by itself. `claudeMonitor.contextWindowSize` settles it outright.
 */
export function resolveContextWindow(
  model: string | undefined,
  override: number,
  observedTokens = 0,
  configuredModel = readConfiguredModel(),
): { size: number; source: WindowSizeSource } {
  if (override > 0) {
    return { size: override, source: 'setting' };
  }
  if (isLargeContextModel(model) || isLargeContextModel(configuredModel)) {
    return { size: LARGE_CONTEXT_WINDOW, source: 'model' };
  }
  if (observedTokens > DEFAULT_CONTEXT_WINDOW) {
    return { size: LARGE_CONTEXT_WINDOW, source: 'observed' };
  }
  return { size: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}

export function isLargeContextModel(model: string | undefined): boolean {
  return model !== undefined && /\[1m\]|-1m\b|1m-context/i.test(model);
}

/**
 * The model Claude Code was told to use, from the env override or its settings
 * files. Only the 1M marker is of interest, and only when the bridge is absent.
 */
export function readConfiguredModel(folders: string[] = []): string | undefined {
  const fromEnv = process.env.ANTHROPIC_MODEL ?? process.env.CLAUDE_CODE_MODEL;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const files = [
    ...folders.map((f) => path.join(f, '.claude', 'settings.local.json')),
    ...folders.map((f) => path.join(f, '.claude', 'settings.json')),
    userSettingsPath(),
    path.join(claudeConfigDir(), 'settings.local.json'),
  ];
  for (const file of files) {
    const model = modelFromSettings(file);
    if (model) {
      return model;
    }
  }
  return undefined;
}

function modelFromSettings(file: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const model = parsed?.model;
    return typeof model === 'string' && model.length > 0 ? model : undefined;
  } catch {
    return undefined;
  }
}
