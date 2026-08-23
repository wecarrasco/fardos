type Level = 'debug' | 'info' | 'warn' | 'error';

const stamp = () => new Date().toISOString();

// Everything goes to stderr so stdout stays a clean channel for piping
// machine-readable output (e.g. `scrape:linktree -- --json | jq`).
function emit(level: Level, msg: string, meta?: unknown) {
  const line = `${stamp()} [${level.toUpperCase()}] ${msg}`;
  meta === undefined ? console.error(line) : console.error(line, meta);
}

export const log = {
  debug: (m: string, meta?: unknown) => emit('debug', m, meta),
  info: (m: string, meta?: unknown) => emit('info', m, meta),
  warn: (m: string, meta?: unknown) => emit('warn', m, meta),
  error: (m: string, meta?: unknown) => emit('error', m, meta),

  /**
   * Scrape anomalies get their own channel. A parse that returns zero rows almost
   * always means the site's markup changed, not that the page is genuinely empty --
   * so it is surfaced loudly rather than logged as a normal result.
   */
  anomaly: (m: string, meta?: unknown) => emit('warn', `SCRAPE ANOMALY: ${m}`, meta),
};
