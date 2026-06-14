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
    this.opts = { basemap: true, terrain: true, contours: false, elevation: false, tracers: true, animate: true, sightlines: false, impacts: true, suspiciousOnly: false, names: false };
    this._minimap = null;
    this.selected = null; // { kind:'player'|'vehicle', id }
    this.follow = false;
    this.highlightProj = null;
    this.highlightEngagement = null; // a DeathReport
    this._dpr = 1;
    this._size = 0;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  setRound(bundle) {
    this.bundle = bundle;
    this.snaps = bundle.snapshots;
    this.step = this.snaps.length > 1 ? this.snaps[1].tMs - this.snaps[0].tMs : 1000;
    this._prepTerrain();
    this._loadMinimap();
    this._resize();
  }

  _loadMinimap() {
    this._minimap = null;
    this.hasMinimap = false;
    const key = this.bundle?.meta?.assetKey;
    if (!key) return;
    const exts = ['basemap.webp', 'basemap.png', 'basemap.jpg'];
    const tryNext = (i) => {
      if (i >= exts.length) return;
      const img = new Image();
      img.onload = () => { this._minimap = img; this.hasMinimap = true; };
      img.onerror = () => tryNext(i + 1);
      img.src = `/assets/maps/${key}/${exts[i]}`;
    };
    tryNext(0);
  }

  _prepTerrain() {
    const t = this.bundle?.terrain;
    this._hillshade = null; this._heat = null; this._contours = null;
    if (!t || !t.heights || !t.grid) return;
    const g = t.grid;
    const h = (cx, cy) => t.heights[Math.min(g - 1, Math.max(0, cy)) * g + Math.min(g - 1, Math.max(0, cx))];
    const range = t.max - t.min || 1;
    const cellM = (t.maxX - t.minX) / 100 / g; // metres per cell
    // light from NW
    const L = (() => { const v = [-1, -1, 1.4]; const n = Math.hypot(...v); return v.map((x) => x / n); })();
    const shadeImg = new ImageData(g, g);
    const heatImg = new ImageData(g, g);
    for (let py = 0; py < g; py++) {
      const cy = g - 1 - py; // flip Y to match worldToNorm
      for (let px = 0; px < g; px++) {
        const dzdx = (h(px + 1, cy) - h(px - 1, cy)) / (2 * cellM);
        const dzdy = (h(px, cy + 1) - h(px, cy - 1)) / (2 * cellM);
        const nx = -dzdx, ny = dzdy, nz = 1;
        const nl = Math.hypot(nx, ny, nz);
        const shade = Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / nl); // 0..1
        const base = 14 + shade * 30; // dark theme
        const i = (py * g + px) * 4;
        shadeImg.data[i] = base * 0.9; shadeImg.data[i + 1] = base; shadeImg.data[i + 2] = base * 1.15; shadeImg.data[i + 3] = 255;
        // elevation heat (blue->green->yellow->red)
        const e = (h(px, cy) - t.min) / range;
        const [r, gg, b] = ramp(e);
        heatImg.data[i] = r; heatImg.data[i + 1] = gg; heatImg.data[i + 2] = b; heatImg.data[i + 3] = 150;
      }
    }
    this._hillshade = imgToCanvas(shadeImg);
    this._heat = imgToCanvas(heatImg);
    // contour segments (marching squares) in normalized coords
    const levels = 9;
    const segs = [];
    for (let li = 1; li < levels; li++) {
      const lv = t.min + (range * li) / levels;
      for (let cy = 0; cy < g - 1; cy++) {
        for (let cx = 0; cx < g - 1; cx++) {
          const tl = h(cx, cy + 1), tr = h(cx + 1, cy + 1), br = h(cx + 1, cy), bl = h(cx, cy);
          marchCell(cx, cy, g, lv, tl, tr, br, bl, segs);
        }
      }
    }
    this._contours = segs;
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
    ctx.fillStyle = '#070b10';
    ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    const haveBase = this._minimap && this.opts.basemap;
    if (haveBase) ctx.drawImage(this._minimap, 0, 0, S, S);
    if (this.opts.terrain && this._hillshade) { ctx.globalAlpha = haveBase ? 0.3 : 1; ctx.drawImage(this._hillshade, 0, 0, S, S); ctx.globalAlpha = 1; }
    if (this.opts.elevation && this._heat) { ctx.globalAlpha = 0.55; ctx.drawImage(this._heat, 0, 0, S, S); ctx.globalAlpha = 1; }
    this._drawGrid();
    if (this.opts.contours && this._contours) this._drawContours();
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
    if (this.highlightEngagement) this._drawEngagement(this.highlightEngagement);
    this._lastPlayers = players;
    this._lastVehicles = vehicles;

    // follow selected -> nothing to pan (full map), but highlight handled in draw
  }

  _drawContours() {
    const ctx = this.ctx, S = this._size;
    ctx.strokeStyle = 'rgba(150,200,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const s of this._contours) { ctx.moveTo(s[0] * S, s[1] * S); ctx.lineTo(s[2] * S, s[3] * S); }
    ctx.stroke();
  }

  _drawGrid() {
    const ctx = this.ctx, S = this._size;
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

  _travelMs(pr) {
    if (pr._travel != null) return pr._travel;
    const speed = pr.speed > 0 ? pr.speed : pr.weaponFamily === 'at' ? 300 : pr.weaponFamily === 'tank' ? 1200 : pr.weaponFamily === 'grenade' ? 80 : 800;
    pr._travel = Math.max(40, (pr.rangeM / speed) * 1000);
    return pr._travel;
  }

  _drawProjectiles(timeMs) {
    const ctx = this.ctx;
    const linger = 2600; // how long a tracer/impact stays after the bullet lands
    const sel = this.selected && this.selected.kind === 'player' ? this.selected.id : null;
    for (const pr of this.bundle.analysis.projectiles) {
      const susp = pr.plausibility.score < this.bundle.analysis.threshold;
      if (this.opts.suspiciousOnly && !susp) continue;
      const travel = this._travelMs(pr);
      const tEnd = pr.tMs + travel;
      const involved = sel && (pr.shooterEOSID === sel || pr.victimEOSID === sel);
      if (timeMs < pr.tMs || timeMs > tEnd + linger) continue;

      const fx = this.px(pr.from), fy = this.py(pr.from);
      const tx = this.px(pr.to), ty = this.py(pr.to);
      const indirect = pr.weaponFamily === 'explosive' || pr.weaponFamily === 'grenade';
      const baseCol = susp ? '#ff5d5d' : indirect ? '#fb923c' : involved ? '#7dd3fc' : '#fcd34d';
      if (indirect) { this._drawIndirect(pr, timeMs, tEnd, linger, baseCol); continue; }

      // optional full sightline (faint), so you can see the shooter->victim line
      if (this.opts.sightlines || involved) {
        ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(tx, ty);
        ctx.strokeStyle = hexA(baseCol, involved ? 0.35 : 0.18); ctx.lineWidth = 1; ctx.stroke();
      }

      if (timeMs <= tEnd) {
        // --- bullet in flight ---
        const prog = this.opts.animate ? (timeMs - pr.tMs) / travel : 1;
        const head = { x: fx + (tx - fx) * prog, y: fy + (ty - fy) * prog };
        const tailP = Math.max(0, prog - 0.32);
        const tail = { x: fx + (tx - fx) * tailP, y: fy + (ty - fy) * tailP };
        // tracer streak
        const grad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
        grad.addColorStop(0, hexA(baseCol, 0));
        grad.addColorStop(1, hexA(baseCol, susp ? 1 : 0.9));
        ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(head.x, head.y);
        ctx.strokeStyle = grad; ctx.lineWidth = susp ? 2.4 : 1.6; ctx.stroke();
        // bullet head
        ctx.beginPath(); ctx.arc(head.x, head.y, susp ? 2.6 : 2, 0, Math.PI * 2);
        ctx.fillStyle = '#fffbe6'; ctx.fill();
        // muzzle flash
        if (timeMs - pr.tMs < 110) {
          ctx.beginPath(); ctx.arc(fx, fy, 4, 0, Math.PI * 2);
          ctx.fillStyle = hexA('#ffe08a', 0.9 * (1 - (timeMs - pr.tMs) / 110)); ctx.fill();
        }
      } else if (this.opts.impacts) {
        // --- impact / where it landed ---
        const age = timeMs - tEnd;
        const a = 1 - age / linger;
        // faint spent tracer so you still see where the bullet went
        ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(tx, ty);
        ctx.strokeStyle = hexA(baseCol, 0.12 * a); ctx.lineWidth = 1; ctx.stroke();
        if (pr.hit && pr.victimEOSID) this._hitBurst(tx, ty, a, susp, age);
        else this._missPuff(tx, ty, a);
      }
    }

    if (this.highlightProj) {
      const pr = this.highlightProj;
      ctx.beginPath(); ctx.moveTo(this.px(pr.from), this.py(pr.from)); ctx.lineTo(this.px(pr.to), this.py(pr.to));
      ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      for (const pt of [pr.from, pr.to]) { ctx.beginPath(); ctx.arc(this.px(pt), this.py(pt), 4, 0, Math.PI * 2); ctx.fillStyle = '#ff3b3b'; ctx.fill(); }
    }
  }

  _drawEngagement(d) {
    const ctx = this.ctx;
    const from = d.from || d.killerPos, to = d.to || d.victimPos;
    if (from && to) {
      const fx = this.px(from), fy = this.py(from), tx = this.px(to), ty = this.py(to);
      // killing-shot sightline
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(tx, ty);
      ctx.strokeStyle = d.hasLineOfSight === false || (d.plausibility && d.plausibility.score < 0.5) ? '#ff5d5d' : '#fbbf24';
      ctx.lineWidth = 2.5; ctx.setLineDash([7, 5]); ctx.stroke(); ctx.setLineDash([]);
      // distance label at midpoint
      if (d.distanceM != null) {
        ctx.fillStyle = '#0b0f14'; const mx = (fx + tx) / 2, my = (fy + ty) / 2;
        const txt = `${d.distanceM} m`;
        ctx.font = 'bold 11px ui-sans-serif'; const w = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(7,11,16,.8)'; ctx.fillRect(mx - w / 2 - 4, my - 8, w + 8, 15);
        ctx.fillStyle = '#fde68a'; ctx.fillText(txt, mx - w / 2, my + 3);
      }
    }
    // killer marker
    if (d.killerPos) this._tagMarker(d.killerPos, d.killerName || 'killer', this.color(d.killerTeam), '➤');
    // victim marker
    if (d.victimPos) this._tagMarker(d.victimPos, d.victimName || 'victim', '#ffffff', '✖');
    // contributors (assist damage)
    for (const ct of d.contributors || []) {
      if (ct.eosID === d.killerEOSID) continue;
      const p = (this._lastPlayers || []).find((q) => q.eosID === ct.eosID);
      if (p) { const x = this.px(p.pos), y = this.py(p.pos); ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = 1.5; ctx.stroke(); }
    }
  }
  color(t) { return t === 1 ? '#3b82f6' : t === 2 ? '#ef4444' : '#94a3b8'; }
  _tagMarker(pos, label, color, glyph) {
    const ctx = this.ctx, x = this.px(pos), y = this.py(pos);
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = color; ctx.font = 'bold 11px ui-sans-serif'; ctx.fillText(glyph, x - 4, y + 4);
    ctx.fillStyle = 'rgba(7,11,16,.8)';
    const w = ctx.measureText(label).width;
    ctx.fillRect(x + 10, y - 16, w + 8, 15);
    ctx.fillStyle = color; ctx.fillText(label, x + 14, y - 5);
  }

  // indirect fire: lobbed arc + blast radius at impact
  _drawIndirect(pr, timeMs, tEnd, linger, col) {
    const ctx = this.ctx;
    const fx = this.px(pr.from), fy = this.py(pr.from), tx = this.px(pr.to), ty = this.py(pr.to);
    const sizeM = this.bundle.meta.sizeMeters || 3000;
    const radius = ((pr.weaponFamily === 'explosive' ? 35 : 18) / sizeM) * this._size;
    // bow the path perpendicular to fake a lobbed trajectory in top-down
    const mx = (fx + tx) / 2, my = (fy + ty) / 2;
    const dx = tx - fx, dy = ty - fy, len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(40, len * 0.18);
    const ctrl = { x: mx - (dy / len) * bow, y: my + (dx / len) * bow };
    if (timeMs <= tEnd) {
      const prog = this.opts.animate ? (timeMs - pr.tMs) / (tEnd - pr.tMs) : 1;
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.quadraticCurveTo(ctrl.x, ctrl.y, tx, ty);
      ctx.strokeStyle = hexA(col, 0.5); ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      // shell along the curve
      const t = prog, it = 1 - t;
      const sx = it * it * fx + 2 * it * t * ctrl.x + t * t * tx;
      const sy = it * it * fy + 2 * it * t * ctrl.y + t * t * ty;
      ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI * 2); ctx.fillStyle = '#ffd9a0'; ctx.fill();
    } else if (this.opts.impacts) {
      const a = 1 - (timeMs - tEnd) / linger;
      ctx.beginPath(); ctx.arc(tx, ty, radius, 0, Math.PI * 2);
      ctx.fillStyle = hexA(col, 0.18 * a); ctx.fill();
      ctx.strokeStyle = hexA(col, 0.8 * a); ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = hexA('#fff1d6', a); ctx.beginPath(); ctx.arc(tx, ty, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  _hitBurst(x, y, a, susp, age) {
    const ctx = this.ctx;
    const col = susp ? '#ff5d5d' : '#fb7185';
    const r = 3 + Math.min(8, age / 120); // expanding ring
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(col, 0.8 * a); ctx.lineWidth = 2; ctx.stroke();
    // spark cross
    ctx.strokeStyle = hexA('#fff1f1', a); ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const ang = (i * Math.PI) / 2 + Math.PI / 4;
      ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ang) * 5, y + Math.sin(ang) * 5);
    }
    ctx.stroke();
  }
  _missPuff(x, y, a) {
    const ctx = this.ctx;
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = hexA('#9aa7b4', 0.5 * a); ctx.fill();
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
      } else if (ev.kind === 'explosion') {
        const sizeM = this.bundle.meta.sizeMeters || 3000;
        const rad = (((ev.radiusM || 35)) / sizeM) * this._size;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.strokeStyle = hexA('#fb923c', 0.6 * a); ctx.lineWidth = 1.5; ctx.stroke();
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

function ramp(t) {
  // blue -> cyan -> green -> yellow -> red
  const stops = [[40, 80, 160], [40, 160, 170], [70, 170, 80], [210, 190, 70], [200, 80, 60]];
  const x = Math.max(0, Math.min(0.999, t)) * (stops.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
function imgToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}
// marching squares for one cell -> push normalized segment(s) (Y flipped to match draw)
function marchCell(cx, cy, g, lv, tl, tr, br, bl, segs) {
  // corners: bl=(cx,cy) tl=(cx,cy+1) tr=(cx+1,cy+1) br=(cx+1,cy)
  const idx = (bl > lv ? 1 : 0) | (br > lv ? 2 : 0) | (tr > lv ? 4 : 0) | (tl > lv ? 8 : 0);
  if (idx === 0 || idx === 15) return;
  const ix = (a, b, va, vb) => a + ((lv - va) / (vb - va)) * (b - a);
  // edge points in grid coords (x right, y up)
  const bottom = [ix(cx, cx + 1, bl, br), cy];
  const top = [ix(cx, cx + 1, tl, tr), cy + 1];
  const left = [cx, ix(cy, cy + 1, bl, tl)];
  const right = [cx + 1, ix(cy, cy + 1, br, tr)];
  const norm = (p) => [p[0] / (g - 1), 1 - p[1] / (g - 1)]; // flip Y
  const seg = (p, q) => { const a = norm(p), b = norm(q); segs.push([a[0], a[1], b[0], b[1]]); };
  switch (idx) {
    case 1: case 14: seg(left, bottom); break;
    case 2: case 13: seg(bottom, right); break;
    case 3: case 12: seg(left, right); break;
    case 4: case 11: seg(top, right); break;
    case 6: case 9: seg(top, bottom); break;
    case 7: case 8: seg(left, top); break;
    case 5: seg(left, top); seg(bottom, right); break;
    case 10: seg(left, bottom); seg(top, right); break;
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
