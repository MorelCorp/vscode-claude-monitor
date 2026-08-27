import { hasWindows, LimitsResult } from './limitsApi';
import { levelFor } from './render';
import { pickContextSnapshot, pickRateLimitSnapshot } from './stateStore';
import { estimateContext, WindowSizeSource } from './transcript';
import { Metric, MetricSource, RateLimitWindow, Snapshot, UsageModel } from './types';

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
  /** 0 means "work it out"; anything else overrides the context window size. */
  contextWindowSize: number;
  /** The newest reading from the usage endpoint, when that source is enabled. */
  limits?: LimitsResult;
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
  let estimate: ReturnType<typeof estimateContext>;

  // The status line payload has never carried rate limits in any shipped version of
  // Claude Code, so the usage endpoint is the real source and the payload is only
  // honoured in case that changes.
  const fromApi = options.limits?.status === 'ok' ? options.limits.limits : undefined;
  metrics.push(
    windowMetric('session', 'Se', '5-hour session', {
      fromBridge: limitSnapshot?.payload.rate_limits?.five_hour,
      fromApi: fromApi?.fiveHour,
      options,
    }),
  );
  metrics.push(
    windowMetric('week', 'Wk', '7-day week', {
      fromBridge: limitSnapshot?.payload.rate_limits?.seven_day,
      fromApi: fromApi?.sevenDay,
      options,
    }),
  );

  const context = contextSnapshot?.payload.context_window;
  if (context && context.used_percentage !== null && context.used_percentage !== undefined) {
    // `total_input_tokens` counts every input token the session has ever sent, so it
    // runs far ahead of the percentage. What occupies the window right now is the
    // current turn's input, which is what `used_percentage` is measured against.
    const used = currentContextTokens(context.current_usage) ?? context.total_input_tokens ?? 0;
    const size = context.context_window_size;
    metrics.push({
      id: 'context',
      label: 'Tk',
      percent: context.used_percentage,
      usedTokens: used,
      totalTokens: size,
      source: 'bridge',
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
    const fallback = options.transcriptFallback
      ? estimateContext(options.folders, options.contextWindowSize)
      : undefined;
    if (fallback) {
      estimated = true;
      estimate = fallback;
      metrics.push({
        id: 'context',
        label: 'Tk',
        percent: fallback.percent,
        usedTokens: fallback.usedTokens,
        totalTokens: fallback.contextWindowSize,
        source: 'transcript',
        level: levelFor(
          fallback.percent,
          options.contextWarningThreshold,
          options.contextCriticalThreshold,
        ),
        detail: [
          `${fallback.usedTokens.toLocaleString()} of ${fallback.contextWindowSize.toLocaleString()} tokens`,
          windowSizeNote(fallback.contextWindowSize, fallback.windowSizeSource),
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
  // Every live source counts towards freshness, not just the bridge: the meters go
  // grey only when nothing at all has reported lately.
  const observedAt = mostRecent(
    newest?.observedAt,
    estimate?.observedAt,
    options.limits?.status === 'ok' ? options.limits.fetchedAt : undefined,
  );
  const stale =
    observedAt === undefined || now - observedAt > options.staleAfterMinutes * 60 * 1000;

  const source = contextSnapshot ?? limitSnapshot ?? newest;

  return {
    metrics,
    observedAt,
    stale,
    estimated,
    model: source?.payload.model?.display_name ?? source?.payload.model?.id ?? estimate?.model,
    sessionLabel: source?.payload.session_name ?? source?.payload.session_id,
    cwd: source?.payload.workspace?.current_dir ?? source?.payload.cwd ?? estimate?.cwd,
    costUsd: source?.payload.cost?.total_cost_usd,
    limitsStatus: options.limits?.status,
    // Rate limits are a subscription feature; API-key accounts have none to report.
    rateLimitsUnavailable:
      options.limits?.status === 'ok' && !hasWindows(options.limits.limits),
  };
}

/** The most recent of however many timestamps are actually known. */
function mostRecent(...times: (number | undefined)[]): number | undefined {
  const known = times.filter((t): t is number => t !== undefined);
  return known.length > 0 ? Math.max(...known) : undefined;
}

function currentContextTokens(
  usage: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null | undefined,
): number | undefined {
  if (!usage) {
    return undefined;
  }
  // Output tokens are left out to match Claude Code: they only occupy the window
  // once they come back as input on the next turn.
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

function windowSizeNote(size: number, source: WindowSizeSource): string {
  const pretty = size.toLocaleString();
  switch (source) {
    case 'setting':
      return `Window size ${pretty}, from claudeMonitor.contextWindowSize.`;
    case 'marker':
      return `Window size ${pretty}, from the model's 1M marker.`;
    case 'family':
      return `Window size ${pretty}, the window Claude Code gives this model.`;
    case 'observed':
      return `Window size ${pretty}, inferred from a session that already exceeded 200,000 tokens.`;
    default:
      return `Window size assumed to be ${pretty}: unrecognised model. Set claudeMonitor.contextWindowSize if that is wrong.`;
  }
}

interface WindowSources {
  fromBridge: RateLimitWindow | undefined;
  fromApi: { usedPercent: number; resetsAt?: number } | undefined;
  options: BuildOptions;
}

function windowMetric(
  id: 'session' | 'week',
  label: string,
  title: string,
  { fromBridge, fromApi, options }: WindowSources,
): Metric {
  let percent: number | undefined;
  let resetsAt: number | undefined;
  let source: MetricSource | undefined;

  if (fromBridge?.used_percentage !== undefined) {
    percent = fromBridge.used_percentage;
    resetsAt = fromBridge.resets_at !== undefined ? fromBridge.resets_at * 1000 : undefined;
    source = 'bridge';
  } else if (fromApi) {
    percent = fromApi.usedPercent;
    resetsAt = fromApi.resetsAt;
    source = 'api';
  }

  if (percent === undefined) {
    return {
      id,
      label,
      level: 'normal',
      detail: [`${title}: ${explainMissing(options.limits)}`],
    };
  }

  return {
    id,
    label,
    percent,
    resetsAt,
    resetsInSeconds: resetsAt !== undefined ? (resetsAt - options.now) / 1000 : undefined,
    source,
    level: levelFor(percent, options.warningThreshold, options.criticalThreshold),
    detail: [`${title} limit`],
  };
}

/** Say why a meter is blank, since "no data" on its own sends nobody anywhere. */
function explainMissing(limits: LimitsResult | undefined): string {
  switch (limits?.status) {
    case undefined:
      return 'limit lookups are turned off (claudeMonitor.rateLimits.source).';
    case 'pending':
      return 'reading your account limits…';
    case 'ok':
      return 'no limit reported for this account. Subscription plans only.';
    case 'no-credentials':
      return 'no Claude Code login found on this machine. Run `claude` and sign in.';
    case 'expired':
      return 'the stored Claude Code login has expired. Run `claude` once to refresh it.';
    case 'unauthorized':
      return 'the stored Claude Code login was rejected. Run `claude` once to refresh it.';
    case 'unavailable':
      return `could not reach the usage endpoint (${limits.message}).`;
  }
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
