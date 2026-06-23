/**
 * Zero-dependency HTTP server: JSON API + static web app.
 *
 *   npm run serve   ->  http://localhost:8787
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Store } from '../store/store.js';
import { ingestText, type IngestedRound } from '../ingest/ingest.js';
import { leaderboard, playerProfile, poolsList } from './queries.js';

const PORT = Number(process.env.PORT ?? 8787);
const WEB_DIR = path.resolve(process.cwd(), 'web');
const MAX_INGEST_BYTES = Number(process.env.MAX_INGEST_BYTES ?? 1_500 * 1024 * 1024); // 1.5 GB
const store = new Store();

/**
 * Serialize ingests so concurrent pushes can't race on the shared Elo state.
 */
let ingestChain: Promise<unknown> = Promise.resolve();
function runIngest(text: string, source: string): Promise<IngestedRound[]> {
  const job = ingestChain.then(async () => {
    const eloState = await store.loadEloState();
    const rounds = await ingestText(text, source, store, eloState, { completeOnly: true });
    if (rounds.length) await store.saveEloState(eloState);
    return rounds;
  });
  ingestChain = job.catch(() => undefined);
  return job;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`payload too large (> ${limit} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

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

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-source'
      });
      return res.end();
    }

    // POST /api/ingest — push raw log text
    if (req.method === 'POST' && p === '/api/ingest') {
      let body: string;
      try {
        body = await readBody(req, MAX_INGEST_BYTES);
      } catch (e) {
        return sendJSON(res, 413, { error: String(e) });
      }
      let text = body;
      let source = req.headers['x-source']?.toString() ?? url.searchParams.get('source') ?? 'push';
      const ctype = req.headers['content-type'] ?? '';
      if (ctype.includes('application/json')) {
        try {
          const j = JSON.parse(body);
          text = j.text ?? j.log ?? '';
          if (j.source) source = String(j.source);
        } catch {
          return sendJSON(res, 400, { error: 'invalid JSON body' });
        }
      }
      if (!text.trim()) return sendJSON(res, 400, { error: 'empty log payload' });
      try {
        const rounds = await runIngest(text, source);
        return sendJSON(res, 200, { ingested: rounds.length, rounds });
      } catch (e) {
        return sendJSON(res, 500, { error: String(e) });
      }
    }

    if (p === '/api/rounds') return sendJSON(res, 200, await store.loadIndex());

    if (p.startsWith('/api/round/')) {
      // /api/round/:id/chat  — chat log
      if (p.includes('/chat')) {
        const idPart = p.replace(/\/chat.*$/, '').slice('/api/round/'.length);
        const bundle = await store.loadRound(idPart);
        if (!bundle) return sendJSON(res, 404, { error: 'round not found' });
        return sendJSON(res, 200, { chatLog: bundle.chatLog ?? [] });
      }
      // /api/round/:id/admin  — admin log + squad changes
      if (p.includes('/admin')) {
        const idPart = p.replace(/\/admin.*$/, '').slice('/api/round/'.length);
        const bundle = await store.loadRound(idPart);
        if (!bundle) return sendJSON(res, 404, { error: 'round not found' });
        return sendJSON(res, 200, { adminLog: bundle.adminLog ?? [], squadChanges: bundle.squadChanges ?? [] });
      }
      const id = p.slice('/api/round/'.length);
      const bundle = await store.loadRound(id);
      if (!bundle) return sendJSON(res, 404, { error: 'round not found' });
      // Include last 10 tick samples in the main round response if available
      const ticks = bundle.tickSamples ?? [];
      const tickSummary = ticks.length > 0 ? ticks.slice(-10) : undefined;
      return sendJSON(res, 200, tickSummary ? { ...bundle, tickSamples: tickSummary } : bundle);
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
  console.log(`  API: /api/rounds  /api/round/:id  /api/leaderboard?pool=  /api/players/:eosID`);
  console.log(`  POST /api/ingest  (push raw log text; drag-drop in the web UI)`);
});
