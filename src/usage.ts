import { levelFor } from './render';
import { pickContextSnapshot, pickRateLimitSnapshot } from './stateStore';
import { estimateContext } from './transcript';
import { Metric, RateLimitWindow, Snapshot, UsageModel } from './types';

export interface BuildOptions {
  folders: string[];
  /** Only follow sessions from this workspace for the context meter. */
  restrictContextToWorkspace: boolean;
  warningThreshold: number;
  criticalThreshold: number;
  contextWarningThreshold: number;
  contextCriticalThreshold: number;
  staleAfterMinutes: number;
  transcriptFallback: boolean;
  now: number;
}

/** Turn the raw snapshots on disk into everything the status bar renders. */
export function buildUsageModel(snapshots: Snapshot[], options: BuildOptions): UsageModel {
  const { now } = options;
  const limitSnapshot = pickRateLimitSnapshot(snapshots);
  const contextSnapshot = pickContextSnapshot(
    snapshots,
    options.folders,
    options.restrictContextToWorkspace,
  );

  const metrics: Metric[] = [];
  let estimated = false;

  metrics.push(
    windowMetric(
      'session',
      'Se',
      '5-hour session',
      limitSnapshot?.payload.rate_limits?.five_hour,
      options,
    ),
  );
  metrics.push(
    windowMetric('week', 'Wk', '7-day week', limitSnapshot?.payload.rate_limits?.seven_day, options),
  );

  const context = contextSnapshot?.payload.context_window;
  if (context && context.used_percentage !== null && context.used_percentage !== undefined) {
    const used = context.total_input_tokens ?? 0;
    const size = context.context_window_size;
    metrics.push({
      id: 'context',
      label: 'Tk',
      percent: context.used_percentage,
      usedTokens: used,
      totalTokens: size,
      level: levelFor(
        context.used_percentage,
        options.contextWarningThreshold,
        options.contextCriticalThreshold,
      ),
      detail: [
        size
          ? `${used.toLocaleString()} of ${size.toLocaleString()} tokens`
          : `${used.toLocaleString()} tokens`,
        ...cacheBreakdown(context.current_usage),
      ],
    });
  } else {
    const fallback = options.transcriptFallback ? estimateContext(options.folders) : undefined;
    if (fallback) {
      estimated = true;
      metrics.push({
        id: 'context',
        label: 'Tk',
        percent: fallback.percent,
        usedTokens: fallback.usedTokens,
        totalTokens: fallback.contextWindowSize,
        level: levelFor(
          fallback.percent,
          options.contextWarningThreshold,
          options.contextCriticalThreshold,
        ),
        detail: [
          `${fallback.usedTokens.toLocaleString()} of ${fallback.contextWindowSize.toLocaleString()} tokens`,
          'Estimated from the session transcript.',
        ],
      });
    } else {
      metrics.push({
        id: 'context',
        label: 'Tk',
        level: 'normal',
        detail: ['No active Claude Code conversation in this workspace.'],
      });
    }
  }

  const newest = snapshots[0];
  const observedAt = newest?.observedAt;
  const stale =
    observedAt === undefined || now - observedAt > options.staleAfterMinutes * 60 * 1000;

  const source = contextSnapshot ?? limitSnapshot ?? newest;

  return {
    metrics,
    observedAt,
    stale,
    estimated,
    model: source?.payload.model?.display_name ?? source?.payload.model?.id,
    sessionLabel: source?.payload.session_name ?? source?.payload.session_id,
    cwd: source?.payload.workspace?.current_dir ?? source?.payload.cwd,
    costUsd: source?.payload.cost?.total_cost_usd,
    // Claude Code omits rate_limits entirely for API-key and non-subscription accounts.
    rateLimitsUnavailable: snapshots.length > 0 && limitSnapshot === undefined,
  };
}

function windowMetric(
  id: 'session' | 'week',
  label: string,
  title: string,
  window: RateLimitWindow | undefined,
  options: BuildOptions,
): Metric {
  if (!window || window.used_percentage === undefined) {
    return {
      id,
      label,
      level: 'normal',
      detail: [`${title}: no data reported yet.`],
    };
  }
  const resetsAt = window.resets_at !== undefined ? window.resets_at * 1000 : undefined;
  return {
    id,
    label,
    percent: window.used_percentage,
    resetsAt,
    resetsInSeconds: resetsAt !== undefined ? (resetsAt - options.now) / 1000 : undefined,
    level: levelFor(window.used_percentage, options.warningThreshold, options.criticalThreshold),
    detail: [`${title} limit`],
  };
}

function cacheBreakdown(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | null
    | undefined,
): string[] {
  if (!usage) {
    return [];
  }
  const parts: string[] = [];
  if (usage.input_tokens) {
    parts.push(`${usage.input_tokens.toLocaleString()} input`);
  }
  if (usage.cache_read_input_tokens) {
    parts.push(`${usage.cache_read_input_tokens.toLocaleString()} cache read`);
  }
  if (usage.cache_creation_input_tokens) {
    parts.push(`${usage.cache_creation_input_tokens.toLocaleString()} cache write`);
  }
  if (usage.output_tokens) {
    parts.push(`${usage.output_tokens.toLocaleString()} output`);
  }
  return parts.length > 0 ? [parts.join(' · ')] : [];
}
