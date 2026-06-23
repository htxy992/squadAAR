import BasePlugin from './base-plugin.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SquadAAR — SquadJS emitter plugin.
 *
 * On a vanilla (even unlicensed) Squad server the dedicated-server log carries
 * combat, identity and the round result, but NOT player team/squad/role — and no
 * positions at all (the engine never writes coordinates to the log, and RCON has
 * no position command). This plugin turns SquadJS into the telemetry *emitter*
 * for everything that IS reachable without a server-side mod:
 *
 *   1. it tails the SquadGame.log and ships each completed round verbatim
 *      (kills/wounds/revives/damage/possess/round-result — these parse exactly),
 *   2. it snapshots the live roster over SquadJS's RCON connection and injects
 *      `LogSquadStats: PlayerRole: … team=<n> squad=<n>` lines into that round,
 *      so SquadAAR can put every player on the right team/squad and attribute
 *      SquadPoints/SquadElo to the right class pool.
 *
 * Result on a vanilla server: a complete scoreboard, SquadPoints, SquadElo,
 * leaderboards and the derived kill / plausibility analysis. There is still no
 * map movement or CQB replay — those need real positions, which require a
 * licensed server-side plugin emitting PlayerPos (see docs/LOG_FORMAT.md).
 *
 * Drop this file in SquadJS's `squad-server/plugins/` directory and add:
 *
 *   {
 *     "plugin": "SquadAAR",
 *     "enabled": true,
 *     "aarUrl": "http://localhost:8787",
 *     "logFilePath": "/path/to/SquadGame/Saved/Logs/SquadGame.log",
 *     "token": "",
 *     "pollMs": 1000,
 *     "rolePollMs": 60000
 *   }
 */
export default class SquadAAR extends BasePlugin {
  static get description() {
    return 'Emits completed rounds (log + RCON roster) from a Squad server to a SquadAAR instance.';
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
      rolePollMs: {
        required: false,
        description:
          'How often (ms) to snapshot the RCON roster into the active round as team/squad/role telemetry. 0 disables roster enrichment (ship the raw log only).',
        default: 60000
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
    this.roleTimer = null;
    this.pump = this.pump.bind(this);
    this.snapshotRoster = this.snapshotRoster.bind(this);
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
    const rolePollMs = Number(this.options.rolePollMs);
    if (rolePollMs > 0) this.roleTimer = setInterval(this.snapshotRoster, rolePollMs);
  }

  async unmount() {
    if (this.timer) clearInterval(this.timer);
    if (this.roleTimer) clearInterval(this.roleTimer);
    this.timer = null;
    this.roleTimer = null;
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

  /** Squad-style UTC log timestamp: YYYY.MM.DD-HH.MM.SS:mmm */
  static stamp(d = new Date()) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return (
      `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}-` +
      `${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}:${p(d.getUTCMilliseconds(), 3)}`
    );
  }

  /**
   * Read the live roster off SquadJS (kept current via RCON) and inject one
   * `LogSquadStats: PlayerRole` line per assigned player into the active round.
   * No-op between rounds or when RCON has no roster yet — combat shipping is
   * unaffected either way.
   */
  snapshotRoster() {
    if (!this.curHasStart || this.curEnded) return;
    const players = this.server && Array.isArray(this.server.players) ? this.server.players : [];
    if (!players.length) return;
    const ts = `[${SquadAAR.stamp()}][ 0]`;
    let added = 0;
    for (const pl of players) {
      const eos = pl && (pl.eosID || pl.EOSID || (pl.onlineIDs && pl.onlineIDs.eos));
      const role = pl && pl.role;
      if (!eos || !role) continue; // unassigned / loading players carry no role
      const team = Number(pl.teamID);
      const squad = Number(pl.squadID);
      const lead = pl.isLeader ? 1 : 0;
      const teamPart = Number.isFinite(team) ? ` team=${team}` : '';
      const squadPart = Number.isFinite(squad) ? ` squad=${squad}` : ' squad=0';
      this.cur.push(`${ts}LogSquadStats: PlayerRole: eos=${eos} role=${role} lead=${lead}${teamPart}${squadPart}`);
      added++;
    }
    if (added) this.verbose(2, `SquadAAR: roster snapshot — ${added} player role line(s)`);
    this.snapshotSquads();
  }

  /**
   * Inject a `LogSquadStats: SquadName` line for each known squad so the
   * parser can build a squadID → name mapping without relying on SquadCreated
   * events (which are only emitted by extended telemetry plugins).
   */
  snapshotSquads() {
    if (!this.curHasStart || this.curEnded) return;
    const squads = this.server && Array.isArray(this.server.squads) ? this.server.squads : [];
    if (!squads.length) return;
    const ts = `[${SquadAAR.stamp()}][ 0]`;
    for (const sq of squads) {
      const team = Number(sq.teamID);
      const squadID = Number(sq.squadID);
      const name = sq.squadName || sq.name;
      if (!name || !Number.isFinite(squadID)) continue;
      this.cur.push(`${ts}LogSquadStats: SquadName: team=${team} squad=${squadID} name=${name.replace(/\s+/g, '_')}`);
    }
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
        // capture the roster at kickoff so even short rounds get team/squad data
        this.snapshotRoster();
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
