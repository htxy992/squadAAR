/**
 * Zero-dependency HTTP server: JSON API + static web app.
 *
 *   npm run serve   ->  http://localhost:8787
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Store } from '../store/store.js';
import { decayedElo, type EloConfig } from '../elo/squadElo.js';
import { RATED_POOLS } from '../elo/pools.js';

const PORT = Number(process.env.PORT ?? 8787);
const WEB_DIR = path.resolve(process.cwd(), 'web');
const store = new Store();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJSON(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(body);
}

async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(WEB_DIR, rel));
  if (!full.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = await fs.readFile(full);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA fallback
    try {
      const data = await fs.readFile(path.join(WEB_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }
}

async function leaderboard(pool: string) {
  const state = await store.loadEloState();
  const now = Date.now();
  const cfg = state.config as EloConfig;
  const rows = Object.values(state.players)
    .map((pe) => {
      const value =
        pool === 'global'
          ? Math.round(decayedElo(pe, now, cfg))
          : Math.round((pe.pools as any)[pool] ?? NaN);
      return {
        eosID: pe.eosID,
        name: pe.name,
        steamID: pe.steamID,
        elo: value,
        games: pool === 'global' ? pe.games : (pe.poolGames as any)[pool] ?? 0
      };
    })
    .filter((r) => !Number.isNaN(r.elo) && r.games > 0)
    .sort((a, b) => b.elo - a.elo);
  return rows;
}

async function playerProfile(eosID: string) {
  const state = await store.loadEloState();
  const pe = state.players[eosID];
  const index = await store.loadIndex();
  const history: any[] = [];
  const agg = { kills: 0, wounds: 0, deaths: 0, revives: 0, damageInf: 0, damageVeh: 0, points: 0, rounds: 0, longestKillM: 0 };
  for (const s of index) {
    const bundle = await store.loadRound(s.id);
    if (!bundle) continue;
    const rep = bundle.report.players.find((p) => p.eosID === eosID);
    if (!rep) continue;
    const elo = bundle.eloReport.players.find((p) => p.eosID === eosID);
    agg.kills += rep.stats.kills;
    agg.wounds += rep.stats.wounds;
    agg.deaths += rep.stats.deaths;
    agg.revives += rep.stats.revivesGiven;
    agg.damageInf += rep.stats.damageInfantry;
    agg.damageVeh += rep.stats.damageVehicle;
    agg.points += rep.totalPoints;
    agg.longestKillM = Math.max(agg.longestKillM, rep.stats.longestKillM);
    agg.rounds += 1;
    history.push({
      roundId: s.id,
      mapName: s.mapName,
      layer: s.layer,
      startTime: s.startTime,
      team: rep.team,
      pool: rep.pool,
      points: rep.totalPoints,
      stats: rep.stats,
      globalDelta: elo?.globalDelta ?? 0,
      globalAfter: elo?.globalAfter ?? null
    });
  }
  history.sort((a, b) => b.startTime - a.startTime);
  return { elo: pe ?? null, aggregate: agg, history };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const p = url.pathname;

    if (p === '/api/rounds') return sendJSON(res, 200, await store.loadIndex());

    if (p.startsWith('/api/rounds/')) {
      const id = p.slice('/api/rounds/'.length);
      const bundle = await store.loadRound(id);
      return bundle ? sendJSON(res, 200, bundle) : sendJSON(res, 404, { error: 'round not found' });
    }

    if (p === '/api/leaderboard') {
      const pool = url.searchParams.get('pool') ?? 'global';
      return sendJSON(res, 200, { pool, rows: await leaderboard(pool) });
    }

    if (p === '/api/pools') return sendJSON(res, 200, ['global', ...RATED_POOLS]);

    if (p.startsWith('/api/players/')) {
      const eos = p.slice('/api/players/'.length);
      return sendJSON(res, 200, await playerProfile(eos));
    }

    if (p.startsWith('/api/')) return sendJSON(res, 404, { error: 'unknown endpoint' });

    return serveStatic(res, p);
  } catch (err) {
    sendJSON(res, 500, { error: String(err) });
  }
});

await store.init();
server.listen(PORT, () => {
  console.log(`SquadAAR server on http://localhost:${PORT}`);
  console.log(`  API: /api/rounds  /api/rounds/:id  /api/leaderboard?pool=  /api/players/:eosID`);
});
