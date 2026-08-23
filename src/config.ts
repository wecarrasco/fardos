import 'dotenv/config';

/** All tunables live here so the target account is a one-line change. */
export const config = {
  /** Linktree username to scrape. Change this to point the app at a different seller. */
  linktreeUsername: process.env.LINKTREE_USERNAME ?? 'ChelitoSAF',

  /** Politeness: milliseconds to wait between consecutive deck-page fetches. */
  fetchDelayMs: Number(process.env.FETCH_DELAY_MS ?? 1200),

  /** Per-request timeout and retry budget. */
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS ?? 20_000),
  fetchRetries: Number(process.env.FETCH_RETRIES ?? 2),

  userAgent:
    process.env.USER_AGENT ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
} as const;

export const linktreeUrl = (username = config.linktreeUsername) =>
  `https://linktr.ee/${username}`;
