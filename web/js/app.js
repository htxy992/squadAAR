import { getJSON, el, clear, fmtDate, fmtClock } from './util.js';
import { renderAAR } from './aar.js';
import { renderLeaderboard } from './leaderboard.js';
import { renderPlayer } from './player.js';

const view = document.getElementById('view');

document.querySelector('.brand').addEventListener('click', () => (location.hash = '#/rounds'));

async function renderRounds() {
  clear(view).append(el('h1', { class: 'page-title', text: 'Recent rounds' }));
  let rounds = [];
  try { rounds = await getJSON('/api/rounds'); } catch {}
  if (!rounds.length) {
    view.append(el('div', { class: 'panel prose', html:
      '<p>No rounds ingested yet.</p><p>Generate the bundled sample and ingest it:</p>' +
      '<pre class="mono">npm run demo</pre><p>…or ingest a real server log:</p>' +
      '<pre class="mono">npm run ingest -- /path/to/SquadGame.log</pre>' }));
    return;
  }
  const grid = el('div', { class: 'rounds-grid' });
  for (const r of rounds) {
    grid.append(el('div', { class: 'round-card', onclick: () => (location.hash = `#/aar/${encodeURIComponent(r.id)}`) }, [
      el('div', { class: 'map', text: r.mapName }),
      el('div', { class: 'layer', text: `${r.layer} · ${fmtDate(r.startTime)}` }),
      el('div', { class: 'row', html: `<span class="muted">Result</span><span class="badge win${r.winnerTeam}">Team ${r.winnerTeam ?? '?'} won</span>` }),
      el('div', { class: 'row', html: `<span class="muted">Tickets</span><span class="tickets"><span class="t1">${r.finalTickets?.[1] ?? '—'}</span> – <span class="t2">${r.finalTickets?.[2] ?? '—'}</span></span>` }),
      el('div', { class: 'row', html: `<span class="muted">Players · Length</span><span>${r.playerCount} · ${fmtClock(r.durationMs)}</span>` }),
      el('div', { class: 'row', html: `<span class="muted">Flagged shots</span>${r.suspiciousShots ? `<span class="badge flag">⚠ ${r.suspiciousShots}</span>` : '<span class="muted">none</span>'}` })
    ]));
  }
  view.append(grid);
}

function renderAbout() {
  clear(view).append(el('div', { class: 'panel prose' }, [el('div', { html: ABOUT_HTML })]));
}

const ABOUT_HTML = `
<h1>SquadAAR</h1>
<p>A <b>server-side After-Action-Report</b> system for Squad with an integrated
<b>SquadElo</b> rating system. It parses Squad dedicated-server logs into an event
timeline, reconstructs the round, computes <b>SquadPoints</b> and <b>SquadElo</b>,
and renders an interactive 2D map replay — modelled on the SK Discord
<i>SquadStats / SquadElo</i> design.</p>
<h3>Pipeline</h3>
<p><code>log → parser → event timeline → SquadPoints → SquadElo → AAR</code></p>
<ul>
<li><b>Parser</b> — vanilla dedicated-server lines (kills, wounds, revives, damage,
possess, tickets, round result) in the exact SquadJS syntax, plus extended
<code>LogSquadStats:</code> telemetry (positions, cap zones, FOBs, projectiles).</li>
<li><b>SquadPoints</b> — ticket-based points (wounds via damage-share, flags, FOB &
vehicle destruction with component multipliers) and support points (revives,
heals, logistics), with objective & headshot multipliers.</li>
<li><b>SquadElo</b> — per class/vehicle pool free-for-all comparisons with a
Margin-of-Victory multiplier, a standardized global Elo, team-balance win
probability, and time decay.</li>
<li><b>Projectile analysis</b> — every shot is reconstructed and scored for
plausibility from a terrain-height field (sightline / line-of-sight occlusion),
weapon range and firing angle, surfacing wallbangs and impossible shots for the
Auto-Mod / cheater-detection workflow.</li>
</ul>
<h3>Map replay & engagements</h3>
<p>Every map is calibrated to its real Squad SDK world bounds; drop in the
in-game minimap with <code>npm run fetch:maps</code> to render maps like
SquadCalc, or use the built-in <b>terrain hillshade</b> with toggleable
<b>contours</b> and an <b>elevation heatmap</b> to read ridgelines and high
ground. Scrub or play the round back. Players show team, view direction, wounded
state; vehicles show hull HP, turret facing, component status and pool; flags
show capture progress. <b>Bullets are animated</b> along their trajectory with
muzzle flashes, tracer streaks and impact markers (hit vs miss); <b>mortar /
indirect fire</b> arcs in and bursts with a blast-radius ring; suspicious shots
draw red. <b>Vehicle analysis</b> overlays routes, a movement heatmap and dwell
markers (where vehicles stood), with a Vehicles panel grouped by class &amp; type
— click one to trace its route.</p>
<p>Click a player — or any kill in the feed — to open the
<b>1v1 engagement / "why you died"</b> view: the killer→victim sightline and
distance, weapon, headshot, <b>elevation / high-ground</b>, <b>line-of-sight
(clear or blocked by terrain)</b> with a <b>terrain cross-section profile</b> of
the shot, killing-shot plausibility, and the full damage-taken-this-life
breakdown — a definitive answer to “why did I die?”.</p>
<p class="muted">The provided logs were client-side and lack combat/position
events, so the bundled sample is a synthetic <i>server</i> log in the exact same
format — swap in real server logs with <code>npm run ingest</code>.</p>
`;

async function route() {
  const hash = location.hash || '#/rounds';
  const [, page, arg] = hash.split('/');
  document.body.classList.toggle('aar-mode', page === 'aar');
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.getAttribute('data-tab') === page));
  try {
    if (page === 'aar' && arg) await renderAAR(view, decodeURIComponent(arg));
    else if (page === 'leaderboard') await renderLeaderboard(view);
    else if (page === 'player' && arg) await renderPlayer(view, decodeURIComponent(arg));
    else if (page === 'about') renderAbout();
    else await renderRounds();
  } catch (e) {
    clear(view).append(el('div', { class: 'loading', text: 'Error: ' + e.message }));
    console.error(e);
  }
}

window.addEventListener('hashchange', route);
route();
