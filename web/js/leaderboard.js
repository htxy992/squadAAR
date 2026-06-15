import { getJSON, el, clear } from './util.js';

export async function renderLeaderboard(view) {
  clear(view);
  const pools = await getJSON('api/pools').catch(() => ['global']);
  const sel = el('select', {}, pools.map((p) => el('option', { value: p }, p)));
  const body = el('div');
  view.append(
    el('h1', { class: 'page-title', text: 'Leaderboard' }),
    el('div', { class: 'controls' }, [el('span', { class: 'muted', text: 'Pool:' }), sel]),
    body
  );
  async function load() {
    clear(body).append(el('div', { class: 'loading', text: 'Loading…' }));
    const { pool, rows } = await getJSON(`api/leaderboard/${encodeURIComponent(sel.value)}`);
    clear(body);
    if (!rows.length) { body.append(el('div', { class: 'muted', text: 'No rated players yet for this pool.' })); return; }
    const table = el('table');
    table.append(el('tr', {}, ['#', 'Player', `${pool} Elo`, 'Games'].map((h, i) => el('th', { class: i >= 2 ? 'num' : '' }, h))));
    rows.forEach((r, i) => {
      table.append(el('tr', { class: 'click', onclick: () => (location.hash = `#/player/${r.eosID}`) }, [
        el('td', { class: 'num', text: i + 1 }),
        el('td', { text: r.name }),
        el('td', { class: 'num', text: r.elo }),
        el('td', { class: 'num', text: r.games })
      ]));
    });
    body.append(table);
  }
  sel.onchange = load;
  await load();
}
