import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSampleLog } from '../src/tools/generateSampleLog.js';
import { parseLog, splitRounds } from '../src/parser/logParser.js';
import { buildRound } from '../src/timeline/build.js';
import { computePoints } from '../src/points/squadPoints.js';
import { processRound, computeBalance, newEloState } from '../src/elo/squadElo.js';

test('full pipeline on generated sample log', async () => {
  const file = path.join(os.tmpdir(), `squadaar-test-${Date.now()}.log`);
  await writeSampleLog(file);
  const text = await fs.readFile(file, 'utf8');
  await fs.rm(file, { force: true });

  const { events } = parseLog(text);
  assert.ok(events.length > 1000, 'parsed many events');

  const rounds = splitRounds(events);
  assert.equal(rounds.length, 1, 'one round');

  const round = buildRound(rounds[0]);
  assert.equal(round.meta.mapName, 'Harju');
  assert.ok([1, 2].includes(round.meta.winnerTeam!), 'has a winner');
  assert.ok(round.meta.playerCount >= 40, 'roster present');
  assert.ok(round.snapshots.length > 50, 'replay snapshots built');
  assert.ok(round.mapEvents.some((e) => e.kind === 'kill'), 'kills positioned on map');
  assert.ok(round.mapEvents.some((e) => e.kind === 'revive'), 'revives present');

  // projectile plausibility: the two injected suspicious shots are flagged
  assert.equal(round.analysis.suspicious.length, 2, 'wallbang + impossible-range flagged');
  assert.ok(round.analysis.projectiles.length > 20);

  const report = computePoints(round);
  const totalKills = report.players.reduce((s, p) => s + p.stats.kills, 0);
  assert.ok(totalKills > 0, 'kills credited');
  assert.ok(report.players.some((p) => p.breakdown.combat > 0), 'combat points awarded');
  assert.ok(report.players.some((p) => p.breakdown.revive > 0), 'revive points awarded');
  assert.ok(report.players.some((p) => Math.abs(p.totalPoints) > 0));

  const state = newEloState();
  const eloReport = processRound(report, state);
  for (const p of eloReport.players) {
    assert.ok(Number.isFinite(p.globalAfter), 'finite elo');
  }
  assert.ok(eloReport.players.some((p) => p.globalDelta !== 0), 'elo moved');

  const bal = computeBalance(report, state);
  assert.ok(Math.abs(bal.team1.win_chance + bal.team2.win_chance - 1) < 1e-6);
});
