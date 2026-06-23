/**
 * CQB Engagement list + detail view.
 *
 * Exports:
 *   renderEngagementList(panel, bundle, onSelect)
 *   renderEngagementDetail(panel, eng, bundle)
 */
import { el, clear, fmtClock, teamColor } from './util.js';

// ─── flag metadata ────────────────────────────────────────────────────────────

const FLAG_META = {
  first_blood_lost:  { icon: '🩸', label: 'First blood lost',    color: '#f87171' },
  peek_killed:       { icon: '👁', label: 'Killed while peeking', color: '#fbbf24' },
  pre_aim_advantage: { icon: '🎯', label: 'Pre-aim advantage',    color: '#34d399' },
  repeated_same_angle:{ icon: '🔁', label: 'Repeated angle',      color: '#f87171' },
  trade_missed:      { icon: '🤝', label: 'Trade missed',         color: '#fbbf24' },
  outnumbered_entry: { icon: '⚠', label: 'Outnumbered entry',    color: '#f87171' },
  long_ttk:          { icon: '⏱', label: 'Slow TTK',             color: '#fbbf24' },
  spray_control_poor:{ icon: '💨', label: 'Poor spray control',   color: '#f87171' },
  first_shot_missed: { icon: '✗', label: 'First shot missed',     color: '#f87171' },
};

const OUTCOME_LABEL = {
  attacker_won: 'Attacker won',
  defender_won: 'Defender won',
  traded:       'Trade',
  no_kill:      'No kill',
};

// ─── engagement list ──────────────────────────────────────────────────────────

export function renderEngagementList(panel, bundle, onSelect) {
  clear(panel);
  const engs = bundle.engagements ?? [];
  if (!engs.length) {
    panel.append(
      el('h3', { text: 'Engagements (CQB)' }),
      el('div', { class: 'muted', text: 'No engagements detected. Requires PROJECTILE telemetry in the server log.' })
    );
    return;
  }

  // build player name map
  const nameOf = buildNameMap(bundle);

  panel.append(el('h3', { text: `Engagements (CQB) — ${engs.length}` }));

  // filter bar
  const filterWrap = el('div', { style: 'display:flex;gap:6px;margin-bottom:8px' });
  const filterInput = el('input', {
    type: 'text', placeholder: 'Filter by player name…',
    style: 'flex:1;background:#0e141b;border:1px solid #1f2c39;border-radius:6px;color:#d8e2ec;padding:4px 8px;font-size:12px'
  });
  filterWrap.append(filterInput);
  panel.append(filterWrap);

  const list = el('div');
  panel.append(list);

  const render = (query) => {
    clear(list);
    let shown = engs;
    if (query) {
      const q = query.toLowerCase();
      shown = engs.filter(e =>
        (nameOf[e.attackerEOSID] ?? '').toLowerCase().includes(q) ||
        (nameOf[e.defenderEOSID] ?? '').toLowerCase().includes(q)
      );
    }
    for (const eng of shown.slice().sort((a, b) => a.tMs - b.tMs)) {
      list.append(engagementCard(eng, nameOf, onSelect));
    }
    if (!shown.length) {
      list.append(el('div', { class: 'muted', text: 'No matching engagements.' }));
    }
  };

  filterInput.addEventListener('input', () => render(filterInput.value.trim()));
  render('');
}

function engagementCard(eng, nameOf, onSelect) {
  const atName = nameOf[eng.attackerEOSID] ?? eng.attackerEOSID.slice(0, 8);
  const defName = nameOf[eng.defenderEOSID] ?? eng.defenderEOSID.slice(0, 8);
  const atColor = teamColor(eng.attackerTeam, true);
  const defColor = teamColor(eng.defenderTeam, true);
  const distM = (eng.distanceCm / 100).toFixed(0);
  const ttkSec = eng.ttkMs != null ? (eng.ttkMs / 1000).toFixed(2) + 's' : '—';
  const outcomeOk = eng.outcome === 'attacker_won' || eng.outcome === 'defender_won';

  const flagBadges = (eng.flags ?? []).slice(0, 3).map(f => {
    const m = FLAG_META[f] ?? { icon: '?', label: f, color: '#fbbf24' };
    return el('span', {
      style: `display:inline-block;padding:1px 6px;border-radius:20px;font-size:11px;background:${m.color}22;color:${m.color};margin-right:3px`,
      text: m.icon + ' ' + m.label
    });
  });

  const card = el('div', {
    class: 'ev',
    style: 'cursor:pointer;padding:8px;border-radius:8px;margin-bottom:6px;border:1px solid #1f2c39',
    onclick: () => onSelect(eng)
  }, [
    el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px' }, [
      el('span', { html:
        `<b style="color:${atColor}">${atName}</b>` +
        ` <span class="muted" style="font-size:11px">vs</span> ` +
        `<b style="color:${defColor}">${defName}</b>`
      }),
      el('span', { class: 'muted', style: 'font-size:11px', text: fmtClock(eng.tMs) })
    ]),
    el('div', { style: 'display:flex;gap:12px;font-size:12px;margin-bottom:4px' }, [
      el('span', {
        style: `color:${outcomeOk ? '#34d399' : '#94a3b8'}`,
        text: OUTCOME_LABEL[eng.outcome] ?? eng.outcome
      }),
      el('span', { class: 'muted', text: `${distM} m · TTK ${ttkSec}` }),
      el('span', { class: 'muted', text: `${eng.attackerShots.length + eng.defenderShots.length} shots` })
    ]),
    flagBadges.length ? el('div', { style: 'margin-top:2px' }, flagBadges) : null
  ].filter(Boolean));

  return card;
}

// ─── engagement detail ────────────────────────────────────────────────────────

export function renderEngagementDetail(panel, eng, bundle) {
  clear(panel);
  const nameOf = buildNameMap(bundle);
  const atName = nameOf[eng.attackerEOSID] ?? eng.attackerEOSID.slice(0, 8);
  const defName = nameOf[eng.defenderEOSID] ?? eng.defenderEOSID.slice(0, 8);
  const atColor = teamColor(eng.attackerTeam, true);
  const defColor = teamColor(eng.defenderTeam, true);
  const distM = (eng.distanceCm / 100).toFixed(0);
  const ttkSec = eng.ttkMs != null ? (eng.ttkMs / 1000).toFixed(2) + 's' : '—';

  // ── header ──────────────────────────────────────────────────────────────────
  panel.append(
    el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px' }, [
      el('h3', { style: 'margin:0', html:
        `<span style="color:${atColor}">${atName}</span>` +
        ` <span class="muted">vs</span> ` +
        `<span style="color:${defColor}">${defName}</span>`
      }),
      el('span', { class: 'muted', style: 'font-size:12px', text: fmtClock(eng.tMs) })
    ]),
    el('div', { class: 'statline', html:
      `<span>Outcome</span><span style="color:${eng.outcome === 'no_kill' ? '#94a3b8' : '#34d399'}">${OUTCOME_LABEL[eng.outcome] ?? eng.outcome}</span>` +
      `<span>Distance</span><span class="num">${distM} m</span>` +
      `<span>TTK</span><span class="num">${ttkSec}</span>` +
      `<span>Attacker shots/hits</span><span class="num">${eng.attackerShots.length} / ${eng.attackerHits}</span>` +
      `<span>Defender shots/hits</span><span class="num">${eng.defenderShots.length} / ${eng.defenderHits}</span>` +
      (eng.approachDeltaCm != null
        ? `<span>Attacker approach</span><span class="num">${(eng.approachDeltaCm / 100).toFixed(0)} m ${eng.approachDeltaCm > 0 ? '(advancing)' : '(retreating)'}</span>`
        : '') +
      (eng.ttkMs != null
        ? `<span>Attacker moving</span><span>${eng.attackerWasMoving ? 'yes' : 'no'}</span><span>Defender moving</span><span>${eng.defenderWasMoving ? 'yes' : 'no'}</span>`
        : '')
    })
  );

  // ── mini-map ─────────────────────────────────────────────────────────────────
  const allShots = [...(eng.attackerShots ?? []), ...(eng.defenderShots ?? [])];
  if (allShots.length) {
    panel.append(el('div', { class: 'muted', style: 'font-size:11px;margin-top:8px;margin-bottom:4px', text: 'Shot map (top-down, 80 × 80 m)' }));
    const miniCanvas = el('canvas', { width: 300, height: 300, style: 'width:100%;border-radius:8px;border:1px solid #1f2c39' });
    panel.append(miniCanvas);
    drawShotMap(miniCanvas, eng, allShots);
  }

  // ── coaching flags ───────────────────────────────────────────────────────────
  if ((eng.flags ?? []).length) {
    panel.append(el('div', { style: 'margin-top:10px;margin-bottom:4px;font-weight:700', text: 'Coaching flags' }));
    for (const flag of eng.flags) {
      const m = FLAG_META[flag] ?? { icon: '?', label: flag, color: '#fbbf24' };
      const detail = eng.flagDetails?.[flag];
      panel.append(el('div', {
        style: `padding:6px 10px;border-radius:6px;margin-bottom:5px;border-left:3px solid ${m.color};background:${m.color}11`
      }, [
        el('div', { style: `color:${m.color};font-weight:600;font-size:13px`, text: `${m.icon} ${m.label}` }),
        detail ? el('div', { class: 'muted', style: 'font-size:12px;margin-top:2px', text: detail }) : null
      ].filter(Boolean)));
    }
  } else {
    panel.append(el('div', { class: 'muted', style: 'margin-top:10px;font-size:12px', text: 'No coaching flags raised.' }));
  }

  // ── context ──────────────────────────────────────────────────────────────────
  if (eng.nearbyTeammatesAttacker?.length || eng.nearbyTeammatesDefender?.length) {
    panel.append(el('div', { style: 'margin-top:10px;margin-bottom:4px;font-weight:700', text: 'Nearby players at engagement start' }));
    panel.append(el('div', { class: 'statline', html:
      `<span style="color:${atColor}">Attacker allies (50 m)</span><span class="num">${eng.nearbyTeammatesAttacker.length}</span>` +
      `<span style="color:${defColor}">Defender allies (50 m)</span><span class="num">${eng.nearbyTeammatesDefender.length}</span>` +
      `<span>Trade opportunity</span><span>${eng.tradeOpportunity ? 'yes' : 'no'}</span>`
    }));
  }

  // ── shot timeline ─────────────────────────────────────────────────────────────
  panel.append(el('div', { style: 'margin-top:10px;margin-bottom:4px;font-weight:700', text: 'Shot timeline' }));
  panel.append(renderShotTimeline(eng, nameOf, atColor, defColor));
}

// ─── mini-map canvas ──────────────────────────────────────────────────────────

function drawShotMap(canvas, eng, shots) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // compute world-space bounds (padded to at least 80 m = 8000 cm)
  const cx = eng.engagementPos.x, cy = eng.engagementPos.y;
  const halfSpan = 4000; // 40 m radius = 80 m total
  const wMinX = cx - halfSpan, wMaxX = cx + halfSpan;
  const wMinY = cy - halfSpan, wMaxY = cy + halfSpan;

  const toScreen = (wx, wy) => ({
    sx: ((wx - wMinX) / (wMaxX - wMinX)) * W,
    sy: H - ((wy - wMinY) / (wMaxY - wMinY)) * H // flip Y (north = up)
  });

  // background
  ctx.fillStyle = '#0e141b';
  ctx.fillRect(0, 0, W, H);

  // grid (every 10 m = 1000 cm)
  ctx.strokeStyle = '#1f2c39';
  ctx.lineWidth = 0.5;
  for (let gx = Math.ceil(wMinX / 1000) * 1000; gx <= wMaxX; gx += 1000) {
    const { sx } = toScreen(gx, cy);
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
  }
  for (let gy = Math.ceil(wMinY / 1000) * 1000; gy <= wMaxY; gy += 1000) {
    const { sy } = toScreen(cx, gy);
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
  }

  // center cross
  const center = toScreen(cx, cy);
  ctx.strokeStyle = '#2a3a4b'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(center.sx - 8, center.sy); ctx.lineTo(center.sx + 8, center.sy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(center.sx, center.sy - 8); ctx.lineTo(center.sx, center.sy + 8); ctx.stroke();

  // draw shots as lines
  for (const shot of shots) {
    const isAttacker = shot.shooterEOSID === eng.attackerEOSID;
    const baseColor = isAttacker
      ? (eng.attackerTeam === 1 ? '#3b82f6' : '#ef4444')
      : (eng.defenderTeam === 1 ? '#3b82f6' : '#ef4444');
    const from = toScreen(shot.from.x, shot.from.y);
    const to = toScreen(shot.to.x, shot.to.y);

    ctx.globalAlpha = shot.hit ? 0.85 : 0.35;
    ctx.strokeStyle = shot.hit ? '#f87171' : baseColor;
    ctx.lineWidth = shot.hit ? 1.5 : 0.8;
    ctx.beginPath();
    ctx.moveTo(from.sx, from.sy);
    ctx.lineTo(to.sx, to.sy);
    ctx.stroke();

    // impact dot for hits
    if (shot.hit) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(to.sx, to.sy, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // shooter positions (from first shot)
  const atFirst = eng.attackerShots[0];
  const defFirst = eng.defenderShots[0];
  const drawPlayer = (pos, color, label) => {
    const { sx, sy } = toScreen(pos.x, pos.y);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(label, sx, sy - 8);
  };
  if (atFirst) drawPlayer(atFirst.from, eng.attackerTeam === 1 ? '#6fa8ff' : '#ff7a7a', 'A');
  if (defFirst) drawPlayer(defFirst.from, eng.defenderTeam === 1 ? '#6fa8ff' : '#ff7a7a', 'D');

  // compass N
  ctx.fillStyle = '#7e8ea0'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('N↑', 4, 14);
}

// ─── shot timeline ────────────────────────────────────────────────────────────

function renderShotTimeline(eng, nameOf, atColor, defColor) {
  const allShots = [
    ...(eng.attackerShots ?? []).map(s => ({ ...s, _side: 'attacker' })),
    ...(eng.defenderShots ?? []).map(s => ({ ...s, _side: 'defender' }))
  ].sort((a, b) => a.tMs - b.tMs);

  const relMs = (tMs) => (tMs - eng.tMs);

  const table = el('div', { style: 'overflow-x:auto' });
  const tbody = el('div', { style: 'min-width:340px;font-size:11px;font-family:monospace' });

  // header
  tbody.append(el('div', {
    style: 'display:grid;grid-template-columns:52px 80px 60px 30px 40px 40px 50px;gap:2px;color:#7e8ea0;padding:2px 0;border-bottom:1px solid #1f2c39;font-size:10px',
    html: '<span>t</span><span>shooter</span><span>weapon</span><span>hit</span><span>zone</span><span>recoilH</span><span>dist</span>'
  }));

  for (const shot of allShots) {
    const isAt = shot._side === 'attacker';
    const color = isAt ? atColor : defColor;
    const name = (nameOf[shot.shooterEOSID] ?? shot.shooterEOSID.slice(0, 6)).slice(0, 10);
    const weapShort = shot.weapon.replace(/^.*\/|_C$/g, '').slice(0, 12);
    const zone = shot.zone ?? '—';
    const rh = shot.recoilH != null ? shot.recoilH.toFixed(1) + '°' : '—';
    const dist = shot.nearestEnemyDistCm != null ? (shot.nearestEnemyDistCm / 100).toFixed(0) + 'm' : '—';
    const hitMark = shot.hit ? '✓' : '·';

    tbody.append(el('div', {
      style: `display:grid;grid-template-columns:52px 80px 60px 30px 40px 40px 50px;gap:2px;padding:2px 0;border-bottom:1px solid #0e141b;color:${shot.hit ? color : '#7e8ea0'}`,
      html:
        `<span>${'+' + relMs(shot.tMs)}ms</span>` +
        `<span style="color:${color}">${name}</span>` +
        `<span>${weapShort}</span>` +
        `<span style="color:${shot.hit ? '#34d399' : '#7e8ea0'}">${hitMark}</span>` +
        `<span>${zone}</span>` +
        `<span>${rh}</span>` +
        `<span style="color:${shot.onTarget ? '#fbbf24' : '#7e8ea0'}">${dist}</span>`
    }));
  }

  if (!allShots.length) {
    tbody.append(el('div', { class: 'muted', style: 'padding:6px', text: 'No shot data.' }));
  }

  table.append(tbody);
  return table;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function buildNameMap(bundle) {
  const map = {};
  for (const p of (bundle.report?.players ?? [])) map[p.eosID] = p.name;
  for (const [eos, p] of Object.entries(bundle.players ?? {})) {
    if (!map[eos]) map[eos] = p.name ?? eos.slice(0, 8);
  }
  return map;
}
