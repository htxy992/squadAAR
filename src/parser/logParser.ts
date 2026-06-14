import { patterns } from './patterns.js';
import { newEventStore, type EventStore, type ParserContext } from './store.js';
import type { TimelineEvent } from './events.js';
import { parseLogTime } from '../util/time.js';

export interface ParseResult {
  events: TimelineEvent[];
  store: EventStore;
  /** lines that matched no pattern (sampled, for diagnostics) */
  unmatchedSample: string[];
  stats: { lines: number; matched: number; emitted: number };
}

/**
 * Parse a full Squad log (string or lines) into a flat, time-ordered list of
 * normalized timeline events. Boot/EOS/RHI spam is simply ignored — only lines
 * matching a known pattern produce events.
 */
export function parseLog(input: string | string[]): ParseResult {
  const lines = Array.isArray(input) ? input : input.split(/\r?\n/);
  const store = newEventStore();
  const events: TimelineEvent[] = [];
  const unmatchedSample: string[] = [];
  let matched = 0;

  const ctx: ParserContext = {
    store,
    emit: (ev) => events.push(ev),
    base: (m) => ({
      time: parseLogTime(m[1]),
      ts: m[1],
      chainID: parseInt((m[2] ?? '0').trim() || '0', 10),
      raw: m[0]
    })
  };

  for (const line of lines) {
    if (!line || line.length < 24) continue;
    // cheap pre-filter: only lines we could possibly care about
    if (!line.includes('LogSquad') && !line.includes('LogWorld') && !line.includes('LogNet') && !line.includes('LogGameState'))
      continue;

    let hit = false;
    for (const p of patterns) {
      const m = p.regex.exec(line);
      if (m) {
        hit = true;
        matched++;
        try {
          p.handle(m, ctx);
        } catch {
          /* a malformed line should never crash the whole parse */
        }
        break;
      }
    }
    if (!hit && line.includes('LogSquadStats') && unmatchedSample.length < 50) unmatchedSample.push(line);
  }

  // stable sort by time then chainID (events already mostly ordered)
  events.sort((a, b) => a.time - b.time || a.chainID - b.chainID);

  return { events, store, unmatchedSample, stats: { lines: lines.length, matched, emitted: events.length } };
}

/**
 * Split a flat event stream into per-round chunks. A round begins at a NEW_GAME
 * and ends at the next NEW_GAME or a ROUND_ENDED. Events before the first
 * NEW_GAME (lobby/seeding) are dropped.
 */
export function splitRounds(events: TimelineEvent[]): TimelineEvent[][] {
  const rounds: TimelineEvent[][] = [];
  let current: TimelineEvent[] | null = null;
  for (const ev of events) {
    if (ev.type === 'NEW_GAME') {
      if (current && current.length) rounds.push(current);
      current = [ev];
    } else if (current) {
      current.push(ev);
      if (ev.type === 'ROUND_ENDED') {
        rounds.push(current);
        current = null;
      }
    }
  }
  if (current && current.length) rounds.push(current);
  return rounds;
}
