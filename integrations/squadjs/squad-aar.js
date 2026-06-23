import BasePlugin from './base-plugin.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SquadAAR — SquadJS plugin.
 *
 * Ships each completed round from the Squad dedicated-server log to a SquadAAR
 * instance's /api/ingest endpoint. Drop this file in SquadJS's `squad-server/
 * plugins/` directory and add the block below to your SquadJS `config.json`:
 *
 *   {
 *     "plugin": "SquadAAR",
 *     "enabled": true,
 *     "aarUrl": "http://localhost:8787",
 *     "logFilePath": "/path/to/SquadGame/Saved/Logs/SquadGame.log",
 *     "token": "",
 *     "pollMs": 1000
 *   }
 *
 * It tails the log itself (independent of SquadJS's own reader) and POSTs whole
 * rounds, so SquadAAR's parser does all the work and stays the single source of
 * truth for the log format. For full CQB telemetry the server must additionally
 * emit the extended `LogSquadStats:` lines (see docs/CQB_CAPTURE_SPEC.md).
 */
export default class SquadAAR extends BasePlugin {
  static get description() {
    return 'Ships completed rounds from the Squad server log to a SquadAAR instance.';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      aarUrl: {
        required: true,
        description: 'Base URL of the SquadAAR instance.',
        default: 'http://localhost:8787'
      },
      logFilePath: {
        required: true,
        description: 'Absolute path to the Squad dedicated-server SquadGame.log.',
        default: ''
      },
      token: {
        required: false,
        description: 'Optional bearer token sent as Authorization header.',
        default: ''
      },
      pollMs: {
        required: false,
        description: 'How often (ms) to check the log for new lines.',
        default: 1000
      },
      fromStart: {
        required: false,
        description: 'Ship rounds already present in the log on startup.',
        default: false
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);
    this.ingestUrl = `${String(this.options.aarUrl).replace(/\/$/, '')}/api/ingest`;
    this.source = path.basename(this.options.logFilePath || 'SquadGame.log');
    this.offset = 0;
    this.remainder = '';
    this.cur = [];
    this.curHasStart = false;
    this.curEnded = false;
    this.pumping = false;
    this.timer = null;
    this.pump = this.pump.bind(this);
  }

  async mount() {
    if (!this.options.logFilePath) {
      this.verbose(1, 'SquadAAR: logFilePath not set — plugin idle.');
      return;
    }
    if (!this.options.fromStart) {
      try {
        this.offset = fs.statSync(this.options.logFilePath).size;
      } catch {
        this.offset = 0;
      }
    }
    this.verbose(1, `SquadAAR: shipping ${this.options.logFilePath} -> ${this.ingestUrl}`);
    this.timer = setInterval(this.pump, Number(this.options.pollMs) || 1000);
  }

  async unmount() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  static isRoundStart(l) {
    return l.includes('LogWorld: Bringing World') && !l.includes('TransitionMap');
  }

  static isRoundEnd(l) {
    return (
      l.includes('has won the match with') ||
      l.includes('Match State Changed from InProgress to WaitingPostMatch')
    );
  }

  async ship(lines) {
    const text = lines.join('\n') + '\n';
    try {
      const res = await fetch(this.ingestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'x-source': this.source,
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {})
        },
        body: text
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) this.verbose(1, `SquadAAR: ingest failed ${res.status} ${j.error ?? ''}`);
      else if (j.ingested) this.verbose(1, `SquadAAR: ingested ${j.ingested} round(s)`);
    } catch (e) {
      this.verbose(1, `SquadAAR: ship error ${e.message}`);
    }
  }

  feed(text) {
    this.remainder += text;
    const parts = this.remainder.split(/\r?\n/);
    this.remainder = parts.pop() ?? '';
    const completed = [];
    for (const line of parts) {
      if (!line) continue;
      if (SquadAAR.isRoundStart(line)) {
        if (this.curHasStart && this.cur.length) {
          completed.push(this.cur);
          this.cur = [];
        }
        this.cur = [line];
        this.curHasStart = true;
        this.curEnded = false;
        continue;
      }
      this.cur.push(line);
      if (this.curHasStart && !this.curEnded && SquadAAR.isRoundEnd(line)) {
        this.curEnded = true;
        completed.push(this.cur);
        this.cur = [];
        this.curHasStart = false;
      }
    }
    return completed;
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let size;
      try {
        size = fs.statSync(this.options.logFilePath).size;
      } catch {
        return;
      }
      if (size < this.offset) {
        this.offset = 0;
        this.remainder = '';
      }
      if (size === this.offset) return;
      const fd = fs.openSync(this.options.logFilePath, 'r');
      try {
        const MAX = 4 * 1024 * 1024;
        while (this.offset < size) {
          const len = Math.min(MAX, size - this.offset);
          const buf = Buffer.allocUnsafe(len);
          const read = fs.readSync(fd, buf, 0, len, this.offset);
          if (read <= 0) break;
          this.offset += read;
          const completed = this.feed(buf.toString('utf8', 0, read));
          for (const lines of completed) await this.ship(lines);
        }
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      this.pumping = false;
    }
  }
}
