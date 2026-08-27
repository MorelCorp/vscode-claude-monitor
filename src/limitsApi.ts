import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { claudeConfigDir } from './paths';

/**
 * Reads the 5-hour and 7-day subscription limits.
 *
 * Claude Code's status line payload does not carry rate limits — only the context
 * window — so the meters have to come from the same place Claude Code's own
 * `/usage` view gets them: the OAuth usage endpoint, called with the token Claude
 * Code already stored when you logged in. Nothing new is granted and nothing is
 * written; this is a read of your own account, and `claudeMonitor.rateLimits.source`
 * turns it off.
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_MS = 8000;

export interface LimitWindow {
  /** 0-100. */
  usedPercent: number;
  /** Epoch milliseconds. */
  resetsAt?: number;
}

export interface Limits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  sevenDayOpus?: LimitWindow;
  sevenDaySonnet?: LimitWindow;
}

export type CredentialSource = 'env' | 'keychain' | 'file';

export interface Credential {
  accessToken: string;
  /** Epoch milliseconds, when the store records one. */
  expiresAt?: number;
  subscriptionType?: string;
  source: CredentialSource;
}

export type LimitsResult =
  /** Enabled, but the first read has not come back yet. */
  | { status: 'pending' }
  | { status: 'ok'; limits: Limits; fetchedAt: number; source: CredentialSource }
  | { status: 'no-credentials' }
  | { status: 'expired' }
  | { status: 'unauthorized' }
  | { status: 'unavailable'; message: string };

/** True when the result carries limits we could actually plot. */
export function hasWindows(limits: Limits): boolean {
  return limits.fiveHour !== undefined || limits.sevenDay !== undefined;
}

/**
 * Where Claude Code keeps the OAuth token, in the order it looks itself: the
 * environment override first, then the platform store (Keychain on macOS, a
 * mode-0600 file everywhere else).
 */
export function readCredential(): Credential | undefined {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (fromEnv && fromEnv.trim().length > 0) {
    return { accessToken: fromEnv.trim(), source: 'env' };
  }
  const stores = process.platform === 'darwin' ? [fromKeychain, fromFile] : [fromFile, fromKeychain];
  for (const store of stores) {
    const credential = store();
    if (credential) {
      return credential;
    }
  }
  return undefined;
}

/**
 * Keychain item name, mirroring the CLI: a config directory override gets its own
 * item, keyed by the first 8 hex digits of the directory's SHA-256.
 */
export function keychainService(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (!override || override.trim().length === 0) {
    return 'Claude Code-credentials';
  }
  const digest = createHash('sha256').update(claudeConfigDir()).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${digest}`;
}

function keychainAccount(): string {
  try {
    return process.env.USER || os.userInfo().username;
  } catch {
    return 'claude-code-user';
  }
}

function fromKeychain(): Credential | undefined {
  if (process.platform !== 'darwin') {
    return undefined;
  }
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-a', keychainAccount(), '-w', '-s', keychainService()],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return parseCredential(raw, 'keychain');
  } catch {
    // No item, or the user declined the access prompt. Either way there is nothing
    // to read and the meters fall back to reporting that.
    return undefined;
  }
}

function fromFile(): Credential | undefined {
  try {
    const file = path.join(claudeConfigDir(), '.credentials.json');
    return parseCredential(fs.readFileSync(file, 'utf8'), 'file');
  } catch {
    return undefined;
  }
}

export function parseCredential(raw: string, source: CredentialSource): Credential | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const oauth = parsed?.claudeAiOauth;
  if (typeof oauth?.accessToken !== 'string' || oauth.accessToken.length === 0) {
    return undefined;
  }
  return {
    accessToken: oauth.accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
    source,
  };
}

/**
 * Turn the usage endpoint's body into windows we can plot.
 *
 * Percentages arrive as `utilization` on a 0-100 scale and reset times as ISO
 * strings, but both have moved before; numbers that look like epoch seconds or
 * milliseconds are accepted too rather than dropping the whole reading.
 */
export function parseUsage(body: unknown): Limits {
  if (typeof body !== 'object' || body === null) {
    return {};
  }
  const raw = body as Record<string, unknown>;
  return {
    fiveHour: parseWindow(raw.five_hour),
    sevenDay: parseWindow(raw.seven_day),
    sevenDayOpus: parseWindow(raw.seven_day_opus),
    sevenDaySonnet: parseWindow(raw.seven_day_sonnet),
  };
}

function parseWindow(value: unknown): LimitWindow | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const utilization = raw.utilization;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) {
    return undefined;
  }
  return {
    usedPercent: Math.max(0, Math.min(100, utilization)),
    resetsAt: parseResetsAt(raw.resets_at),
  };
}

function parseResetsAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds until roughly the year 2286, milliseconds after that.
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** GET the usage endpoint. Never throws: every failure comes back as a status. */
export async function fetchLimits(now = Date.now()): Promise<LimitsResult> {
  const credential = readCredential();
  if (!credential) {
    return { status: 'no-credentials' };
  }
  // Claude Code refreshes its own token; we only read, so an expired one is
  // reported rather than renewed behind the user's back.
  if (credential.expiresAt !== undefined && credential.expiresAt <= now) {
    return { status: 'expired' };
  }

  try {
    const response = await get(USAGE_URL, credential.accessToken);
    if (response.status === 401 || response.status === 403) {
      return { status: 'unauthorized' };
    }
    if (response.status !== 200) {
      return { status: 'unavailable', message: `usage endpoint returned HTTP ${response.status}` };
    }
    return {
      status: 'ok',
      limits: parseUsage(JSON.parse(response.body)),
      fetchedAt: Date.now(),
      source: credential.source,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function get(url: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('usage request timed out')));
    request.on('error', reject);
    request.end();
  });
}

/**
 * Keeps the newest reading on hand and refreshes it in the background.
 *
 * The endpoint is polled far more slowly than the status bar repaints; limits move
 * over minutes, and the token may live behind a Keychain read.
 */
export class LimitsPoller {
  private result: LimitsResult | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private intervalMs = 60_000;

  constructor(private readonly onUpdate: () => void) {}

  current(): LimitsResult | undefined {
    return this.result;
  }

  start(intervalMs: number): void {
    this.stop();
    this.intervalMs = intervalMs;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Drop the cached reading so the next start re-reads credentials from scratch. */
  reset(): void {
    this.result = undefined;
  }

  async refresh(): Promise<LimitsResult | undefined> {
    if (this.inFlight) {
      return this.result;
    }
    this.inFlight = true;
    try {
      const next = await fetchLimits();
      const changed = JSON.stringify(next) !== JSON.stringify(this.result);
      this.result = next;
      if (changed) {
        this.onUpdate();
      }
    } finally {
      this.inFlight = false;
    }
    return this.result;
  }
}
