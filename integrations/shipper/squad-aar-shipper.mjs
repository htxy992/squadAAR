#!/usr/bin/env node
/**
 * SquadAAR log shipper — a tiny, dependency-free agent for the GAME SERVER box.
 *
 * Tails the Squad dedicated-server log and POSTs each *completed* round to a
 * remote SquadAAR instance's /api/ingest endpoint. Use this when SquadAAR runs
 * on a different machine than the game server. (If they share a box, just run
 * `npm run watch` instead.)
 *
 * Copy this single file to the game server (Node 18+; no install needed):
 *
 *   SQUAD_LOG=/path/to/SquadGame/Saved/Logs/SquadGame.log \
 *   AAR_URL=https://your-aar-host:8787 \
 *   node squad-aar-shipper.mjs
 *
 * Env / flags:
 *   SQUAD_LOG  / --log=<path>     path to SquadGame.log (required)
 *   AAR_URL    / --url=<url>      SquadAAR base URL (required)
 *   AAR_TOKEN  / --token=<t>      optional bearer token (sent as Authorization)
 *   POLL_MS    / --poll=<ms>      file poll interval (default 1000)
 *   --from-start                  ship existing rounds in the file first
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const has = (name) => args.includes(`--${name}`);

const LOG = process.env.SQUAD_LOG || flag('log');
const URL_BASE = (process.env.AAR_URL || flag('url') || '').replace(/\/$/, '');
const TOKEN = process.env.AAR_TOKEN || flag('token') || '';
const POLL_MS = Number(process.env.POLL_MS || flag('poll') || 1000);
const FROM_START = has('from-start');

if (!LOG || !URL_BASE) {
  console.error('Usage: SQUAD_LOG=<path> AAR_URL=<url> node squad-aar-shipper.mjs [--from-start] [--poll=ms]');
  process.exit(1);
}
const INGEST = `${URL_BASE}/api/ingest`;
const SOURCE = path.basename(LOG);

const isRoundStart = (l) => l.includes('LogWorld: Bringing World') && !l.includes('TransitionMap');
const isRoundEnd = (l) =>
  l.includes('has won the match with') || l.includes('Match State Changed from InProgress to WaitingPostMatch');

let offset = 0;
let remainder = '';
let cur = [];
let curHasStart = false;
let curEnded = false;
let pumping = false;

async function ship(text) {
  try {
    const res = await fetch(INGEST, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-source': SOURCE,
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {})
      },
      body: text
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) console.error(`  ship failed: ${res.status} ${j.error ?? ''}`);
    else if (j.ingested) console.log(`  shipped ${j.ingested} round(s):`, j.rounds?.map((r) => r.id).join(', '));
  } catch (e) {
    console.error('  ship error:', e.message);
  }
}

async function flush() {
  if (!cur.length) return;
  await ship(cur.join('\n') + '\n');
  cur = [];
  curHasStart = false;
}

function feed(text) {
  remainder += text;
  const parts = remainder.split(/\r?\n/);
  remainder = parts.pop() ?? '';
  const completed = [];
  for (const line of parts) {
    if (!line) continue;
    if (isRoundStart(line)) {
      if (curHasStart && cur.length) completed.push(cur), (cur = []);
      cur = [line];
      curHasStart = true;
      curEnded = false;
      continue;
    }
    cur.push(line);
    if (curHasStart && !curEnded && isRoundEnd(line)) {
      curEnded = true;
      completed.push(cur);
      cur = [];
      curHasStart = false;
    }
  }
  return completed;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let size;
    try {
      size = fs.statSync(LOG).size;
    } catch {
      return;
    }
    if (size < offset) {
      console.log('log rotated/truncated — restarting from byte 0');
      offset = 0;
      remainder = '';
    }
    if (size === offset) return;
    const fd = fs.openSync(LOG, 'r');
    try {
      const MAX = 4 * 1024 * 1024;
      while (offset < size) {
        const len = Math.min(MAX, size - offset);
        const buf = Buffer.allocUnsafe(len);
        const read = fs.readSync(fd, buf, 0, len, offset);
        if (read <= 0) break;
        offset += read;
        const completed = feed(buf.toString('utf8', 0, read));
        for (const lines of completed) await ship(lines.join('\n') + '\n');
      }
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    pumping = false;
  }
}

if (!FROM_START) {
  try {
    offset = fs.statSync(LOG).size;
  } catch {
    offset = 0;
  }
}
console.log(`Shipping ${LOG} -> ${INGEST} (${FROM_START ? 'from start' : 'tailing'}, poll ${POLL_MS}ms)`);
await pump();
setInterval(() => void pump(), POLL_MS);
