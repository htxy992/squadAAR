import { getJSON, el, clear, fmtDate, teamColor, signed } from './util.js';

export async function renderPlayer(view, eosID) {
  clear(view).append(el('div', { class: 'loading', text: 'Loading player…' }));
  const data = await getJSON(`api/players/${encodeURIComponent(eosID)}`).catch(() => null);
  if (!data || (!data.elo && !data.history.length)) { clear(view).append(el('div', { class: 'loading', text: 'Player not found.' })); return; }
  clear(view);
  const elo = data.elo;
  const agg = data.aggregate;

  view.append(el('span', { class: 'back', text: '← Leaderboard', onclick: () => (location.hash = '#/leaderboard') }));
  view.append(el('h1', { class: 'page-title', text: elo?.name ?? eosID.slice(0, 8) }));

  // top cards: global elo + key aggregates
  const cqb = data.cqb;
  const cards = el('div', { class: 'rounds-grid' });
  cards.append(card('Global Elo', elo ? Math.round(elo.global) : '—', `${elo?.games ?? 0} rated rounds`));
  cards.append(card('Rounds', agg.rounds, `${Math.round(agg.points)} total points`));
  cards.append(card('K / W / D', `${agg.kills} / ${agg.wounds} / ${agg.deaths}`, `${agg.revives} revives`));
  if (cqb && cqb.duels > 0) {
    const wr = cqb.won + cqb.lost > 0 ? Math.round((cqb.won / (cqb.won + cqb.lost)) * 100) : 0;
    cards.append(card('CQB duels', `${cqb.won}–${cqb.lost}`, `${wr}% win${cqb.traded ? ` · ${cqb.traded} traded` : ''}`));
  } else {
    cards.append(card('Longest kill', `${agg.longestKillM} m`, `dmg ${Math.round(agg.damageInf)} inf · ${Math.round(agg.damageVeh)} veh`));
  }
  view.append(cards);

  // CQB / aim-recoil coaching panel
  if (cqb) renderCqbPanel(view, cqb, data.history);

  // pool elos
  if (elo && elo.pools && Object.keys(elo.pools).length) {
    const panel = el('div', { class: 'panel' }, [el('h3', { text: 'Class / vehicle pool Elo' })]);
    const t = el('table');
    t.append(el('tr', {}, ['Pool', 'Elo', 'Games'].map((h, i) => el('th', { class: i ? 'num' : '' }, h))));
    for (const [pool, val] of Object.entries(elo.pools).sort((a, b) => b[1] - a[1])) {
      t.append(el('tr', {}, [el('td', { text: pool }), el('td', { class: 'num', text: Math.round(val) }), el('td', { class: 'num', text: elo.poolGames?.[pool] ?? 0 })]));
    }
    panel.append(t);
    view.append(panel);
  }

  // global elo sparkline over round history (chronological)
  const hist = [...data.history].sort((a, b) => a.startTime - b.startTime).filter((h) => h.globalAfter != null);
  if (hist.length >= 2) {
    const panel = el('div', { class: 'panel' }, [el('h3', { text: 'Global Elo over time' })]);
    const cv = el('canvas', { class: 'spark', width: 760, height: 90, style: 'width:100%;height:90px' });
    panel.append(cv);
    view.append(panel);
    drawSpark(cv, hist.map((h) => h.globalAfter));
  }

  // round history table
  const panel = el('div', { class: 'panel' }, [el('h3', { text: 'Round history' })]);
  const table = el('table');
  table.append(el('tr', {}, ['Date', 'Map', 'T', 'Pool', 'Pts', 'K', 'W', 'D', 'ΔElo'].map((h, i) => el('th', { class: i >= 4 ? 'num' : '' }, h))));
  for (const h of data.history) {
    table.append(el('tr', { class: 'click', onclick: () => (location.hash = `#/aar/${encodeURIComponent(h.roundId)}`) }, [
      el('td', { text: fmtDate(h.startTime) }),
      el('td', { text: h.mapName }),
      el('td', { html: `<span style="color:${teamColor(h.team, true)}">${h.team}</span>` }),
      el('td', { text: h.pool }),
      el('td', { class: 'num', text: h.points }),
      el('td', { class: 'num', text: h.stats.kills }),
      el('td', { class: 'num', text: h.stats.wounds }),
      el('td', { class: 'num', text: h.stats.deaths }),
      el('td', { class: `num ${h.globalDelta >= 0 ? 'pos' : 'neg'}`, text: signed(h.globalDelta) })
    ]));
  }
  panel.append(table);
  view.append(panel);
}

function card(title, big, sub) {
  return el('div', { class: 'round-card', style: 'cursor:default' }, [
    el('div', { class: 'layer', text: title }),
    el('div', { class: 'map', text: String(big) }),
    el('div', { class: 'muted', text: sub })
  ]);
}

// ─── CQB / aim-recoil coaching panel ────────────────────────────────────────────

const CQB_FLAG_LABEL = {
  first_blood_lost: 'First blood lost', peek_killed: 'Killed while peeking',
  repeated_same_angle: 'Repeated angle', trade_missed: 'Trade missed',
  spray_control_poor: 'Poor spray control', first_shot_missed: 'First shot missed',
  aim_off_target: 'Crosshair off target',
};

function biasText(h, v) {
  const p = [];
  if (Math.abs(v) >= 1) p.push(v > 0 ? 'high' : 'low');
  if (Math.abs(h) >= 1) p.push(h > 0 ? 'right' : 'left');
  return p.join('-');
}

function renderCqbPanel(view, cqb, history) {
  const panel = el('div', { class: 'panel' }, [el('h3', { text: 'Close-quarters coaching (CQB · aim & recoil)' })]);

  if (!cqb.rounds) {
    panel.append(el('div', { class: 'muted', style: 'font-size:13px', text: 'No CQB telemetry yet — needs a server emitting projectile / PlayerLook data (see the SDK plugin). Vanilla + SquadJS rounds won\'t populate this.' }));
    view.append(panel);
    return;
  }

  const wr = cqb.won + cqb.lost > 0 ? Math.round((cqb.won / (cqb.won + cqb.lost)) * 100) : 0;
  const bias = biasText(cqb.biasH, cqb.biasV);
  panel.append(el('div', { class: 'statline', html:
    `<span>Duels (W–L–T)</span><span class="num">${cqb.won}–${cqb.lost}–${cqb.traded} <span class="muted">(${wr}%)</span></span>` +
    `<span>CQB hit rate</span><span class="num">${Math.round(cqb.hitRate * 100)}% <span class="muted">(${cqb.hits}/${cqb.shots})</span></span>` +
    `<span>Mean aim error</span><span class="num">${cqb.meanAimErrorDeg != null ? cqb.meanAimErrorDeg.toFixed(1) + '°' + (bias ? ' ' + bias : '') : '—'}</span>` +
    `<span>Spray spread (RMS)</span><span class="num">${cqb.meanSpreadDeg != null ? cqb.meanSpreadDeg.toFixed(1) + '°' : '—'}</span>` +
    `<span>Spray control</span><span class="num">${cqb.sprayControl != null ? Math.round(cqb.sprayControl * 100) + '%' : '—'}</span>` +
    `<span>Avg vert. climb</span><span class="num">${cqb.meanClimbDeg != null ? cqb.meanClimbDeg.toFixed(1) + '°' : '—'}</span>` +
    `<span>Rounds w/ CQB</span><span class="num">${cqb.rounds}</span>`
  }));

  // season scatter plots: where you aimed (vs enemy) + recoil dispersion
  const plots = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-top:10px' });
  const aimC = el('canvas', { width: 150, height: 150, style: 'border-radius:8px;background:#0e141b;border:1px solid #1f2c39' });
  const recC = el('canvas', { width: 150, height: 150, style: 'border-radius:8px;background:#0e141b;border:1px solid #1f2c39' });
  plots.append(
    el('div', {}, [el('div', { class: 'muted', style: 'font-size:11px;margin-bottom:3px;text-align:center', text: `Aim vs enemy — ${(cqb.aimCloud || []).length} shots` }), aimC]),
    el('div', {}, [el('div', { class: 'muted', style: 'font-size:11px;margin-bottom:3px;text-align:center', text: `Recoil dispersion — ${(cqb.recoilCloud || []).length} shots` }), recC])
  );
  panel.append(plots);

  // aim-error trend across rounds (chronological; lower is better)
  const trend = [...history]
    .filter((h) => h.cqb && h.cqb.aimErr != null)
    .sort((a, b) => a.startTime - b.startTime)
    .map((h) => h.cqb.aimErr);
  if (trend.length >= 2) {
    panel.append(el('div', { class: 'muted', style: 'font-size:11px;margin-top:12px;margin-bottom:2px', text: 'Mean aim error per round (lower = better)' }));
    const tc = el('canvas', { class: 'spark', width: 760, height: 70, style: 'width:100%;height:70px' });
    panel.append(tc);
    drawTrend(tc, trend, '#34d399');
  }

  // coaching flags raised against this player (across rounds)
  const flagEntries = Object.entries(cqb.flags || {}).sort((a, b) => b[1] - a[1]);
  if (flagEntries.length) {
    const chips = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:12px' });
    for (const [f, n] of flagEntries) {
      chips.append(el('span', {
        style: 'padding:2px 8px;border-radius:20px;font-size:12px;background:#f8717118;color:#f87171',
        text: `${CQB_FLAG_LABEL[f] ?? f} ×${n}`
      }));
    }
    panel.append(el('div', { class: 'muted', style: 'font-size:11px;margin-top:12px;margin-bottom:2px', text: 'Coaching flags raised against you' }), chips);
  }

  view.append(panel);

  drawCloud(aimC, cqb.aimCloud || [], 'aim');
  drawCloud(recC, cqb.recoilCloud || [], 'recoil');
}

/** Centered angular scatter: aim (vs enemy at centre) or recoil (drift from shot 1). */
function drawCloud(canvas, pts, kind) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2, pad = 16;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0e141b'; ctx.fillRect(0, 0, W, H);
  const gx = (p) => (kind === 'aim' ? p.h : p.recoilH) ?? 0;
  const gy = (p) => (kind === 'aim' ? p.v : p.recoilV) ?? 0;

  if (!pts.length) {
    ctx.fillStyle = '#5b6b7d'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('no data', cx, cy);
    return;
  }

  let maxAbs = kind === 'aim' ? 3 : 2;
  for (const p of pts) maxAbs = Math.max(maxAbs, Math.abs(gx(p)), Math.abs(gy(p)));
  const scale = (Math.min(W, H) / 2 - pad) / maxAbs;

  // degree rings + labels
  ctx.strokeStyle = '#16202b'; ctx.lineWidth = 1;
  for (const d of [1, 3, 5, 10]) {
    if (d <= maxAbs * 1.15) {
      ctx.beginPath(); ctx.arc(cx, cy, d * scale, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#3a4a5b'; ctx.font = '8px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(d + '°', cx + d * scale + 1, cy - 2);
    }
  }
  // axes
  ctx.strokeStyle = '#1f2c39';
  ctx.beginPath(); ctx.moveTo(pad, cy); ctx.lineTo(W - pad, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, pad); ctx.lineTo(cx, H - pad); ctx.stroke();
  // centre marker
  ctx.fillStyle = kind === 'aim' ? '#f87171' : '#fbbf24';
  ctx.beginPath(); ctx.arc(cx, cy, 2.6, 0, Math.PI * 2); ctx.fill();

  // points (translucent for density)
  for (const p of pts) {
    const x = cx + gx(p) * scale, y = cy - gy(p) * scale;
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = p.hit ? '#34d399' : '#8a98a8';
    ctx.beginPath(); ctx.arc(x, y, p.hit ? 2.6 : 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#5b6b7d'; ctx.font = '8px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(kind === 'aim' ? '● = enemy centre' : '● = shot 1', cx, H - 4);
}

/** Line trend with min/max labels (generic; green by default). */
function drawTrend(cv, vals, color) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = 10;
  const min = Math.min(...vals), max = Math.max(...vals), range = max - min || 1;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#2a3a4b'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, H - pad); ctx.lineTo(W - pad, H - pad); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  vals.forEach((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (W - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (H - 2 * pad);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  // dots
  ctx.fillStyle = color;
  vals.forEach((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (W - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (H - 2 * pad);
    ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = '#7e8ea0'; ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'left';
  ctx.fillText(max.toFixed(1) + '°', pad, 10);
  ctx.fillText(min.toFixed(1) + '°', pad, H - 2);
}

// Internal render helpers exposed for headless test harnesses (not used by the app).
export const __test = { drawCloud, drawTrend, biasText };

function drawSpark(cv, vals) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = 8;
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#2a3a4b'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, H - pad); ctx.lineTo(W - pad, H - pad); ctx.stroke();
  ctx.strokeStyle = '#f5b942'; ctx.lineWidth = 2; ctx.beginPath();
  vals.forEach((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (W - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (H - 2 * pad);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#7e8ea0'; ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(String(Math.round(max)), pad, 10);
  ctx.fillText(String(Math.round(min)), pad, H - 2);
}
