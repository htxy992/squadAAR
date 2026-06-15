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
  const cards = el('div', { class: 'rounds-grid' });
  cards.append(card('Global Elo', elo ? Math.round(elo.global) : '—', `${elo?.games ?? 0} rated rounds`));
  cards.append(card('Rounds', agg.rounds, `${Math.round(agg.points)} total points`));
  cards.append(card('K / W / D', `${agg.kills} / ${agg.wounds} / ${agg.deaths}`, `${agg.revives} revives`));
  cards.append(card('Longest kill', `${agg.longestKillM} m`, `dmg ${Math.round(agg.damageInf)} inf · ${Math.round(agg.damageVeh)} veh`));
  view.append(cards);

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
