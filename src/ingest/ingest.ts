import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseLog, splitRounds } from '../parser/logParser.js';
import { buildRound } from '../timeline/build.js';
import { computePoints } from '../points/squadPoints.js';
import { processRound, computeBalance, type EloState } from '../elo/squadElo.js';
import { Store, type RoundBundle } from '../store/store.js';

export interface IngestResult {
  file: string;
  rounds: Array<{ id: string; layer: string; players: number; events: number; suspicious: number }>;
}

/**
 * Full pipeline for one log file: parse -> split into rounds -> build timeline
 * -> SquadPoints -> SquadElo (mutating shared state) -> persist.
 */
export async function ingestLogFile(file: string, store: Store, eloState: EloState): Promise<IngestResult> {
  const text = await fs.readFile(file, 'utf8');
  const { events } = parseLog(text);
  const roundChunks = splitRounds(events);
  const result: IngestResult = { file, rounds: [] };
  const baseName = path.basename(file);

  let idx = 0;
  for (const chunk of roundChunks) {
    idx++;
    // a real round needs actual gameplay telemetry, not just a map-load line
    // (client logs contain NEW_GAME but none of the combat/position events).
    const activity = chunk.filter(
      (e) => e.type === 'PLAYER_POS' || e.type === 'PLAYER_DIED' || e.type === 'TICKETS' || e.type === 'PLAYER_WOUNDED'
    ).length;
    if (activity < 20) continue;

    const round = buildRound(chunk, { source: baseName });
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
      report,
      eloReport,
      balance
    };
    await store.saveRound(bundle);
    result.rounds.push({
      id: round.meta.id,
      layer: round.meta.layer,
      players: round.meta.playerCount,
      events: round.events.length,
      suspicious: round.analysis.suspicious.length
    });
  }
  return result;
}

/** Ingest many files in chronological order, sharing one Elo state. */
export async function ingestFiles(files: string[], store: Store): Promise<IngestResult[]> {
  const eloState = await store.loadEloState();
  const out: IngestResult[] = [];
  for (const f of files) out.push(await ingestLogFile(f, store, eloState));
  await store.saveEloState(eloState);
  return out;
}
