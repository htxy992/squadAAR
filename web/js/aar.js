import { getJSON, el, clear, fmtClock, teamColor, signed } from './util.js';
import { MapRenderer } from './map.js';

export async function renderAAR(view, roundId) {
  clear(view);
  view.append(el('div', { class: 'loading', text: 'Loading round…' }));
  let bundle;
  try {
    bundle = await getJSON(`/api/rounds/${encodeURIComponent(roundId)}`);
  } catch (e) {
    clear(view).append(el('div', { class: 'loading', text: 'Round not found.' }));
    return;
  }
  clear(view);

  const meta = bundle.meta;
  const duration = meta.durationMs;

  // ===== top bar (REPLAY) =================================================
  const tkA = el('div', { class: 'rt-tk a', text: '—' });
  const tkB = el('div', { class: 'rt-tk b', text: '—' });
  const topTime = el('span', { class: 'rt-v', text: '00:00' });
  const topState = el('span', { class: 'rt-v', text: meta.winnerTeam ? `Team ${meta.winnerTeam} won` : 'Replay' });
  const search = el('input', { class: 'rt-search', type: 'text', placeholder: 'Search player / vehicle…' });
  const btnMenu = el('button', { class: 'rt-btn', text: 'MENU' });
  const btnVeh = el('button', { class: 'rt-btn', text: 'VEHICLES' });
  const btnScore = el('button', { class: 'rt-btn', text: 'SCOREBOARD' });
  const replayTop = el('div', { class: 'replay-top' }, [
    el('div', { class: 'rt-brand', text: 'REPLAY', onclick: () => (location.hash = '#/rounds') }),
    el('div', { class: 'rt-info' }, [el('span', { class: 'rt-k', text: 'MAP' }), el('span', { class: 'rt-v', text: meta.layer }), el('span', { class: 'rt-k', text: 'TIME' }), topTime, el('span', { class: 'rt-k', text: 'STATE' }), topState]),
    el('div', { class: 'rt-scoreboard' }, [
      el('div', { class: 'rt-side' }, [tkA, el('div', { class: 'rt-fac', text: meta.factions?.[1] || 'Team 1' })]),
      el('div', { class: 'rt-vs', text: 'VS' }),
      el('div', { class: 'rt-side' }, [tkB, el('div', { class: 'rt-fac', text: meta.factions?.[2] || 'Team 2' })])
    ]),
    el('div', { class: 'rt-info' }, [el('span', { class: 'rt-k', text: 'PLAYERS' }), el('span', { class: 'rt-v', text: String(meta.playerCount) })]),
    el('div', { class: 'rt-grow' }),
    search,
    el('div', { class: 'rt-btns' }, [btnMenu, btnVeh, btnScore])
  ]);

  // ===== map =====
  const canvas = el('canvas', { id: 'map' });
  const mapCol = el('div', { class: 'map-col' }, [el('div', { class: 'map-wrap' }, [canvas])]);

  // ===== left sidebar: selected / engagement =====
  const selClose = el('button', { class: 'sel-x', text: '✕' });
  const selPanel = el('div', { class: 'panel' }, [
    el('div', { class: 'sel-head' }, [el('h3', { class: 'sel-title', text: 'SELECTED' }), selClose]),
    el('div', { class: 'sel-body sel-empty', text: 'Click a player or vehicle on the map, or a name in the scoreboard.' })
  ]);
  const engagePanel = el('div', { class: 'panel hidden' });
  const sideLeft = el('div', { class: 'side-left' }, [selPanel, engagePanel]);

  // ===== right sidebar: tabbed panes =====
  const mk = (id, label, checked) => el('label', {}, [el('input', { type: 'checkbox', id, ...(checked ? { checked: 'checked' } : {}) }), ' ' + label]);
  const toggles = el('div', { class: 'toggles' }, [
    mk('tg-basemap', 'Base map', true),
    mk('tg-terrain', 'Terrain (hillshade)', true),
    mk('tg-elev', 'Elevation heat', false),
    mk('tg-contours', 'Contours', false),
    mk('tg-vehroutes', 'Vehicle routes', false),
    mk('tg-vehheat', 'Vehicle heatmap', false),
    mk('tg-tracers', 'Shots / tracers', true),
    mk('tg-animate', 'Animate bullets', true),
    mk('tg-impacts', 'Impacts (hit/miss)', true),
    mk('tg-sightlines', 'Sightlines', false),
    mk('tg-susp', 'Suspicious only', false),
    mk('tg-names', 'Player names', false),
    mk('tg-follow', 'Follow selected', false)
  ]);
  const legend = el('div', { class: 'legend' }, [
    sw('#3b82f6', 'Team 1'), sw('#ef4444', 'Team 2'), sw('#fbbf24', 'Wounded'),
    sw('#fcd34d', 'Tracer'), sw('#f87171', 'Suspicious'), sw('#c084fc', 'FOB kill'), sw('#fb923c', 'Mortar / blast')
  ]);
  const infoPanel = el('div', { class: 'panel' });
  const layersPanel = el('div', { class: 'panel' }, [el('h3', { text: 'Map layers' }), toggles, legend]);
  const menuPane = el('div', { class: 'tab-pane hidden' }, [infoPanel, layersPanel]);
  const teamsPanel = el('div', { class: 'panel tab-pane hidden' });
  const vehPanel = el('div', { class: 'panel tab-pane hidden' });
  const analysisPanel = el('div', { class: 'panel tab-pane hidden' });
  const feedCount = el('span', { class: 'feed-count' });
  const feedPanel = el('div', { class: 'panel tab-pane' }, [el('div', { class: 'feed-head' }, [el('h3', { text: 'KILL FEED' }), feedCount]), el('div', { class: 'feed killfeed' })]);
  const tabBtns = {
    feed: el('button', { class: 'tab active', text: 'Kill feed' }),
    score: el('button', { class: 'tab', text: 'Scoreboard' }),
    veh: el('button', { class: 'tab', text: 'Vehicles' }),
    anal: el('button', { class: 'tab', text: 'Analysis' }),
    menu: el('button', { class: 'tab', text: 'Menu' })
  };
  const sideRight = el('div', { class: 'side-right' }, [el('div', { class: 'tabs-row' }, Object.values(tabBtns)), feedPanel, teamsPanel, vehPanel, analysisPanel, menuPane]);

  // ===== bottom transport bar =====
  const playBtn = el('button', { class: 'bb-play', text: '▶' });
  const scrub = el('input', { type: 'range', min: '0', max: String(duration), value: '0', step: '500', class: 'scrub' });
  const tlTicks = el('div', { class: 'tl-ticks' });
  const tlTrack = el('div', { class: 'tl-track' }, [scrub, tlTicks]);
  const timeLabel = el('span', { class: 'bb-time', text: '00:00 / 00:00' });
  const speeds = [0.5, 1, 2, 4, 8, 16];
  const speedBtns = speeds.map((s) => el('button', { class: 'sp' + (s === 4 ? ' active' : ''), 'data-sp': String(s), text: s + '×' }));
  const skip = (txt, fn) => el('button', { class: 'bb-skip', text: txt, onclick: fn });
  const bottomBar = el('div', { class: 'bottom-bar' }, [
    playBtn,
    el('div', { class: 'bb-skips' }, [skip('«', () => { setTime(0); pause(); }), skip('‹', () => stepBy(-15000)), skip('›', () => stepBy(15000)), skip('»', () => { setTime(duration); pause(); })]),
    timeLabel, tlTrack,
    el('div', { class: 'bb-speeds' }, speedBtns),
    el('div', { class: 'rt-grow' }),
    el('span', { class: 'bb-src', text: `${bundle.snapshots.length} frames · ${meta.source || meta.id}` }),
    el('button', { class: 'bb-exit', text: 'Exit', onclick: () => (location.hash = '#/rounds') })
  ]);

  view.append(el('div', { class: 'aar' }, [replayTop, sideLeft, mapCol, sideRight, bottomBar]));

  // ---- renderer ----------------------------------------------------------
  const r = new MapRenderer(canvas);
  r.setRound(bundle);
  requestAnimationFrame(() => r.setRound(bundle)); // ensure size after layout

  // ---- static panels -----------------------------------------------------
  renderInfo(infoPanel, bundle);
  renderTeams(teamsPanel, bundle, (eos) => selectPlayer(eos));
  renderVehicles(vehPanel, bundle, (vt) => onPickVeh(vt));
  renderAnalysis(analysisPanel, bundle, jumpToProjectile);
  renderKillFeed(feedPanel.querySelector('.feed'), feedCount, bundle, onEventJump);
  buildTicks(tlTicks, bundle, duration, onEventJump);

  // ---- playback ----------------------------------------------------------
  let currentMs = 0, playing = false, speed = 4, lastTs = 0, lastPanel = 0;
  function setTime(ms) { currentMs = Math.max(0, Math.min(duration, ms)); scrub.value = String(currentMs); }
  function stepBy(d) { setTime(currentMs + d); pause(); }
  function pause() { playing = false; playBtn.textContent = '▶'; }
  function play() { playing = true; playBtn.textContent = '❚❚'; lastTs = performance.now(); }
  playBtn.onclick = () => (playing ? pause() : (currentMs >= duration && setTime(0), play()));
  scrub.oninput = () => { setTime(+scrub.value); pause(); };
  for (const btn of speedBtns) btn.onclick = () => { speed = +btn.getAttribute('data-sp'); speedBtns.forEach((b) => b.classList.toggle('active', b === btn)); };

  toggles.querySelector('#tg-basemap').onchange = (e) => (r.opts.basemap = e.target.checked);
  toggles.querySelector('#tg-terrain').onchange = (e) => (r.opts.terrain = e.target.checked);
  toggles.querySelector('#tg-elev').onchange = (e) => (r.opts.elevation = e.target.checked);
  toggles.querySelector('#tg-contours').onchange = (e) => (r.opts.contours = e.target.checked);
  toggles.querySelector('#tg-vehroutes').onchange = (e) => (r.opts.vehRoutes = e.target.checked);
  toggles.querySelector('#tg-vehheat').onchange = (e) => (r.opts.vehHeat = e.target.checked);
  toggles.querySelector('#tg-tracers').onchange = (e) => (r.opts.tracers = e.target.checked);
  toggles.querySelector('#tg-animate').onchange = (e) => (r.opts.animate = e.target.checked);
  toggles.querySelector('#tg-impacts').onchange = (e) => (r.opts.impacts = e.target.checked);
  toggles.querySelector('#tg-sightlines').onchange = (e) => (r.opts.sightlines = e.target.checked);
  toggles.querySelector('#tg-susp').onchange = (e) => (r.opts.suspiciousOnly = e.target.checked);
  toggles.querySelector('#tg-names').onchange = (e) => (r.opts.names = e.target.checked);
  toggles.querySelector('#tg-follow').onchange = (e) => (r.follow = e.target.checked);

  // tabs + top buttons
  const panes = { feed: feedPanel, score: teamsPanel, veh: vehPanel, anal: analysisPanel, menu: menuPane };
  function setTab(name) { for (const k in panes) panes[k].classList.toggle('hidden', k !== name); for (const k in tabBtns) tabBtns[k].classList.toggle('active', k === name); }
  for (const k in tabBtns) tabBtns[k].onclick = () => setTab(k);
  btnScore.onclick = () => setTab('score');
  btnVeh.onclick = () => setTab('veh');
  btnMenu.onclick = () => setTab('menu');
  const findPlayer = (q) => bundle.report.players.find((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  search.onkeydown = (e) => { if (e.key === 'Enter' && search.value.trim()) { const p = findPlayer(search.value.trim()); if (p) selectPlayer(p.eosID); } };
  selClose.onclick = () => { r.selected = null; r.highlightEngagement = null; engagePanel.classList.add('hidden'); updateSelected(); };

  function selectPlayer(eos) { r.selected = { kind: 'player', id: eos }; r.highlightEngagement = null; engagePanel.classList.add('hidden'); updateSelected(); }
  function onPickVeh(vt) {
    r.routeVehicleId = r.routeVehicleId === vt.id ? null : vt.id;
    r.opts.vehRoutes = true;
    if (r.routeVehicleId) { setTime(vt.firstSeenMs); pause(); r.selected = { kind: 'vehicle', id: vt.id }; updateSelected(); }
    highlightVehRows(vehPanel, r.routeVehicleId);
  }
  function onEventJump(ev) {
    const d = (bundle.deaths || []).find((x) => Math.abs(x.tMs - ev.tMs) < 50 && x.victimEOSID === ev.victimEOSID);
    if (d) jumpToDeath(d);
    else { setTime(ev.tMs); pause(); }
  }

  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const cx = ((ev.clientX - rect.left) / rect.width) * r._size;
    const cy = ((ev.clientY - rect.top) / rect.height) * r._size;
    const hit = r.pick(cx, cy);
    r.selected = hit ? { kind: hit.kind, id: hit.id } : null;
    r.highlightEngagement = null;
    engagePanel.classList.add('hidden');
    if (hit && hit.kind === 'vehicle') { r.routeVehicleId = hit.id; highlightVehRows(vehPanel, hit.id); }
    updateSelected();
  });

  function jumpToDeath(d) {
    setTime(d.tMs);
    pause();
    r.highlightProj = null;
    r.highlightEngagement = d;
    if (d.victimEOSID) r.selected = { kind: 'player', id: d.victimEOSID };
    renderEngagement(engagePanel, d, jumpToDeath);
    updateSelected();
  }

  function jumpToProjectile(pr) {
    setTime(pr.tMs);
    pause();
    r.highlightProj = pr;
    if (pr.shooterEOSID) r.selected = { kind: 'player', id: pr.shooterEOSID };
    setTimeout(() => { r.highlightProj = null; }, 6000);
    updateSelected();
  }

  function ticketsAt(ms) {
    const idx = Math.max(0, Math.min(bundle.snapshots.length - 1, Math.round(ms / r.step)));
    return bundle.snapshots[idx]?.tickets || {};
  }

  function updateSelected() {
    const body = selPanel.querySelector('.sel-body');
    if (!r.selected) { body.className = 'sel-body sel-empty'; body.textContent = 'Click a player or vehicle on the map.'; return; }
    body.className = 'sel-body';
    if (r.selected.kind === 'player') {
      const live = (r._lastPlayers || []).find((p) => p.eosID === r.selected.id);
      const rep = bundle.report.players.find((p) => p.eosID === r.selected.id);
      const elo = bundle.eloReport.players.find((p) => p.eosID === r.selected.id);
      if (!rep && !live) { body.textContent = '—'; return; }
      const s = rep?.stats;
      clear(body);
      [
        el('div', { html: `<b style="color:${teamColor(rep?.team ?? live?.team, true)}">${rep?.name ?? live?.name}</b> <span class="muted">T${rep?.team ?? live?.team} · ${rep?.pool ?? live?.role ?? ''}</span>` }),
        live ? el('div', { class: 'muted', text: `state ${live.state} · hp ${Math.round(live.health)} · squad ${live.squad ?? '-'}` }) : null,
        rep ? el('div', { class: 'statline', html:
          `<span>Points</span><span class="num">${rep.totalPoints}</span>` +
          `<span>Kills / Wounds</span><span class="num">${s.kills} / ${s.wounds}</span>` +
          `<span>Deaths / TK</span><span class="num">${s.deaths} / ${s.teamkills}</span>` +
          `<span>Revives</span><span class="num">${s.revivesGiven}</span>` +
          `<span>Dmg inf / veh</span><span class="num">${Math.round(s.damageInfantry)} / ${Math.round(s.damageVehicle)}</span>` +
          `<span>Longest kill</span><span class="num">${s.longestKillM} m</span>` +
          `<span>Global Elo Δ</span><span class="num ${(elo?.globalDelta ?? 0) >= 0 ? 'pos' : 'neg'}">${elo ? signed(elo.globalDelta) : '-'}</span>`
        }) : null,
        rep ? el('a', { href: `#/player/${rep.eosID}`, text: 'open full player profile →' }) : null
      ].filter(Boolean).forEach((n) => body.append(n));
      const id = r.selected.id;
      const myDeaths = (bundle.deaths || []).filter((d) => d.victimEOSID === id);
      const myKills = (bundle.deaths || []).filter((d) => d.killerEOSID === id && !d.teamkill);
      if (myDeaths.length) body.append(deathList(`Why they died (${myDeaths.length}) — click to replay`, myDeaths, 'victim', jumpToDeath));
      if (myKills.length) body.append(deathList(`Kills (${myKills.length})`, myKills, 'killer', jumpToDeath));
    } else {
      const live = (r._lastVehicles || []).find((v) => v.id === r.selected.id);
      if (!live) { body.textContent = '—'; return; }
      const comps = Object.entries(live.components || {}).map(([k, v]) => `<span>${k}</span><span class="num">${Math.round(v)}</span>`).join('');
      clear(body).append(
        el('div', { html: `<b style="color:${teamColor(live.team, true)}">${live.type}</b> <span class="muted">${live.pool || ''} · T${live.team}</span>` }),
        el('div', { class: 'statline', html:
          `<span>Hull HP</span><span class="num">${Math.round(live.health)} / ${Math.round(live.maxHealth)}</span>` +
          `<span>Turret yaw</span><span class="num">${Math.round(live.turretYaw ?? 0)}°</span>` + comps })
      );
    }
  }

  function tick(ts) {
    if (playing) {
      const dt = ts - lastTs; lastTs = ts;
      setTime(currentMs + dt * speed);
      if (currentMs >= duration) pause();
    }
    r.draw(currentMs);
    const tk = ticketsAt(currentMs);
    tkA.textContent = tk[1] ?? '—';
    tkB.textContent = tk[2] ?? '—';
    topTime.textContent = fmtClock(currentMs);
    timeLabel.textContent = `${fmtClock(currentMs)} / ${fmtClock(duration)}`;
    if (ts - lastPanel > 150) { lastPanel = ts; if (r.selected) updateSelected(); highlightFeed(feedPanel.querySelector('.feed'), currentMs); }
    raf = requestAnimationFrame(tick);
  }
  let raf = requestAnimationFrame(tick);

  // cleanup on navigation
  window.addEventListener('hashchange', () => cancelAnimationFrame(raf), { once: true });
}

/* ---------------------------- panel renderers ---------------------------- */

function renderInfo(panel, bundle) {
  const m = bundle.meta;
  const winner = m.winnerTeam;
  clear(panel).append(
    el('h3', { text: 'Round' }),
    el('div', { html: `<b style="font-size:16px">${m.mapName}</b> <span class="muted">${m.layer}</span>` }),
    el('div', { class: 'kv', html: `<span class="muted">Winner</span><span class="${winner === 1 ? 't1' : 't2'}">Team ${winner ?? '—'} ${m.factions?.[winner] ? '(' + m.factions[winner] + ')' : ''}</span>` }),
    el('div', { class: 'kv', html: `<span class="muted">Final tickets</span><span><span class="t1">${m.finalTickets?.[1] ?? '—'}</span> – <span class="t2">${m.finalTickets?.[2] ?? '—'}</span></span>` }),
    el('div', { class: 'kv', html: `<span class="muted">Duration</span><span>${(m.durationMs / 60000).toFixed(1)} min</span>` }),
    el('div', { class: 'kv', html: `<span class="muted">Players</span><span>${m.playerCount}</span>` }),
    el('div', { class: 'kv', html: `<span class="muted">Team points</span><span><span class="t1">${Math.round(bundle.report.global.teamPoints?.[1] ?? 0)}</span> – <span class="t2">${Math.round(bundle.report.global.teamPoints?.[2] ?? 0)}</span></span>` }),
    el('hr', {}),
    el('div', { class: 'kv', html: `<span class="muted">Predicted win (Elo)</span><span><span class="t1">${Math.round((bundle.balance.team1.win_chance) * 100)}%</span> – <span class="t2">${Math.round((bundle.balance.team2.win_chance) * 100)}%</span></span>` }),
    el('div', { class: 'kv', html: `<span class="muted">Avg team Elo</span><span><span class="t1">${Math.round(bundle.balance.team1.avg_elo)}</span> – <span class="t2">${Math.round(bundle.balance.team2.avg_elo)}</span></span>` })
  );
}

function renderAnalysis(panel, bundle, onJump) {
  const a = bundle.analysis;
  clear(panel).append(el('h3', { text: `Projectile analysis — ${a.suspicious.length} flagged / ${a.projectiles.length}` }));
  if (!a.suspicious.length) { panel.append(el('div', { class: 'muted', text: 'No implausible shots detected.' })); return; }
  for (const pr of a.suspicious.slice(0, 30)) {
    const score = pr.plausibility.score;
    panel.append(el('div', { class: 'susp-item', onclick: () => onJump(pr) }, [
      el('div', { html: `<span class="score" style="color:${score < 0.3 ? '#f87171' : '#fbbf24'}">${score.toFixed(2)}</span> ` +
        `<b>${pr.shooterName ?? '?'}</b> <span class="muted">${pr.weaponFamily} · ${Math.round(pr.rangeM)} m · ${fmtClock(pr.tMs)}</span>` }),
      el('div', { class: 'flags', text: pr.plausibility.flags.join(' · ') })
    ]));
  }
}

function renderTeams(panel, bundle, onSelect) {
  clear(panel);
  const m = bundle.meta;
  for (const team of [1, 2]) {
    const ps = bundle.report.players.filter((p) => p.team === team);
    panel.append(el('div', { class: 'team-head' }, [
      el('span', { style: `color:${teamColor(team, true)}`, text: `Team ${team} · ${m.factions?.[team] || ''}` }),
      el('span', { class: 'muted', text: `${m.finalTickets?.[team] ?? '—'} tix · ${Math.round(bundle.report.global.teamPoints?.[team] ?? 0)} pts` })
    ]));
    const squads = {};
    for (const p of ps) (squads[(bundle.players[p.eosID]?.squad) ?? 0] ??= []).push(p);
    for (const sq of Object.keys(squads).sort((a, b) => +a - +b)) {
      panel.append(el('div', { class: 'squad-label', text: sq === '0' ? 'Unassigned' : `Squad ${sq}` }));
      for (const p of squads[sq].sort((a, b) => b.totalPoints - a.totalPoints)) {
        panel.append(el('div', { class: 'sb-row', 'data-eos': p.eosID, onclick: () => onSelect(p.eosID) }, [
          el('span', { class: 'nm', html: `<span style="color:${teamColor(team, true)}">${p.name}</span> <span class="rl">${p.pool}</span>` }),
          el('span', { class: 'pt', text: p.totalPoints }),
          el('span', { class: 'kd', text: `${p.stats.kills}/${p.stats.wounds}/${p.stats.deaths}` })
        ]));
      }
    }
  }
}

function renderKillFeed(node, countEl, bundle, onJump) {
  clear(node);
  const kills = (bundle.deaths || [])
    .filter((d) => d.killerEOSID && (d.cause === 'killed' || d.cause === 'bled out' || d.cause === 'team-killed'))
    .slice()
    .sort((a, b) => a.tMs - b.tMs);
  if (countEl) countEl.textContent = String(kills.length);
  for (const d of kills) {
    const kc = teamColor(d.killerTeam, true), vc = teamColor(d.victimTeam, true);
    const tag = [d.weapon, d.distanceM != null ? d.distanceM + ' m' : null, d.headshot ? 'HS' : null].filter(Boolean).join(' · ');
    const susp = d.plausibility && d.plausibility.score < 0.5;
    const row = el('div', { class: 'kf', 'data-tms': d.tMs, onclick: () => onJump(d) }, [
      el('span', { class: 'kf-t', text: fmtClock(d.tMs) }),
      el('span', { class: 'kf-line', html: `<b style="color:${kc}">${d.killerName || '?'}</b> <span class="w">${tag}${susp ? ' ⚠' : ''}</span> ▸ <b style="color:${vc}">${d.victimName}</b>` })
    ]);
    row.style.opacity = '0.18';
    node.append(row);
  }
}

function buildTicks(node, bundle, duration, onJump) {
  clear(node);
  const kinds = new Set(['kill', 'teamkill', 'flag_captured', 'fob_destroyed', 'fob_created', 'vehicle_destroyed', 'explosion']);
  for (const ev of bundle.mapEvents) {
    if (!kinds.has(ev.kind)) continue;
    const left = Math.max(0, Math.min(100, (ev.tMs / duration) * 100));
    node.append(el('div', { class: `tk-mark k-${ev.kind}`, style: `left:${left}%`, title: `${fmtClock(ev.tMs)} ${ev.label}`, onclick: () => onJump(ev) }));
  }
}

let _lastFeedIdx = -1;
function highlightFeed(node, currentMs) {
  const rows = node.children;
  let lastVisible = -1;
  for (let i = 0; i < rows.length; i++) {
    const tms = +rows[i].getAttribute('data-tms');
    const on = tms <= currentMs;
    rows[i].style.opacity = on ? (currentMs - tms < 6000 ? '1' : '0.6') : '0.18';
    if (on) lastVisible = i;
  }
  if (lastVisible !== _lastFeedIdx && lastVisible >= 0) {
    _lastFeedIdx = lastVisible;
    rows[lastVisible].scrollIntoView({ block: 'nearest' });
  }
}

function deathList(title, deaths, mode, onJump) {
  const wrap = el('div', { class: 'feed', style: 'max-height:150px;margin-top:6px' }, [el('div', { class: 'muted', style: 'margin-bottom:2px', text: title })]);
  for (const d of deaths.slice().sort((a, b) => a.tMs - b.tMs)) {
    const other = mode === 'victim' ? d.killerName || '—' : d.victimName || '—';
    const verb = mode === 'victim' ? (d.cause === 'killed' || d.cause === 'bled out' || d.cause === 'team-killed' ? 'by' : '·') : '→';
    const tag = [d.weapon, d.distanceM != null ? d.distanceM + ' m' : null, d.headshot ? 'HS' : null].filter(Boolean).join(' · ');
    const susp = d.plausibility && d.plausibility.score < 0.5;
    wrap.append(el('div', { class: 'ev', onclick: () => onJump(d) }, [
      el('span', { class: 'tm', text: fmtClock(d.tMs) }),
      el('span', { html: `${verb} <b>${other}</b> <span class="muted">${tag}</span>${susp ? ' <span style="color:#f87171">⚠</span>' : ''}` })
    ]));
  }
  return wrap;
}

function renderEngagement(panel, d, onJump) {
  panel.classList.remove('hidden');
  clear(panel);
  const causeTxt = { killed: 'Killed', 'bled out': 'Bled out (not revived)', 'gave up': 'Gave up', 'team-killed': 'Team-killed' }[d.cause] || d.cause;
  panel.append(
    el('h3', { text: `Engagement — why ${d.victimName} died` }),
    el('div', { html: `<b style="color:${teamColor(d.victimTeam, true)}">${d.victimName}</b> ${causeTxt}` + (d.killerName ? ` by <b style="color:${teamColor(d.killerTeam, true)}">${d.killerName}</b>` : '') }),
    el('div', { class: 'statline', html:
      `<span>Weapon</span><span>${d.weapon || '—'}</span>` +
      `<span>Distance</span><span class="num">${d.distanceM != null ? d.distanceM + ' m' : '—'}</span>` +
      `<span>Headshot</span><span>${d.headshot ? 'yes' : 'no'}</span>` +
      `<span>Time</span><span class="num">${fmtClock(d.tMs)}</span>` })
  );
  // elevation / line-of-sight — the heart of "why did I die"
  if (d.killerElevationM != null) {
    const hg = d.highGroundM ?? 0;
    const hgTxt = Math.abs(hg) < 1 ? 'about level' : hg > 0 ? `killer +${hg.toFixed(0)} m HIGH GROUND` : `you were +${(-hg).toFixed(0)} m above`;
    panel.append(el('div', { class: 'statline', html:
      `<span>Killer elevation</span><span class="num">${d.killerElevationM.toFixed(0)} m</span>` +
      `<span>Your elevation</span><span class="num">${(d.victimElevationM ?? 0).toFixed(0)} m</span>` +
      `<span>Elevation</span><span class="${hg > 1 ? 'neg' : ''}">${hgTxt}</span>` +
      `<span>Line of sight</span><span class="${d.hasLineOfSight === false ? 'neg' : 'pos'}">${d.hasLineOfSight === false ? 'BLOCKED (terrain)' : 'clear'}</span>` }));
  }
  if (d.elevationProfile) {
    panel.append(el('div', { class: 'muted', style: 'margin-top:6px', text: 'Terrain profile killer → you (red = bullet path)' }));
    const cv = el('canvas', { width: 340, height: 90, style: 'width:100%;height:90px' });
    panel.append(cv);
    drawProfile(cv, d.elevationProfile);
  }
  if (d.plausibility) {
    const s = d.plausibility.score;
    panel.append(el('div', { html: `<span class="muted">Killing-shot plausibility</span> <b style="color:${s < 0.5 ? '#f87171' : '#34d399'}">${s.toFixed(2)}</b>` }));
    if (d.plausibility.flags.length) panel.append(el('div', { style: 'color:#fbbf24;font-size:12px', text: d.plausibility.flags.join(' · ') }));
  }
  if (d.contributors && d.contributors.length) {
    panel.append(el('div', { class: 'muted', style: 'margin-top:8px', text: 'Damage taken this life' }));
    const max = Math.max(...d.contributors.map((c) => c.damage), 1);
    for (const c of d.contributors) {
      const pct = Math.round((c.damage / max) * 100);
      panel.append(el('div', { class: 'kv', html: `<span>${c.name}${c.eosID === d.killerEOSID ? ' <span class="muted">(killer)</span>' : ''}</span><span class="num">${c.damage}</span>` }));
      panel.append(el('div', { style: 'height:4px;background:#1f2c39;border-radius:3px;overflow:hidden;margin:0 0 5px', html: `<div style="height:100%;width:${pct}%;background:${c.eosID === d.killerEOSID ? '#f87171' : '#a78bfa'}"></div>` }));
    }
  }
}

function renderVehicles(panel, bundle, onPick) {
  const vts = bundle.vehicleTracks || [];
  clear(panel).append(el('h3', { text: `Vehicles — ${vts.length} (routes & dwell)` }));
  if (!vts.length) { panel.append(el('div', { class: 'muted', text: 'No vehicle telemetry in this round.' })); return; }
  // group by pool/class
  const groups = {};
  for (const v of vts) (groups[v.pool || 'Other'] ??= []).push(v);
  for (const pool of Object.keys(groups).sort()) {
    panel.append(el('div', { class: 'muted', style: 'margin-top:8px', text: pool }));
    for (const v of groups[pool]) {
      const standMin = (v.standingMs / 60000).toFixed(1);
      const row = el('div', { class: 'ev veh-row', 'data-id': v.id, onclick: () => onPick(v) }, [
        el('span', { class: 'dot', style: `background:${v.team === 1 ? '#3b82f6' : '#ef4444'}` }),
        el('span', { html:
          `<b>${v.type}</b> <span class="muted">T${v.team}</span><br>` +
          `<span class="muted">${(v.distanceM / 1000).toFixed(1)} km · avg ${v.avgSpeedKmh} / max ${v.maxSpeedKmh} km/h · stood ${standMin} min · ${v.dwell.length} holds${v.destroyedMs != null ? ' · <span style="color:#f87171">destroyed</span>' : ''}</span>` })
      ]);
      panel.append(row);
    }
  }
}
function highlightVehRows(panel, id) {
  for (const row of panel.querySelectorAll('.veh-row')) row.style.background = row.getAttribute('data-id') === id ? '#1d2a38' : '';
}

function drawProfile(cv, prof) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = 6;
  const all = prof.ground.concat(prof.line);
  const min = Math.min(...all), max = Math.max(...all), range = max - min || 1;
  const X = (i, n) => pad + (i / (n - 1)) * (W - 2 * pad);
  const Y = (v) => pad + (1 - (v - min) / range) * (H - 2 * pad);
  ctx.clearRect(0, 0, W, H);
  // terrain fill
  ctx.beginPath();
  ctx.moveTo(X(0, prof.ground.length), H - pad);
  prof.ground.forEach((g, i) => ctx.lineTo(X(i, prof.ground.length), Y(g)));
  ctx.lineTo(X(prof.ground.length - 1, prof.ground.length), H - pad);
  ctx.closePath();
  ctx.fillStyle = 'rgba(120,140,160,0.35)'; ctx.fill();
  ctx.strokeStyle = '#8aa0b4'; ctx.lineWidth = 1.5; ctx.beginPath();
  prof.ground.forEach((g, i) => (i ? ctx.lineTo(X(i, prof.ground.length), Y(g)) : ctx.moveTo(X(i, prof.ground.length), Y(g))));
  ctx.stroke();
  // bullet line
  ctx.strokeStyle = '#f87171'; ctx.lineWidth = 2; ctx.beginPath();
  prof.line.forEach((l, i) => (i ? ctx.lineTo(X(i, prof.line.length), Y(l)) : ctx.moveTo(X(i, prof.line.length), Y(l))));
  ctx.stroke();
  // endpoints
  ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(X(0, prof.line.length), Y(prof.line[0]), 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(X(prof.line.length - 1, prof.line.length), Y(prof.line[prof.line.length - 1]), 3, 0, Math.PI * 2); ctx.fill();
}

function sw(color, label) {
  return el('span', {}, [el('span', { class: 'swatch', style: `background:${color}` }), label]);
}
