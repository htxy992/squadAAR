import type { TimelineEvent } from './events.js';

/** Per-player identity record accumulated while parsing. */
export interface PlayerRef {
  eosID?: string;
  steamID?: string;
  name?: string;
  controller?: string;
  ip?: string;
}

/**
 * Mutable correlation state held while scanning a log, mirroring SquadJS's
 * `eventStore`. Lets us join lines that only make sense together (e.g. a
 * `Wound()` line whose attacker identity arrived earlier on a `ActualDamage` line).
 */
export interface EventStore {
  /** keyed by victim name -> last damage info (for wound/die attribution) */
  session: Record<string, any>;
  /** keyed by eosID -> player identity */
  players: Record<string, PlayerRef>;
  /** keyed by chainID -> pending join */
  joinRequests: Record<number, PlayerRef>;
  /** keyed by eosID -> true while disconnected */
  disconnected: Record<string, boolean>;
  /** controller string -> eosID */
  controllerToEOS: Record<string, string>;
  /** player name -> eosID (best effort) */
  nameToEOS: Record<string, string>;
}

export function newEventStore(): EventStore {
  return {
    session: {},
    players: {},
    joinRequests: {},
    disconnected: {},
    controllerToEOS: {},
    nameToEOS: {}
  };
}

export interface ParserContext {
  store: EventStore;
  emit: (ev: TimelineEvent) => void;
  /** base fields shared by every event (time/ts/chainID/raw) */
  base: (m: RegExpExecArray) => { time: number; ts: string; chainID: number; raw: string };
}

export interface Pattern {
  name: string;
  regex: RegExp;
  handle: (m: RegExpExecArray, ctx: ParserContext) => void;
}
