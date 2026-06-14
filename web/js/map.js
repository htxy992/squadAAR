import { teamColor } from './util.js';

/**
 * Canvas renderer for the AAR map replay. Consumes a round bundle and draws an
 * interpolated snapshot (players, vehicles, FOBs, flags), plus projectile
 * tracers and timed event markers. Pure 2D canvas — no external libraries.
 */
export class MapRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bundle = null;
    this.opts = { tracers: true, suspiciousOnly: false, names: false };
    this.selected = null; // { kind:'player'|'vehicle', id }
    this.follow = false;
    this.highlightProj = null;
    this._dpr = 1;
    this._size = 0;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  setRound(bundle) {
    this.bundle = bundle;
    this.snaps = bundle.snapshots;
    this.step = this.snaps.length > 1 ? this.snaps[1].tMs - this.snaps[0].tMs : 1000;
    this._resize();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const size = Math.max(200, Math.floor(rect.width));
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this._dpr = dpr;
    this._size = size;
  }

  // normalized [0,1] -> canvas px (square)
  px(n) { return n.nx * this._size; }
  py(n) { return n.ny * this._size; }

  /** Interpolated snapshot at relative time ms. */
  sampleAt(timeMs) {
    const snaps = this.snaps;
    if (!snaps || !snaps.length) return null;
    const f = timeMs / this.step;
    const i0 = Math.max(0, Math.min(snaps.length - 1, Math.floor(f)));
    const i1 = Math.min(snaps.length - 1, i0 + 1);
    const a = snaps[i0], b = snaps[i1];
    const t = Math.max(0, Math.min(1, f - i0));
    return { a, b, t };
  }

  _lerp(a, b, t) { return a + (b - a) * t; }

  _interpPlayers(s) {
    const { a, b, t } = s;
    const bm = new Map(b.players.map((p) => [p.eosID, p]));
    const out = [];
    for (const p of a.players) {
      const q = bm.get(p.eosID);
      if (q) {
        out.push({ ...p, pos: { nx: this._lerp(p.pos.nx, q.pos.nx, t), ny: this._lerp(p.pos.ny, q.pos.ny, t) }, yaw: this._lerpAngle(p.yaw, q.yaw, t), health: this._lerp(p.health, q.health, t) });
      } else if (t < 0.5) out.push(p);
    }
    return out;
  }
  _interpVehicles(s) {
    const { a, b, t } = s;
    const bm = new Map(b.vehicles.map((v) => [v.id, v]));
    const out = [];
    for (const v of a.vehicles) {
      const q = bm.get(v.id);
      if (q) out.push({ ...v, pos: { nx: this._lerp(v.pos.nx, q.pos.nx, t), ny: this._lerp(v.pos.ny, q.pos.ny, t) }, yaw: this._lerpAngle(v.yaw, q.yaw, t), turretYaw: this._lerpAngle(v.turretYaw ?? 0, q.turretYaw ?? 0, t) });
      else if (t < 0.5) out.push(v);
    }
    return out;
  }
  _lerpAngle(a, b, t) {
    let d = ((b - a + 540) % 360) - 180;
    return a + d * t;
  }

  draw(timeMs) {
    const ctx = this.ctx;
    const S = this._size;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    if (!this.bundle) return;
    this._drawGrid();
    const s = this.sampleAt(timeMs);
    const players = this._interpPlayers(s);
    const vehicles = this._interpVehicles(s);
    const snap = s.a;

    this._drawFlags(snap.flags);
    this._drawFobs(snap.fobs);
    if (this.opts.tracers) this._drawProjectiles(timeMs);
    this._drawEventMarkers(timeMs);
    for (const v of vehicles) this._drawVehicle(v);
    for (const p of players) this._drawPlayer(p);
    this._lastPlayers = players;
    this._lastVehicles = vehicles;

    // follow selected -> nothing to pan (full map), but highlight handled in draw
  }

  _drawGrid() {
    const ctx = this.ctx, S = this._size;
    ctx.fillStyle = '#070b10';
    ctx.fillRect(0, 0, S, S);
    const sizeM = this.bundle.meta.sizeMeters || 3000;
    const cells = Math.max(4, Math.round(sizeM / 300)); // 300m keypads
    ctx.strokeStyle = '#16212d';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#33465a';
    ctx.font = '10px ui-monospace, monospace';
    for (let i = 0; i <= cells; i++) {
      const x = (i / cells) * S;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, x); ctx.lineTo(S, x); ctx.stroke();
      if (i < cells) {
        ctx.fillText(String.fromCharCode(65 + i), (i / cells) * S + 3, 11);
        ctx.fillText(String(i + 1), 2, (i / cells) * S + 13);
      }
    }
  }

  _drawFlags(flags) {
    const ctx = this.ctx;
    const sizeM = this.bundle.meta.sizeMeters || 3000;
    const rpx = (100 / sizeM) * this._size; // ~100m capture radius
    for (const f of flags || []) {
      const x = this.px(f.pos), y = this.py(f.pos);
      const col = teamColor(f.team, true);
      ctx.beginPath(); ctx.arc(x, y, Math.max(10, rpx), 0, Math.PI * 2);
      ctx.fillStyle = hexA(col, 0.08); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = hexA(col, 0.55); ctx.stroke();
      // progress arc
      if (f.progress > 0 && f.progress < 1) {
        ctx.beginPath(); ctx.arc(x, y, Math.max(10, rpx), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f.progress);
        ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
      }
      ctx.fillStyle = '#cdd9e5'; ctx.font = '11px ui-sans-serif';
      ctx.fillText(f.name.replace(/_/g, ' '), x + 8, y - 8);
    }
  }

  _drawFobs(fobs) {
    const ctx = this.ctx;
    for (const f of fobs || []) {
      const x = this.px(f.pos), y = this.py(f.pos), col = teamColor(f.team);
      ctx.fillStyle = col;
      ctx.fillRect(x - 5, y - 5, 10, 10);
      ctx.strokeStyle = '#0b0f14'; ctx.lineWidth = 1; ctx.strokeRect(x - 5, y - 5, 10, 10);
      ctx.fillStyle = '#0b0f14'; ctx.font = 'bold 8px ui-sans-serif';
      ctx.fillText('F', x - 2.5, y + 3);
    }
  }

  _drawVehicle(v) {
    const ctx = this.ctx;
    const x = this.px(v.pos), y = this.py(v.pos), col = teamColor(v.team, true);
    const sel = this.selected && this.selected.kind === 'vehicle' && this.selected.id === v.id;
    const r = 7;
    ctx.save();
    ctx.translate(x, y);
    // hull
    ctx.rotate((v.yaw * Math.PI) / 180);
    ctx.fillStyle = hexA(col, 0.9);
    ctx.strokeStyle = sel ? '#fff' : '#0b0f14';
    ctx.lineWidth = sel ? 2 : 1;
    roundRect(ctx, -r, -r * 0.7, r * 2, r * 1.4, 2);
    ctx.fill(); ctx.stroke();
    ctx.restore();
    // turret line
    if (v.turretYaw != null) {
      ctx.save(); ctx.translate(x, y); ctx.rotate((v.turretYaw * Math.PI) / 180);
      ctx.strokeStyle = '#e5edf5'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r * 2.2, 0); ctx.stroke();
      ctx.restore();
    }
    // health ring
    const hp = v.maxHealth ? v.health / v.maxHealth : 1;
    ctx.beginPath(); ctx.arc(x, y, r + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, hp));
    ctx.strokeStyle = hp > 0.5 ? '#34d399' : hp > 0.25 ? '#fbbf24' : '#f87171';
    ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#9fb1c4'; ctx.font = '9px ui-sans-serif';
    ctx.fillText(v.pool || v.type, x + r + 6, y - r);
  }

  _drawPlayer(p) {
    const ctx = this.ctx;
    const x = this.px(p.pos), y = this.py(p.pos);
    const col = teamColor(p.team);
    const sel = this.selected && this.selected.kind === 'player' && this.selected.id === p.eosID;
    // view direction
    ctx.save(); ctx.translate(x, y); ctx.rotate((p.yaw * Math.PI) / 180);
    ctx.strokeStyle = hexA(teamColor(p.team, true), 0.8); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(10, 0); ctx.stroke();
    ctx.restore();
    // body
    ctx.beginPath(); ctx.arc(x, y, sel ? 5 : 3.4, 0, Math.PI * 2);
    ctx.fillStyle = p.state === 'wound' ? '#fbbf24' : col;
    ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = sel ? '#fff' : '#0b0f14'; ctx.stroke();
    if (sel) {
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
    }
    if (this.opts.names || sel) {
      ctx.fillStyle = '#cdd9e5'; ctx.font = '10px ui-sans-serif';
      ctx.fillText(p.name, x + 6, y - 5);
    }
  }

  _drawProjectiles(timeMs) {
    const ctx = this.ctx;
    const win = 4000;
    for (const pr of this.bundle.analysis.projectiles) {
      const age = timeMs - pr.tMs;
      if (age < 0 || age > win) continue;
      if (this.opts.suspiciousOnly && pr.plausibility.score >= this.bundle.analysis.threshold) continue;
      const alpha = 1 - age / win;
      const susp = pr.plausibility.score < this.bundle.analysis.threshold;
      ctx.beginPath();
      ctx.moveTo(this.px(pr.from), this.py(pr.from));
      ctx.lineTo(this.px(pr.to), this.py(pr.to));
      ctx.strokeStyle = hexA(susp ? '#f87171' : '#fcd34d', alpha * (susp ? 0.95 : 0.55));
      ctx.lineWidth = susp ? 2.2 : 1;
      ctx.stroke();
    }
    if (this.highlightProj) {
      const pr = this.highlightProj;
      ctx.beginPath(); ctx.moveTo(this.px(pr.from), this.py(pr.from)); ctx.lineTo(this.px(pr.to), this.py(pr.to));
      ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      for (const pt of [pr.from, pr.to]) { ctx.beginPath(); ctx.arc(this.px(pt), this.py(pt), 4, 0, Math.PI * 2); ctx.fillStyle = '#ff3b3b'; ctx.fill(); }
    }
  }

  _drawEventMarkers(timeMs) {
    const ctx = this.ctx;
    const win = 6000;
    for (const ev of this.bundle.mapEvents) {
      if (!ev.pos) continue;
      const age = timeMs - ev.tMs;
      if (age < 0 || age > win) continue;
      const a = 1 - age / win;
      const x = this.px(ev.pos), y = this.py(ev.pos);
      if (ev.kind === 'kill' || ev.kind === 'teamkill' || ev.kind === 'death') {
        ctx.strokeStyle = hexA(ev.kind === 'teamkill' ? '#ffffff' : '#f87171', a);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
      } else if (ev.kind === 'fob_destroyed' || ev.kind === 'vehicle_destroyed') {
        ctx.fillStyle = hexA(ev.kind === 'fob_destroyed' ? '#c084fc' : '#fb923c', a);
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0b0f14'; ctx.font = 'bold 9px ui-sans-serif'; ctx.fillText('✸', x - 4, y + 3);
      } else if (ev.kind === 'flag_captured') {
        ctx.fillStyle = hexA('#f5b942', a);
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  /** find nearest entity to a canvas click for selection */
  pick(cx, cy) {
    let best = null, bestD = 16 * 16;
    for (const p of this._lastPlayers || []) {
      const dx = this.px(p.pos) - cx, dy = this.py(p.pos) - cy, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = { kind: 'player', id: p.eosID, entity: p }; }
    }
    for (const v of this._lastVehicles || []) {
      const dx = this.px(v.pos) - cx, dy = this.py(v.pos) - cy, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = { kind: 'vehicle', id: v.id, entity: v }; }
    }
    return best;
  }
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
