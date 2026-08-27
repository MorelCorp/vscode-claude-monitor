import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir, encodeProjectDir, projectsDir, userSettingsPath } from './paths';

const TAIL_BYTES = 512 * 1024;
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const LARGE_CONTEXT_WINDOW = 1_000_000;

/** How the context window size was arrived at, for the tooltip to own up to. */
export type WindowSizeSource = 'setting' | 'marker' | 'family' | 'observed' | 'default';

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
 * The window Claude Code gives each model family.
 *
 * Not the same as the window the model supports. Sonnet 5 is a 1M-context model, but
 * Claude Code runs it at 200K unless you pick the 1M variant from the model picker,
 * which carries the `[1m]` marker. Opus is only offered with its 1M window, and
 * Haiku is 200K either way. First match wins, so keep this ordered.
 */
const FAMILY_WINDOWS: { pattern: RegExp; size: number }[] = [
  // Haiku has never had a 1M window in any form.
  { pattern: /haiku/i, size: DEFAULT_CONTEXT_WINDOW },
  // Fable and Mythos default to their maximum.
  { pattern: /(fable|mythos)/i, size: LARGE_CONTEXT_WINDOW },
  // Opus 5 and later ship as "Opus (1M context)" with no 200K variant to pick.
  // Earlier Opus needs the marker, so it deliberately falls through.
  { pattern: /opus-([5-9]|\d\d)/i, size: LARGE_CONTEXT_WINDOW },
  // The bare `opus` alias resolves to the current Opus, hence the same window.
  { pattern: /^opus(\[|$)/i, size: LARGE_CONTEXT_WINDOW },
  // Sonnet without a marker is the 200K variant.
  { pattern: /sonnet/i, size: DEFAULT_CONTEXT_WINDOW },
];

/**
 * Work out how big the context window is when the bridge is not there to say.
 *
 * Transcripts record the API model name with the 1M marker stripped —
 * `claude-opus-5`, never `claude-opus-5[1m]` — so the marker alone cannot answer the
 * question. The model family can: Claude Code's allotment per family is known, and
 * only Sonnet is ambiguous, which is precisely the case the marker covers. A session
 * that has already passed 200K tokens has answered the question by itself, and
 * `claudeMonitor.contextWindowSize` settles it outright.
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
    return { size: LARGE_CONTEXT_WINDOW, source: 'marker' };
  }

  // The model that actually ran the turn beats the one configured, which may have
  // been changed since.
  const family = windowForFamily(model) ?? windowForFamily(configuredModel);
  // A family verdict of 200K that the session has already outgrown is simply wrong.
  const outgrown = family !== undefined && family <= observedTokens;
  if (family !== undefined && !outgrown) {
    return { size: family, source: 'family' };
  }
  if (observedTokens > DEFAULT_CONTEXT_WINDOW) {
    return { size: LARGE_CONTEXT_WINDOW, source: 'observed' };
  }
  return { size: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}

/** The window Claude Code allots this model, or undefined for an unknown family. */
export function windowForFamily(model: string | undefined): number | undefined {
  if (model === undefined) {
    return undefined;
  }
  return FAMILY_WINDOWS.find((entry) => entry.pattern.test(model))?.size;
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
