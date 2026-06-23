import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Round } from '../timeline/types.js';
import type { RoundReport } from '../points/types.js';
import { newEloState, type EloState, type RoundEloReport, type TeamBalance, DEFAULT_ELO_CONFIG } from '../elo/squadElo.js';

export interface RoundBundle {
  meta: Round['meta'];
  players: Round['players'];
  snapshots: Round['snapshots'];
  mapEvents: Round['mapEvents'];
  analysis: Round['analysis'];
  deaths: Round['deaths'];
  terrain: Round['terrain'];
  vehicleTracks: Round['vehicleTracks'];
  markers: Round['markers'];
  /** CQB 1v1 engagements with coaching flags (empty without PROJECTILE telemetry). */
  engagements: Round['engagements'];
  /** Per-shooter burst summaries from spray/TTK analysis. */
  bursts: Round['bursts'];
  chatLog: Round['chatLog'];
  adminLog: Round['adminLog'];
  squadChanges: Round['squadChanges'];
  tickSamples: Round['tickSamples'];
  report: RoundReport;
  eloReport: RoundEloReport;
  balance: TeamBalance;
}

export interface RoundSummary {
  id: string;
  layer: string;
  mapName: string;
  startTime: number;
  durationMs: number;
  winnerTeam?: number;
  factions: Record<number, string>;
  finalTickets: Record<number, number>;
  playerCount: number;
  suspiciousShots: number;
}

const DATA = path.resolve(process.cwd(), 'data');
const ROUNDS_DIR = path.join(DATA, 'rounds');
const INDEX = path.join(DATA, 'index.json');
const ELO_STATE = path.join(DATA, 'elo-state.json');

export class Store {
  async init(): Promise<void> {
    await fs.mkdir(ROUNDS_DIR, { recursive: true });
  }

  async loadEloState(): Promise<EloState> {
    try {
      const raw = JSON.parse(await fs.readFile(ELO_STATE, 'utf8'));
      return { players: raw.players ?? {}, config: { ...DEFAULT_ELO_CONFIG, ...(raw.config ?? {}) } };
    } catch {
      return newEloState();
    }
  }

  async saveEloState(state: EloState): Promise<void> {
    await fs.writeFile(ELO_STATE, JSON.stringify(state));
  }

  async saveRound(bundle: RoundBundle): Promise<void> {
    await this.init();
    const file = path.join(ROUNDS_DIR, `${safeId(bundle.meta.id)}.json`);
    await fs.writeFile(file, JSON.stringify(bundle));
    await this.appendIndex(bundle);
  }

  private async appendIndex(bundle: RoundBundle): Promise<void> {
    const index = await this.loadIndex();
    const summary: RoundSummary = {
      id: bundle.meta.id,
      layer: bundle.meta.layer,
      mapName: bundle.meta.mapName,
      startTime: bundle.meta.startTime,
      durationMs: bundle.meta.durationMs,
      winnerTeam: bundle.meta.winnerTeam,
      factions: bundle.meta.factions,
      finalTickets: bundle.meta.finalTickets,
      playerCount: bundle.meta.playerCount,
      suspiciousShots: bundle.analysis.suspicious.length
    };
    const filtered = index.filter((r) => r.id !== summary.id);
    filtered.push(summary);
    filtered.sort((a, b) => b.startTime - a.startTime);
    await fs.writeFile(INDEX, JSON.stringify(filtered, null, 2));
  }

  async loadIndex(): Promise<RoundSummary[]> {
    try {
      return JSON.parse(await fs.readFile(INDEX, 'utf8'));
    } catch {
      return [];
    }
  }

  async loadRound(id: string): Promise<RoundBundle | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(ROUNDS_DIR, `${safeId(id)}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  async reset(): Promise<void> {
    await fs.rm(ROUNDS_DIR, { recursive: true, force: true });
    await fs.rm(INDEX, { force: true });
    await fs.rm(ELO_STATE, { force: true });
    await this.init();
  }
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}
