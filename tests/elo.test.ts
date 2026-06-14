import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedScore, processRound, computeBalance, newEloState, decayedElo, DEFAULT_ELO_CONFIG } from '../src/elo/squadElo.js';
import type { RoundReport, PlayerPointReport } from '../src/points/types.js';

function player(eosID: string, team: number, points: number, timeMs = 600000): PlayerPointReport {
  return {
    eosID,
    name: eosID,
    team,
    pool: 'Generic',
    poolPoints: { Generic: points },
    poolTimeMs: { Generic: timeMs },
    breakdown: { combat: points, revive: 0, heal: 0, flag: 0, fobDestroy: 0, vehicleDestroy: 0, component: 0, logistics: 0, transport: 0, fobValue: 0, penalty: 0 },
    totalPoints: points,
    stats: { kills: 0, wounds: 0, deaths: 0, teamkills: 0, revivesGiven: 0, revivesReceived: 0, damageInfantry: 0, damageVehicle: 0, longestKillM: 0, headshots: 0, fobsDestroyed: 0, vehiclesDestroyed: 0, flagsCaptured: 0 }
  };
}
function report(players: PlayerPointReport[], winnerTeam = 1): RoundReport {
  return {
    global: { roundId: 'r1', layer: 'Harju_RAAS_v1', mapName: 'Harju', durationMs: 1_200_000, startTime: 0, winnerTeam, finalTickets: {}, factions: {}, playerCount: players.length, teamPoints: {} },
    players
  };
}

test('expectedScore is symmetric and monotone', () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
  assert.ok(expectedScore(1200, 1000) > 0.5);
  assert.ok(expectedScore(800, 1000) < 0.5);
  assert.ok(Math.abs(expectedScore(1000, 1400) - 0.0909) < 0.01); // ~10% at -400
});

test('higher-scoring player gains pool + global Elo', () => {
  const state = newEloState();
  const rep = report([player('a', 1, 30), player('b', 2, 5)]);
  const out = processRound(rep, state);
  const a = out.players.find((p) => p.eosID === 'a')!;
  const b = out.players.find((p) => p.eosID === 'b')!;
  assert.ok(a.pools.Generic!.delta > 0, 'top scorer pool elo up');
  assert.ok(b.pools.Generic!.delta < 0, 'low scorer pool elo down');
  assert.ok(a.globalDelta > 0 && b.globalDelta < 0, 'global tracks too');
  // zero-sum-ish within a pool
  assert.ok(Math.abs(a.pools.Generic!.delta + b.pools.Generic!.delta) < 1e-6);
});

test('team balance win chances sum to 1', () => {
  const state = newEloState();
  const rep = report([player('a', 1, 20), player('b', 1, 18), player('c', 2, 10), player('d', 2, 9)]);
  processRound(rep, state);
  const bal = computeBalance(rep, state);
  assert.ok(Math.abs(bal.team1.win_chance + bal.team2.win_chance - 1) < 1e-6);
  assert.equal(bal.team1.valid_players, 2);
});

test('elo decay pulls high elo toward floor, leaves low elo alone', () => {
  const cfg = DEFAULT_ELO_CONFIG;
  const now = 100 * 24 * 3600 * 1000;
  const high = { global: 1400, lastPlayedMs: now - cfg.decayHalfLifeMs } as any;
  const low = { global: 800, lastPlayedMs: now - cfg.decayHalfLifeMs } as any;
  assert.ok(decayedElo(high, now, cfg) < 1400 && decayedElo(high, now, cfg) > 1000);
  assert.equal(decayedElo(low, now, cfg), 800);
});
