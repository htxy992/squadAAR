import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseLog, splitRounds } from '../parser/logParser.js';
import { buildRound } from '../timeline/build.js';
import { resolveMap } from '../maps/mapRegistry.js';
import { tryLoadHeightmapField } from '../maps/heightmap.js';
import { computePoints } from '../points/squadPoints.js';
import { processRound, computeBalance, type EloState } from '../elo/squadElo.js';
import { Store, type RoundBundle } from '../store/store.js';
import type { TimelineEvent } from '../parser/events.js';

export interface IngestedRound {
  id: string;
  layer: string;
  players: number;
  events: number;
  suspicious: number;
}

export interface IngestResult {
  file: string;
  rounds: IngestedRound[];
}

/** Minimum gameplay events (positions/deaths/tickets/wounds) for a chunk to count as a real round. */
const MIN_ACTIVITY = 20;

/**
 * Build, score and persist one round chunk. Returns the summary, or `null` if
 * the chunk is just a map-load with no real gameplay telemetry. Mutates `eloState` in place.
 */
export async function ingestRoundChunk(
  chunk: TimelineEvent[],
  source: string,
  store: Store,
  eloState: EloState
): Promise<IngestedRound | null> {
  const activity = chunk.filter(
    (e) => e.type === 'PLAYER_POS' || e.type === 'PLAYER_DIED' || e.type === 'TICKETS' || e.type === 'PLAYER_WOUNDED'
  ).length;
  if (activity < MIN_ACTIVITY) return null;

  const newGame = chunk.find((e) => e.type === 'NEW_GAME') as any;
  const map = resolveMap(newGame?.layerClassname ?? newGame?.mapClassname);
  const terrainField = tryLoadHeightmapField(map) ?? undefined;

  const round = buildRound(chunk, { source, terrainField });
  const report = computePoints(round);
  const eloReport = processRound(report, eloState);
  const balance = computeBalance(report, eloState);

  const bundle: RoundBundle = {
    meta: round.meta,
    players: round.players,
    snapshots: round.snapshots,
    mapEvents: round.mapEvents,
    analysis: round.analysis,
    deaths: round.deaths,
    terrain: round.terrain,
    vehicleTracks: round.vehicleTracks,
    markers: round.markers,
    engagements: round.engagements,
    bursts: round.bursts,
    chatLog: round.chatLog,
    adminLog: round.adminLog,
    squadChanges: round.squadChanges,
    tickSamples: round.tickSamples,
    report,
    eloReport,
    balance
  };
  await store.saveRound(bundle);
  return {
    id: round.meta.id,
    layer: round.meta.layer,
    players: round.meta.playerCount,
    events: round.events.length,
    suspicious: round.analysis.suspicious.length
  };
}

export interface IngestTextOptions {
  completeOnly?: boolean;
}

/**
 * Parse a block of raw log text, split it into rounds, and persist every
 * qualifying round. Mutates `eloState` in place.
 */
export async function ingestText(
  text: string,
  source: string,
  store: Store,
  eloState: EloState,
  opts: IngestTextOptions = {}
): Promise<IngestedRound[]> {
  const { events } = parseLog(text);
  const chunks = splitRounds(events);
  const rounds: IngestedRound[] = [];
  for (const chunk of chunks) {
    if (opts.completeOnly && !chunk.some((e) => e.type === 'ROUND_ENDED')) continue;
    const info = await ingestRoundChunk(chunk, source, store, eloState);
    if (info) rounds.push(info);
  }
  return rounds;
}

/**
 * Full pipeline for one log file: read -> parse -> split into rounds -> build
 * timeline -> SquadPoints -> SquadElo (mutating shared state) -> persist.
 */
export async function ingestLogFile(file: string, store: Store, eloState: EloState): Promise<IngestResult> {
  const text = await fs.readFile(file, 'utf8');
  const rounds = await ingestText(text, path.basename(file), store, eloState);
  return { file, rounds };
}

/** Ingest many files in chronological order, sharing one Elo state. */
export async function ingestFiles(files: string[], store: Store): Promise<IngestResult[]> {
  const eloState = await store.loadEloState();
  const out: IngestResult[] = [];
  for (const f of files) out.push(await ingestLogFile(f, store, eloState));
  await store.saveEloState(eloState);
  return out;
}
