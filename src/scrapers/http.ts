import { config } from '../config.js';
import { log } from '../logger.js';

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a page as text with a timeout and bounded retries.
 *
 * 404/410 are treated as terminal (the deck is gone) and thrown immediately as
 * HttpError so callers can mark a deck inactive instead of retrying a dead URL.
 */
export async function fetchHtml(url: string): Promise<string> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= config.fetchRetries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': config.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9,es;q=0.8',
        },
      });

      if (res.status === 404 || res.status === 410) throw new HttpError(res.status, url);
      if (!res.ok) {
        lastErr = new HttpError(res.status, url);
        log.warn(`fetch ${res.status}, retrying`, { url, attempt });
        continue;
      }
      return await res.text();
    } catch (err) {
      if (err instanceof HttpError) throw err; // terminal: gone
      lastErr = err;
      log.warn(`fetch failed, retrying`, { url, attempt, err: String(err) });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`fetch failed for ${url}`);
}
