// Launch Radar dashboard: renders window.RADAR (written by main.ts beside
// this page as ../data.js). No fetch, no network: filters, sorts, the live
// view and the detail panel all run on the data the program handed in.
// State lives in the location hash (#d=slug, #cat=, #watch=1, #sort=…) so a
// view can be linked, screenshotted and reproduced exactly.
'use strict';
const R = window.RADAR;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const commas = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const money = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${commas(n)}`);
const pct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}%`);
const ageText = (d, est) => (d === null ? 'unknown' : d >= 730 ? `${(d / 365).toFixed(1)} yrs` : d >= 60 ? `${Math.round(d / 30.4)} mo` : `${d} d`) + (est ? ' (est.)' : '');

const state = { view: 'board', q: '', cat: '', chain: '', min: 0, watch: false, sort: 'rank', d: '' };
function readHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (h.get('view') === 'live') state.view = 'live';
  state.q = h.get('q') || ''; state.cat = h.get('cat') || ''; state.chain = h.get('chain') || '';
  state.min = Number(h.get('min') || 0); state.watch = h.get('watch') === '1';
  state.sort = h.get('sort') || 'rank'; state.d = h.get('d') || '';
}
function writeHash() {
  const h = new URLSearchParams();
  if (state.view === 'live') h.set('view', 'live');
  if (state.q) h.set('q', state.q); if (state.cat) h.set('cat', state.cat); if (state.chain) h.set('chain', state.chain);
  if (state.min) h.set('min', String(state.min)); if (state.watch) h.set('watch', '1');
  if (state.sort !== 'rank') h.set('sort', state.sort); if (state.d) h.set('d', state.d);
  history.replaceState(null, '', `#${h.toString()}`);
}

function renderStats() {
  const c = R.counts;
  const top = R.rows[0];
  $('stats').innerHTML = [
    [commas(c.scanned), 'protocols scanned', ''],
    [commas(c.ranked), 'pre-token, ranked', 'hot'],
    [`${c.watchlist} / ${c.watchlist}`, 'watchlist covered', ''],
    [money(top.implied_value_usd), `top call: ${esc(top.name)}`, ''],
    [commas(c.live), 'already have a token', ''],
  ].map(([n, l, cls]) => `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
  $('stamp').innerHTML = `Snapshot <b>${esc(R.as_of)}</b><br>${esc(R.source.split(', fetched')[0])}<br>fetched ${esc((R.source.split('fetched ')[1] || '').trim())}`;
}

function renderModel() {
  const comps = R.comps.filter((c) => c.peers >= 3).slice(0, 8)
    .map((c) => `${esc(c.category)} <b>${c.comp_multiple.toFixed(2)}x</b> (${c.peers} live)`).join(' · ');
  $('model').innerHTML = `<h2>How a value is implied — model ${esc(R.model_version)}</h2>
    <p>Every live protocol in this snapshot prices a dollar of TVL. A pre-token protocol is valued with the
    multiple its own category already trades at, adjusted for its week, its age and its reach. Nothing here
    predicts that a token is issued; the figure is what a launch could be worth if it were priced like its peers.</p>
    <div class="formula">implied = TVL x category multiple x momentum (7d) x maturity (age) x breadth (chains)</div>
    <p class="comps">Category multiples learned from this snapshot (market median ${R.global_median_mcap_tvl.toFixed(2)}x): ${comps}</p>`;
}

function fillSelects() {
  const cats = [...new Set(R.rows.map((r) => r.category || 'Uncategorised'))].sort();
  $('cat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  $('chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');
  $('cat').value = state.cat; $('chain').value = state.chain;
  $('q').value = state.q; $('min-tvl').value = String(state.min);
  $('watch').checked = state.watch; $('sort').value = state.sort;
}

function visibleRows() {
  let rows = R.rows.filter((r) =>
    (!state.cat || (r.category || 'Uncategorised') === state.cat) &&
    (!state.chain || r.chains.includes(state.chain)) &&
    (!state.watch || r.watchlist) &&
    (r.tvl_usd >= state.min) &&
    (!state.q || `${r.name} ${r.slug}`.toLowerCase().includes(state.q.toLowerCase())));
  const by = {
    rank: (a, b) => a.rank - b.rank,
    tvl: (a, b) => b.tvl_usd - a.tvl_usd,
    chg: (a, b) => (b.change_7d ?? -1e9) - (a.change_7d ?? -1e9),
    age: (a, b) => (b.age_days ?? -1) - (a.age_days ?? -1),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return rows.sort(by[state.sort] || by.rank);
}

function renderBoard() {
  const rows = visibleRows();
  const max = Math.max(...R.rows.map((r) => r.implied_value_usd));
  $('rows').innerHTML = rows.map((r) => `<tr data-slug="${esc(r.slug)}" class="${r.slug === state.d ? 'sel' : ''}">
    <td class="num">${r.rank}</td>
    <td><span class="pname">${esc(r.name)}</span>${r.watchlist ? '<span class="badge">Watchlist</span>' : ''}<br><span class="pcat">${esc(r.category || 'Uncategorised')} · ${esc(r.chains.slice(0, 3).join(', '))}${r.chains.length > 3 ? ` +${r.chains.length - 3}` : ''}</span></td>
    <td class="num">${money(r.tvl_usd)}</td>
    <td class="num ${r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</td>
    <td class="num">${ageText(r.age_days, r.age_estimated)}</td>
    <td class="num"><b>${money(r.implied_value_usd)}</b></td>
    <td class="signal"><div class="bar"><div class="fill" style="width:${Math.max(2, Math.round((r.implied_value_usd / max) * 100))}%"></div></div><span class="cap">${(r.implied_value_usd / r.tvl_usd).toFixed(2)}x TVL</span></td>
  </tr>`).join('');
  $('count').textContent = `${rows.length} of ${R.rows.length} ranked protocols shown. Every watchlist protocol is on the board; wrapped, staked, bridged and exchange products of tokens that already trade are kept off it, on purpose.`;
  for (const tr of $('rows').children) tr.addEventListener('click', () => { state.d = tr.dataset.slug; writeHash(); renderBoard(); renderDetail(); });
}

function renderLive() {
  $('live-rows').innerHTML = R.live.map((r) => `<tr data-slug="">
    <td><span class="pname">${esc(r.name)}</span><br><span class="pcat">${esc(r.category || 'Uncategorised')} · ${esc(r.chains.slice(0, 3).join(', '))}</span></td>
    <td class="num"><b>${money(r.mcap_usd)}</b></td><td class="num">${money(r.tvl_usd)}</td>
    <td class="num">${r.mcap_tvl.toFixed(2)}x</td>
    <td class="num ${r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</td></tr>`).join('');
}

function factor(label, mult, lo, hi, cls, why) {
  const w = Math.max(4, Math.min(100, ((mult - lo) / (hi - lo)) * 100));
  return `<div class="factor"><div class="fl"><span>${label}</span><b>x${mult.toFixed(3)}</b></div><div class="bar"><div class="fill ${cls}" style="width:${w}%"></div></div><div class="cap" style="font-size:11.5px;color:var(--faint)">${why}</div></div>`;
}

function renderDetail() {
  const r = R.rows.find((x) => x.slug === state.d) || R.rows[0];
  if (!r) { $('detail').innerHTML = '<p class="note">No protocol selected.</p>'; return; }
  state.d = r.slug;
  const m = r.model;
  $('detail').innerHTML = `<h2>${esc(r.name)}${r.watchlist ? '<span class="badge">Watchlist</span>' : ''}</h2>
    <p class="sub">Rank #${r.rank} of ${R.rows.length} · ${esc(r.category || 'Uncategorised')} · records no token in this snapshot</p>
    <div class="big"><small>Implied launch value</small>${money(r.implied_value_usd)}</div>
    <div class="kv">
      <span class="k">TVL</span><span class="v">${money(r.tvl_usd)}</span>
      <span class="k">7d change</span><span class="v">${pct(r.change_7d)}${r.growth_reported ? '' : ' (unreported)'}</span>
      <span class="k">Tracked since</span><span class="v">${esc(r.listed_at || 'unknown')}</span>
      <span class="k">Age</span><span class="v">${ageText(r.age_days, r.age_estimated)}</span>
      <span class="k">Implied / TVL</span><span class="v">${(r.implied_value_usd / r.tvl_usd).toFixed(2)}x</span>
      <span class="k">Watchlist floor</span><span class="v">${money(R.floor_usd)}</span>
    </div>
    <div class="factors">
      ${factor('Category multiple', m.comp_multiple, 0, 1.0, 'g', `${esc(r.category || 'Uncategorised')} trades at this x TVL across ${m.comp_peers} live peers in the snapshot`)}
      ${factor('Momentum (7d)', m.momentum_multiplier, 0.6, 1.5, '', 'the week\'s TVL change, softened so one week cannot carry a valuation')}
      ${factor('Maturity (age)', m.maturity_multiplier, 0.5, 1.0, 'a', 'years live with no token is evidence a launch, if it comes, is earned')}
      ${factor('Breadth (chains)', m.breadth_multiplier, 1.0, 1.12, '', `${r.chains.length} chain${r.chains.length === 1 ? '' : 's'} of distribution a token would inherit`)}
    </div>
    <div class="chips">${r.chains.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
    <h3>Farm plan — before any launch</h3>
    <ol class="steps">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <p class="note">A plan is a starting position, not advice: protocols can fail, contracts can be exploited, and most
    pre-token protocols never issue anything. The implied value is this board's own claim from the snapshot's figures,
    never a promise by the protocol.</p>`;
}

function applyView() {
  $('view-board').classList.toggle('on', state.view === 'board');
  $('view-live').classList.toggle('on', state.view === 'live');
  $('board').classList.toggle('hidden', state.view !== 'board');
  $('live-table').classList.toggle('hidden', state.view !== 'live');
  $('count').style.display = state.view === 'board' ? '' : 'none';
}

function bind() {
  const upd = () => { writeHash(); renderBoard(); };
  $('q').addEventListener('input', (e) => { state.q = e.target.value; upd(); });
  $('cat').addEventListener('change', (e) => { state.cat = e.target.value; upd(); });
  $('chain').addEventListener('change', (e) => { state.chain = e.target.value; upd(); });
  $('min-tvl').addEventListener('change', (e) => { state.min = Number(e.target.value); upd(); });
  $('watch').addEventListener('change', (e) => { state.watch = e.target.checked; upd(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; upd(); });
  $('view-board').addEventListener('click', () => { state.view = 'board'; writeHash(); applyView(); });
  $('view-live').addEventListener('click', () => { state.view = 'live'; writeHash(); applyView(); });
}

readHash();
renderStats(); renderModel(); fillSelects(); bind();
renderBoard(); renderLive(); renderDetail(); applyView();
$('foot').textContent = `Source: ${R.source}. The board ranks protocols that record no token in that snapshot; "records no token" is what the data says, not proof none exists. Implied values follow the model printed above from the snapshot's own figures alone.`;
