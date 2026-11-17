// Launch Radar model: one sealed DefiLlama snapshot in, one ranked board out.
//
// The question the board answers: if this protocol issued a token today and the
// market priced it the way it prices comparable live protocols in this same
// snapshot, what would that token be worth, and what should a reader do about
// it before the launch? The model never predicts that a launch happens.
//
//   implied = TVL x comp x momentum x maturity x breadth
//
//   comp      the category's own price of a TVL dollar, learned from the
//             snapshot itself: the median market-cap / TVL of the live-token
//             protocols in the same category, shrunk toward the market-wide
//             median (0.2049 across 129 live protocols here) by the number of
//             live peers, then clamped to [0.03, 1.00]. A category with many
//             live peers speaks for itself; a thin one (under 3 peers)
//             borrows the market's twice as hard, so a single richly priced
//             peer cannot carry a whole category on its own.
//   momentum  1 + 0.55 x clamp(change_7d, -45, +80) / 100. A hot week lifts a
//             value, a bleeding one cuts it, and neither runs away with it.
//             An unreported change counts as 0 and is flagged, never invented.
//   maturity  0.55 + 0.45 x (1 - exp(-age_days / 620)): a protocol that has
//             held TVL for years with no token is a stronger launch candidate
//             than last month's. Unknown listing dates borrow 150 days and
//             are flagged on the board.
//   breadth   1 + 0.015 x min(chains, 8): each chain a protocol already runs
//             on is distribution a token would inherit, worth a little.
//
// Who may be ranked: a protocol that records no token (no market cap, no
// CoinGecko id, no symbol) and is not a wrapper, stake, bridge or exchange
// product of a token that already trades. The snapshot's watchlist rule is
// applied to the whole universe, not just above its $50M floor, so WBTC,
// exchange balance sheets and versioned pools of tokenised parents never
// appear as "future launches". Live-token protocols are carried separately
// at the market's own values and are never mixed into the ranked board.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, printed on the dashboard so a reader can rerun it. */
export interface ModelConstants {
  shrink_k: number;
  comp_min: number;
  comp_max: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_base: number;
  maturity_span: number;
  maturity_tau_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
}

export const MODEL: ModelConstants = {
  shrink_k: 8,
  comp_min: 0.03,
  comp_max: 1.0,
  growth_weight: 0.55,
  growth_floor: -45,
  growth_cap: 80,
  maturity_base: 0.55,
  maturity_span: 0.45,
  maturity_tau_days: 620,
  unknown_age_days: 150,
  breadth_per_chain: 0.015,
  breadth_max_chains: 8,
};

export const MODEL_VERSION = 'launch-radar-2';

/** One ranked row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  age_estimated: boolean;
  growth_reported: boolean;
  watchlist: boolean;
  implied_value_usd: number;
  model: {
    comp_multiple: number;
    comp_peers: number;
    momentum_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
  };
  farm_steps: string[];
}

/** A live-token protocol, shown at the market's own value and never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  mcap_tvl: number;
}

/** One category's learned comparable: peers counted and the multiple used. */
export interface CategoryComp {
  category: string;
  peers: number;
  median_mcap_tvl: number | null;
  comp_multiple: number;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  global_median_mcap_tvl: number;
  counts: { scanned: number; pre_token: number; ranked: number; watchlist: number; live: number };
  comps: CategoryComp[];
  rows: BoardRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from listing to the snapshot date; null when the date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether the snapshot records no token for this protocol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * Whether a protocol is a genuine future-launch candidate: it records no
 * token and is not a wrapped, staked, bridged, versioned or exchange product
 * of one that already trades. The watchlist passes this test by construction,
 * at any TVL, so coverage never depends on the floor.
 */
export function isCandidate(p: SnapshotProtocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  return true;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The comparable multiples, learned from the snapshot's live-token protocols:
 * each category's median market-cap / TVL, shrunk toward the market median by
 * peer count and clamped. Versioned pools are left out of the peer set, as
 * their ratios price a parent's token, not a standalone launch.
 */
export function categoryComps(snapshot: Snapshot, model: ModelConstants = MODEL): { globalMedian: number; comps: Map<string, CategoryComp> } {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && !VERSIONED.test(p.name));
  const globalMedian = live.length > 0 ? median(live.map((p) => p.mcap_usd! / p.tvl_usd)) : 0.2;
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, list);
  }
  const comps = new Map<string, CategoryComp>();
  for (const [category, ratios] of byCategory) {
    const med = median(ratios);
    const k = ratios.length < 3 ? model.shrink_k * 2 : model.shrink_k;
    const shrunk = (ratios.length * med + k * globalMedian) / (ratios.length + k);
    comps.set(category, {
      category,
      peers: ratios.length,
      median_mcap_tvl: round4(med),
      comp_multiple: round4(Math.min(model.comp_max, Math.max(model.comp_min, shrunk))),
    });
  }
  return { globalMedian: round4(globalMedian), comps };
}

/** The multiple for one protocol's category, or the shrunken market median when it has no live peers. */
function compFor(p: SnapshotProtocol, comps: Map<string, CategoryComp>, globalMedian: number, model: ModelConstants): { multiple: number; peers: number } {
  const found = comps.get(p.category ?? 'Uncategorised');
  if (found !== undefined) return { multiple: found.comp_multiple, peers: found.peers };
  return { multiple: Math.min(model.comp_max, Math.max(model.comp_min, globalMedian)), peers: 0 };
}

/** The four factors and the implied value one protocol gets under the model. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  comps: Map<string, CategoryComp>,
  globalMedian: number,
  model: ModelConstants = MODEL,
): { implied: number; age: number | null; comp: number; peers: number; momentum: number; maturity: number; breadth: number } {
  const age = ageDays(asOf, p.listed_at);
  const { multiple, peers } = compFor(p, comps, globalMedian, model);
  const growth = Math.min(model.growth_cap, Math.max(model.growth_floor, p.change_7d ?? 0));
  const momentum = 1 + (growth / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturity = model.maturity_base + model.maturity_span * (1 - Math.exp(-ageForModel / model.maturity_tau_days));
  const breadth = 1 + model.breadth_per_chain * Math.min(p.chains.length, model.breadth_max_chains);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * maturity * breadth));
  return { implied, age, comp: multiple, peers, momentum, maturity, breadth };
}

/** Capital for one farm position, scaled to the protocol's own size. */
function capitalFor(tvl: number): number {
  if (tvl >= 2_000_000_000) return 500;
  if (tvl >= 500_000_000) return 250;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 25_000_000) return 100;
  return 75;
}

/** The gas a first position costs, from the first chain the protocol names. */
function gasFor(chain: string): string {
  if (chain === 'Ethereum') return 'about $8 of ETH for gas';
  if (chain === 'Solana') return 'under $1 of SOL for fees';
  if (chain === 'Bitcoin') return 'about $3 of BTC for fees';
  return 'about $2 of gas on a low-fee chain';
}

/** Weeks to hold so the activity spans several weekly snapshots, from age. */
function holdWeeksFor(age: number | null): number {
  if (age === null) return 6;
  if (age < 365) return 8;
  if (age < 1095) return 6;
  return 4;
}

type Archetype = 'lend' | 'dex' | 'vault' | 'trade' | 'mint' | 'predict' | 'stake' | 'use';

function archetypeOf(p: SnapshotProtocol): Archetype {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lend';
  if (c.includes('dex') || c.includes('liquidity') || c.includes('leveraged farm') || c === 'farm') return 'dex';
  if (c.includes('deriv') || c.includes('perpetual') || c.includes('option')) return 'trade';
  if (c.includes('prediction')) return 'predict';
  if (c.includes('staking') || c.includes('restak')) return 'stake';
  if (c.includes('rwa') || c.includes('stable') || c.includes('btc') || c.includes('index')) return 'mint';
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('basis')) return 'vault';
  return 'use';
}

/** The archetype's core position, in words a reader can follow on the protocol's own app. */
function coreAction(kind: Archetype, name: string, chain: string, capital: number): string {
  switch (kind) {
    case 'lend': return `Supply $${capital} of USDC as collateral in ${name} on ${chain}, then borrow about 40% of it once and repay within the week, so the wallet shows both sides of the market.`;
    case 'dex': return `Add $${capital} of two-sided liquidity to ${name}'s busiest pool on ${chain} (a stable pair if one exists) and leave the position in range.`;
    case 'vault': return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and keep the vault shares in the same wallet for the whole hold.`;
    case 'trade': return `Deposit $${capital} of USDC margin on ${name} and open one small hedged position (long and short of near-equal size) so volume, not price risk, is what the wallet earns.`;
    case 'mint': return `Mint or buy $${capital} of ${name}'s asset on ${chain} through its own app and hold the asset in the farming wallet, unspent.`;
    case 'predict': return `Fund $${capital} on ${name} and take positions in at least three different markets, sized small, so the wallet reads as a user and not a single bet.`;
    case 'stake': return `Stake $${capital} of the chain's native asset through ${name} on ${chain} and keep the staking position and its receipts untouched.`;
    default: return `Deposit $${capital} of USDC into ${name} on ${chain} through its own app and complete one full use of its main product.`;
  }
}

/** The archetype's second, recurring action. */
function secondAction(kind: Archetype, name: string): string {
  switch (kind) {
    case 'lend': return `Repeat a small supply or repay action on ${name} each week and vote in any governance poll it opens to suppliers.`;
    case 'dex': return `Make one small swap through ${name}'s own interface each week and rebalance the liquidity if it drifts out of range.`;
    case 'vault': return `Add a small top-up deposit to the same ${name} vault each fortnight, so the balance history grows instead of sitting flat.`;
    case 'trade': return `Trade a small hedged position on ${name} twice a week and keep total fees under 1% of the margin over the hold.`;
    case 'mint': return `Use the held asset once inside ${name}'s own ecosystem (as collateral, in a pool, or in a payment) instead of only holding it.`;
    case 'predict': return `Settle every finished market on ${name} promptly and roll the proceeds into the next week's markets.`;
    case 'stake': return `Claim and restake any staking rewards on ${name} once a month, and vote with the staked position when a vote opens.`;
    default: return `Repeat ${name}'s main action in a small size each week, and join any testnet, points or governance programme it announces.`;
  }
}

/**
 * One protocol's farm plan: seven concrete steps, each naming the action, its
 * cost and its time, derived from the protocol's category, chains, TVL and
 * age. The same generator writes every row; no plan is hand-written per name.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalFor(p.tvl_usd);
  const gas = gasFor(chain);
  const weeks = holdWeeksFor(age);
  const kind = archetypeOf(p);
  return [
    `Set up one fresh wallet for ${p.name} alone, fund it on ${chain}, and keep its recovery phrase offline and never in a screenshot. Cost: ${gas} to fund and make the first transaction. Time: 10 minutes.`,
    `${coreAction(kind, p.name, chain, capital)} Cost: $${capital} of capital plus ${gas}. Time: 15 to 20 minutes to set up.`,
    `${secondAction(kind, p.name)} Cost: about $2 of gas a week, less on ${chain} if it is a low-fee chain. Time: 10 minutes a week.`,
    `Hold the position for at least ${weeks} weeks so the activity appears in several weekly snapshots, and never empty the wallet between actions. Cost: the $${capital} stays deployed and earns or loses with the position. Time: ${weeks} weeks.`,
    `Check ${p.name}'s own points, rewards or governance page every week and claim only through a link that page itself publishes. Cost: nothing to check, and never pay anyone a fee to claim an airdrop. Time: 5 minutes a week.`,
    `Keep a farm log with the wallet address, every date, amount and transaction hash, and cap this wallet at 5% of the funds you farm with. Cost: nothing but the log. Time: 5 minutes after each action.`,
    `Exit plan: when a token, a snapshot date or a claim is announced, follow only the protocol's official channels, unwind the position within a week of claiming, and move proceeds to cold storage. Cost: ${gas} to unwind. Time: 30 minutes.`,
  ];
}

/** The ranked board: every candidate, strongest implied value first, ranks 1..N. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; comps: Map<string, CategoryComp>; globalMedian: number } {
  const { globalMedian, comps } = categoryComps(snapshot, model);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isCandidate)
    .map((p) => ({ p, v: impliedValue(p, snapshot.as_of, comps, globalMedian, model) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  const board = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.v.age,
    age_estimated: s.v.age === null,
    growth_reported: s.p.change_7d !== null,
    watchlist: watch.has(s.p.slug),
    implied_value_usd: s.v.implied,
    model: {
      comp_multiple: s.v.comp,
      comp_peers: s.v.peers,
      momentum_multiplier: round4(s.v.momentum),
      maturity_multiplier: round4(s.v.maturity),
      breadth_multiplier: round4(s.v.breadth),
    },
    farm_steps: farmSteps(s.p, s.v.age),
  }));
  return { board, comps, globalMedian };
}

/** The live-token set, at the market's own values, for the dashboard's separate view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && !VERSIONED.test(p.name))
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || b.tvl_usd - a.tvl_usd)
    .slice(0, 36)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      mcap_tvl: round4(p.mcap_usd! / Math.max(1, p.tvl_usd)),
    }));
}

/** Everything the dashboard renders, plus the counts its headline states. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { board, comps, globalMedian } = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    global_median_mcap_tvl: globalMedian,
    counts: {
      scanned: snapshot.protocols.length,
      pre_token: snapshot.protocols.filter(recordsNoToken).length,
      ranked: board.length,
      watchlist: snapshot.watchlist.length,
      live: snapshot.protocols.filter((p) => p.mcap_usd !== null).length,
    },
    comps: [...comps.values()].sort((a, b) => b.peers - a.peers),
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null when it is. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100 row floor`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
