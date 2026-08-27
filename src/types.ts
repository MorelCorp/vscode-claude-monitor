/** Shape of the JSON that Claude Code pipes into its configured `statusLine` command. */
export interface StatusLinePayload {
  session_id?: string;
  session_name?: string;
  transcript_path?: string;
  cwd?: string;
  version?: string;
  model?: { id?: string; display_name?: string };
  workspace?: {
    current_dir?: string;
    project_dir?: string;
    added_dirs?: string[];
    git_worktree?: string;
  };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
  };
  exceeds_200k_tokens?: boolean;
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  /**
   * Subscription limits. No shipped version of Claude Code has ever put these in the
   * status line payload — the usage endpoint is the real source — but they are read
   * here in case a future version starts sending them.
   */
  rate_limits?: {
    five_hour?: RateLimitWindow;
    seven_day?: RateLimitWindow;
  };
}

export interface RateLimitWindow {
  /** 0-100. */
  used_percentage?: number;
  /** Unix epoch seconds. */
  resets_at?: number;
}

/** A payload plus the time we observed it. */
export interface Snapshot {
  payload: StatusLinePayload;
  /** Epoch milliseconds the snapshot file was last written. */
  observedAt: number;
  file: string;
}

export type MetricId = 'session' | 'week' | 'context';

export type Level = 'normal' | 'warning' | 'critical';

/** Where a meter's number came from, so the tooltip can say. */
export type MetricSource = 'bridge' | 'api' | 'transcript';

/** One rendered meter, ready for the status bar. */
export interface Metric {
  id: MetricId;
  /** Short label, e.g. `Se`. */
  label: string;
  /** 0-100, or undefined when unknown. */
  percent?: number;
  /** Seconds until the window resets, when the metric has one. */
  resetsInSeconds?: number;
  /** Absolute reset time in epoch milliseconds. */
  resetsAt?: number;
  /** Tokens currently occupying the context window. Context metric only. */
  usedTokens?: number;
  /** Size of the context window the tokens are measured against. Context metric only. */
  totalTokens?: number;
  /** Undefined when the metric has no number to attribute. */
  source?: MetricSource;
  level: Level;
  /** Human-readable detail lines for the tooltip. */
  detail: string[];
}

/** Everything the status bar needs for one render. */
export interface UsageModel {
  metrics: Metric[];
  /** Undefined when no session has ever reported. */
  observedAt?: number;
  stale: boolean;
  /** True when the numbers come from the transcript fallback rather than the bridge. */
  estimated: boolean;
  model?: string;
  sessionLabel?: string;
  cwd?: string;
  costUsd?: number;
  /** Outcome of the last usage-endpoint lookup, or undefined when it is turned off. */
  limitsStatus?: 'pending' | 'ok' | 'no-credentials' | 'expired' | 'unauthorized' | 'unavailable';
  /** Set when the account reports no subscription limits at all. */
  rateLimitsUnavailable: boolean;
}
