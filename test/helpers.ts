/** Capture console.error output (where the logger writes) during a call. */
export function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.error = original; }
  return lines;
}

export const hasAnomaly = (lines: string[]) => lines.some((l) => l.includes('SCRAPE ANOMALY'));
