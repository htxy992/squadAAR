/**
 * Squad log timestamps look like: `2026.06.10-19.50.00:123`
 * (YYYY.MM.DD-HH.MM.SS:mmm), always UTC on dedicated servers.
 */

const TS_RE = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})$/;

/** Parse a Squad log timestamp into epoch milliseconds (UTC). */
export function parseLogTime(ts: string): number {
  const m = TS_RE.exec(ts.trim());
  if (!m) {
    const n = Date.parse(ts);
    return Number.isNaN(n) ? 0 : n;
  }
  const [, y, mo, d, h, mi, s, ms] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms);
}

/** Convert epoch milliseconds back into a Squad-style log timestamp. */
export function formatLogTime(epochMs: number): string {
  const dt = new Date(epochMs);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${dt.getUTCFullYear()}.${p(dt.getUTCMonth() + 1)}.${p(dt.getUTCDate())}-` +
    `${p(dt.getUTCHours())}.${p(dt.getUTCMinutes())}.${p(dt.getUTCSeconds())}:` +
    `${p(dt.getUTCMilliseconds(), 3)}`
  );
}

/** Human-readable mm:ss given a millisecond offset. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
