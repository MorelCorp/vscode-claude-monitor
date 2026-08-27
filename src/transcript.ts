import * as fs from 'fs';
import * as path from 'path';
import { encodeProjectDir, projectsDir } from './paths';

const TAIL_BYTES = 512 * 1024;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const LARGE_CONTEXT_WINDOW = 1_000_000;

export interface TranscriptEstimate {
  usedTokens: number;
  contextWindowSize: number;
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
export function estimateContext(folders: string[]): TranscriptEstimate | undefined {
  let best: TranscriptEstimate | undefined;
  for (const folder of folders) {
    const estimate = estimateForFolder(folder);
    if (estimate && (!best || estimate.observedAt > best.observedAt)) {
      best = estimate;
    }
  }
  return best;
}

function estimateForFolder(folder: string): TranscriptEstimate | undefined {
  const dir = path.join(projectsDir(), encodeProjectDir(path.resolve(folder)));
  const transcript = newestTranscript(dir);
  if (!transcript) {
    return undefined;
  }

  const entry = lastAssistantUsage(transcript.file);
  if (!entry) {
    return undefined;
  }

  const usedTokens =
    (entry.usage.input_tokens ?? 0) +
    (entry.usage.cache_read_input_tokens ?? 0) +
    (entry.usage.cache_creation_input_tokens ?? 0) +
    (entry.usage.output_tokens ?? 0);
  const contextWindowSize = contextWindowFor(entry.model);

  return {
    usedTokens,
    contextWindowSize,
    percent: (usedTokens / contextWindowSize) * 100,
    model: entry.model,
    observedAt: transcript.mtimeMs,
    sessionId: entry.sessionId,
    cwd: folder,
  };
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

interface UsageEntry {
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

export function contextWindowFor(model: string | undefined): number {
  if (model && /\[1m\]|-1m\b|1m-context/i.test(model)) {
    return LARGE_CONTEXT_WINDOW;
  }
  return DEFAULT_CONTEXT_WINDOW;
}
