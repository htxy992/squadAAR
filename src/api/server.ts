/**
 * Zero-dependency HTTP server: JSON API + static web app.
 *
 *   npm run serve   ->  http://localhost:8787
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Store } from '../store/store.js';
import { leaderboard, playerProfile, poolsList } from './queries.js';

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const p = url.pathname;

    if (p === '/api/rounds') return sendJSON(res, 200, await store.loadIndex());

    if (p.startsWith('/api/round/')) {
      const id = p.slice('/api/round/'.length);
      const bundle = await store.loadRound(id);
      return bundle ? sendJSON(res, 200, bundle) : sendJSON(res, 404, { error: 'round not found' });
    }

    if (p === '/api/leaderboard') {
      const pool = url.searchParams.get('pool') ?? 'global';
      return sendJSON(res, 200, { pool, rows: await leaderboard(store, pool) });
    }
    if (p.startsWith('/api/leaderboard/')) {
      const pool = p.slice('/api/leaderboard/'.length);
      return sendJSON(res, 200, { pool, rows: await leaderboard(store, pool) });
    }

    if (p === '/api/pools') return sendJSON(res, 200, poolsList());

    if (p.startsWith('/api/players/')) {
      const eos = p.slice('/api/players/'.length);
      return sendJSON(res, 200, await playerProfile(store, eos));
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
