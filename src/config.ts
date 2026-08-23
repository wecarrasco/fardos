import 'dotenv/config';

/** All tunables live here so the target account and refresh cadence are one-line changes. */
export const config = {
  /** Linktree username to scrape. Change this to point the app at a different seller. */
  linktreeUsername: process.env.LINKTREE_USERNAME ?? 'ChelitoSAF',

  /**
   * Hours after which the UI marks the index stale. Content only updates when
   * someone presses "Update now", so this is a nudge rather than an alarm.
   */
  staleAfterHours: Number(process.env.STALE_AFTER_HOURS ?? 24),

  /** Politeness: milliseconds to wait between consecutive deck-page fetches. */
  fetchDelayMs: Number(process.env.FETCH_DELAY_MS ?? 1200),

  /** Per-request timeout and retry budget. */
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS ?? 20_000),
  fetchRetries: Number(process.env.FETCH_RETRIES ?? 2),

  /**
   * Optional shared secret for POST /api/refresh. Leave unset for local use.
   * Set it on any public deployment, otherwise a stranger can make your server
   * hammer Linktree and ManaBox on demand.
   */
  refreshToken: process.env.REFRESH_TOKEN || undefined,

  dbPath: process.env.DB_PATH ?? 'data/mtg.db',
  port: Number(process.env.PORT ?? 3000),

  userAgent:
    process.env.USER_AGENT ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
} as const;

export const linktreeUrl = (username = config.linktreeUsername) =>
  `https://linktr.ee/${username}`;
