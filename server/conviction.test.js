import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/utils/analysis.js';
import {
  BLOCKED_SCORE_CAP,
  cleanWeight,
  CONVICTION_FACTORS,
  DEFAULT_FACTOR_SETTINGS,
  FACTOR_DEFAULTS_VERSION,
  factorWeights,
  FNO_ORDERS_SHARE,
  gapScore,
  MAX_FACTOR_WEIGHT,
  migrateFactorSettings,
  weightShares,
} from '../src/utils/conviction.js';
import { normalizePreopen } from './preopen.js';

const master = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((Symbol) => ({ Symbol, Industry: 'Metals' }));
const row = (SYMBOL, pct, extra = {}) => ({
  SYMBOL, 'PREV. CLOSE': 100, 'FINAL PRICE': 100 + pct, CHANGE: pct, '%CHANGE': pct, 'VALUE (₹ Crores)': 5, ...extra,
});

// The version-1 defaults. Tests of the scoring mechanics pin these so they don't
// change whenever the evidence-based defaults are re-derived.
const V1 = {
  gap: { on: true, weight: 20 }, sector: { on: true, weight: 20 }, orders: { on: true, weight: 20 },
  market: { on: true, weight: 15 }, range: { on: true, weight: 15 }, value: { on: true, weight: 10 },
  catalyst: { on: false, weight: 15 }, rvol: { on: false, weight: 15 }, prevRange: { on: false, weight: 15 },
};
const KEYS = CONVICTION_FACTORS.map((f) => f.key);
const settingsWith = (weights) => Object.fromEntries(KEYS.map((k) => [k, { on: (weights[k] ?? 0) > 0, weight: weights[k] ?? 0 }]));

// A tiny seeded RNG so the randomised tests are repeatable.
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test('scores follow the gap direction and every factor is explained', () => {
  const { stocks } = analyze([
    row('AAA', 2, { 'TOTAL BUY QTY': 900, 'TOTAL SELL QTY': 100, '52 WEEK HIGH': 102, '52 WEEK LOW': 50, 'VALUE (₹ Crores)': 50 }),
    row('BBB', 1),
    row('CCC', 2),
    row('DDD', -1, { 'TOTAL BUY QTY': 900, 'TOTAL SELL QTY': 100 }),
    row('EEE', 0),
  ], master, null, { convictionFactors: V1 });
  const [aaa, , , ddd, eee] = stocks;

  // AAA: 2% is in the gap-up sweet spot; only sector, so neutral rank (0.5) + 3 of 5 peers
  // gapped 1%+ (0.6) -> 0.55; 90% buy orders; market 3/5 advancing; at the 52-week high; top value.
  assert.equal(aaa.conviction.direction, 'up');
  assert.deepEqual(aaa.conviction.factors.map((f) => [f.key, Math.round(f.value * 100)]), [
    ['gap', 100], ['sector', 55], ['orders', 90], ['market', 60], ['range', 100], ['value', 100],
  ]);
  assert.equal(aaa.convictionScore, Math.round((20 * 1 + 20 * 0.55 + 20 * 0.9 + 15 * 0.6 + 15 * 1 + 10 * 1)));
  assert.match(aaa.conviction.factors.find((f) => f.key === 'range').detail, /52-week high \(breakout\)/);

  // DDD gapped down but buyers dominate: the order factor counts against it.
  assert.equal(ddd.conviction.direction, 'down');
  assert.equal(Math.round(ddd.conviction.factors.find((f) => f.key === 'orders').value * 100), 10);
  assert.ok(ddd.convictionScore < aaa.convictionScore);

  assert.equal(eee.convictionScore, null);
});

test('gaps under the minimum are not scored', () => {
  const { stocks } = analyze([row('AAA', 0.01, { 'TOTAL BUY QTY': 1000, 'TOTAL SELL QTY': 1 }), row('BBB', -0.49), row('CCC', 0.5)], master);
  assert.deepEqual(stocks.map((s) => s.convictionScore === null), [true, true, false]);
});

test('gap size is an inverted U: moderate gaps score best, big gap-ups fade sooner than gap-downs', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(gapScore(0.5, 1), 0.6);
  near(gapScore(0.75, 1), 1);
  near(gapScore(2, 1), 1);
  near(gapScore(3, 1), 0.65);
  near(gapScore(4, 1), 0.3);
  near(gapScore(8, 1), 0.1);
  near(gapScore(20, 1), 0.1);
  near(gapScore(3, -1), 1); // gap-downs hold to 3%
  near(gapScore(4, -1), 0.65);
  near(gapScore(5, -1), 0.3);
  // Rises to the sweet spot, never rises after it, always within 0.1..1.
  for (const dir of [1, -1]) {
    let prev = gapScore(0.75, dir);
    for (let g = 0.76; g < 25; g += 0.01) {
      const v = gapScore(g, dir);
      assert.ok(v <= prev + 1e-12 && v >= 0.1 && v <= 1, `dir ${dir} gap ${g}: ${v}`);
      prev = v;
    }
  }
  const [small, sweet, big] = analyze([row('AAA', 0.6), row('BBB', 1.5), row('CCC', 3.5)], master).stocks
    .map((s) => s.conviction.factors.find((f) => f.key === 'gap').detail);
  assert.match(small, /small \(full marks 0\.75–2%\)/);
  assert.match(sweet, /sweet spot/);
  assert.match(big, /large gap-ups often fade/);
});

test('F&O stocks give pending buy/sell orders a low weight', () => {
  const secList = { bands: { AAA: 'none', BBB: 20 }, info: {} };
  const extra = { 'TOTAL BUY QTY': 100, 'TOTAL SELL QTY': 900 };
  const [fno, cash] = analyze([row('AAA', 2, extra), row('BBB', 2, extra)], master, secList, { convictionFactors: V1 }).stocks;
  const orders = (s) => s.conviction.factors.find((f) => f.key === 'orders');
  assert.equal(orders(fno).weight, 20 * FNO_ORDERS_SHARE);
  assert.equal(orders(cash).weight, 20);
  assert.ok(fno.convictionScore > cash.convictionScore); // sell-heavy book hurts the F&O stock less
});

test('sector strength ranks sectors by average gap and counts same-direction gappers', () => {
  // Six 5-stock sectors: IT gaps up together, four are flat, one sells off.
  const sectors = { IT: [2, 1.5, 1.2, 1.1, 1], S1: [0.6, 0, 0, 0, 0], S2: [0, 0, 0, 0, 0.1], S3: [0, 0.2, 0, 0, 0], S4: [0, 0, 0.3, 0, 0], WEAK: [-2, -1.5, -1, -1, -0.6] };
  const mk = Object.entries(sectors).flatMap(([sec, gaps]) => gaps.map((g, i) => ({ sym: `${sec}${i}`, sec, g })));
  const r = analyze(mk.map((x) => row(x.sym, x.g)), mk.map((x) => ({ Symbol: x.sym, Industry: x.sec })));
  const sector = (sym) => r.stocks.find((s) => s.symbol === sym).conviction.factors.find((f) => f.key === 'sector');
  assert.equal(sector('IT0').value, 1); // strongest sector, 5 of 5 gapped 1%+
  assert.match(sector('IT0').detail, /#1 of 6 sectors .* 5 stocks gapped \+1% or more/);
  assert.equal(sector('S10').value, 0.5 * 0.8); // avg +0.12%, 2nd strongest (rank 4/5), no 1%+ cluster
  assert.equal(sector('WEAK0').value, 0.5 * 1 + 0.5 * (4 / 5)); // a gap-down wants the weakest sector
});

test('52-week factor rewards breakouts only and is neutral near the lows', () => {
  const r = analyze([
    row('AAA', 2, { '52 WEEK HIGH': 101, '52 WEEK LOW': 50 }), // opens 102: above the high
    row('BBB', 2, { '52 WEEK HIGH': 300, '52 WEEK LOW': 98 }), // near the low: not penalised
    row('CCC', -2, { '52 WEEK HIGH': 150, '52 WEEK LOW': 99 }), // opens 98: below the low
  ], master, null, { convictionFactors: V1 });
  assert.deepEqual(r.stocks.map((s) => s.conviction.factors.find((f) => f.key === 'range').value), [1, 0.5, 1]);
});

test('factors can be turned off or reweighted, and all-off means no score', () => {
  const rows = [row('AAA', 1.5, { 'TOTAL BUY QTY': 100, 'TOTAL SELL QTY': 900 })];
  // Only gap size and orders, equally weighted: (1 + 0.1) / 2. Value is on but at weight 0.
  const only = { ...settingsWith({ gap: 10, orders: 10 }), value: { on: true, weight: 0 } };
  const [a] = analyze(rows, master, null, { convictionFactors: only }).stocks;
  assert.deepEqual(a.conviction.factors.map((f) => f.key), ['gap', 'orders']);
  assert.equal(a.convictionScore, 55);
  assert.deepEqual(a.conviction.excluded, ['Sector strength', 'Market A/D agrees', '52-week breakout', 'Pre-open value',
    'Results catalyst', 'Relative volume', "Gap vs yesterday's range"]);
  assert.deepEqual(a.conviction.missing, []); // turned-off factors are not reported as missing data

  // Settings saved before a factor existed fall back to that factor's default.
  const [b] = analyze(rows, master, null, { convictionFactors: { gap: { on: false, weight: 20 } } }).stocks;
  assert.equal(b.conviction.factors.find((f) => f.key === 'sector').weight, DEFAULT_FACTOR_SETTINGS.sector.weight);
  assert.ok(!b.conviction.factors.some((f) => f.key === 'gap'));

  const off = Object.fromEntries(KEYS.map((k) => [k, { on: false, weight: 20 }]));
  assert.equal(analyze(rows, master, null, { convictionFactors: off }).stocks[0].convictionScore, null);
});

test('missing data drops the factor and rescales the weights', () => {
  const { stocks: [bbb] } = analyze([row('BBB', 1.5)], master, null, { convictionFactors: V1 });
  assert.deepEqual(bbb.conviction.missing, ['Buy/sell orders', '52-week breakout']);
  // gap 1 (sweet spot); sector too small to rank (0.5) with 1 of 5 cluster -> 0.35; market 1; value 1.
  assert.equal(bbb.convictionScore, Math.round(((20 * 1 + 20 * 0.35 + 15 + 10) / 65) * 100));
});

test('NSE import carries the conviction inputs', () => {
  const { rows: [r] } = normalizePreopen({ data: [{
    symbol: 'AAA', prevClose: 100, finalPrice: 103, change: 3, perChange: 3, finalValue: 1e8,
    totalBuyQuantity: 900, totalSellQuantity: 100, finalQuantity: 5000, yearHigh: 120, yearLow: 80,
  }] });
  const { stocks: [aaa] } = analyze([r], master, null, { convictionFactors: V1 });
  assert.deepEqual([aaa.buyQty, aaa.sellQty, aaa.yearHigh, aaa.yearLow], [900, 100, 120, 80]);
  assert.equal(aaa.conviction.missing.length, 0);
});

// ---- Untradeable stocks (item 4) ----

test('T2T and circuit-locked stocks are capped; warnings and tradeable stocks are not', () => {
  const strong = { 'TOTAL BUY QTY': 990, 'TOTAL SELL QTY': 10, 'VALUE (₹ Crores)': 90 };
  const secList = { bands: { AAA: 20, BBB: 5, CCC: 20, DDD: 20 }, info: { DDD: { series: 'EQ', remarks: 'GSM STAGE - 1' } } };
  const [t2t, locked, free, gsm] = analyze([
    row('AAA', 1.5, { ...strong, SERIES: 'BE' }),
    row('BBB', 5, { ...strong, 'BASE PRICE': 100 }), // 5% band: opens at the upper circuit
    row('CCC', 1.5, strong),
    row('DDD', 1.5, strong),
  ], master, secList, { convictionFactors: V1 }).stocks;

  assert.ok(t2t.conviction.rawScore > BLOCKED_SCORE_CAP);
  assert.equal(t2t.convictionScore, BLOCKED_SCORE_CAP);
  assert.deepEqual(t2t.conviction.cappedBy, ['T2T']);
  assert.equal(locked.circuitHit, 'upper');
  assert.equal(locked.convictionScore, BLOCKED_SCORE_CAP);
  assert.deepEqual(locked.conviction.cappedBy, ['At UC']);
  assert.ok(free.convictionScore > BLOCKED_SCORE_CAP);
  assert.equal(free.conviction.cappedBy, null);
  assert.equal(gsm.convictionScore, free.convictionScore); // surveillance is a warning, not a block

  // A blocked stock already below the cap keeps its own (lower) score.
  const [weak] = analyze([row('AAA', -6, { SERIES: 'BZ', 'TOTAL BUY QTY': 999, 'TOTAL SELL QTY': 1 })], master, null,
    { convictionFactors: settingsWith({ gap: 10, orders: 10 }) }).stocks;
  assert.ok(weak.conviction.rawScore < BLOCKED_SCORE_CAP);
  assert.equal(weak.convictionScore, weak.conviction.rawScore);
});

// ---- Pre-open data checks (item 7) ----

test('inconsistent pre-open rows are flagged and left unscored', () => {
  const [nsl, neu, ok] = analyze([
    // 15 Oct 2026 NSLNISP: final 39.68 on base 39.63 but change +2.37 (+5.98%), ₹0 traded.
    { SYMBOL: 'AAA', 'PREV. CLOSE': 39.63, 'BASE PRICE': 39.63, 'FINAL PRICE': 39.68, CHANGE: 2.37, '%CHANGE': 5.98, 'VALUE (₹ Crores)': 0 },
    // NEULANDLAB: final = base, change +150.
    { SYMBOL: 'BBB', 'PREV. CLOSE': 20200, 'BASE PRICE': 20200, 'FINAL PRICE': 20200, CHANGE: 150, '%CHANGE': 0.74, 'VALUE (₹ Crores)': 0 },
    row('CCC', 1.5),
  ], master).stocks;
  assert.match(nsl.dataIssue, /Final price ₹39\.68 but base ₹39\.63 \+ change 2\.37 = ₹42\.00; ₹0 traded in pre-open/);
  assert.equal(nsl.convictionScore, null);
  assert.deepEqual(nsl.flags.map((f) => [f.label, f.severity]), [['Data?', 'warn']]);
  assert.ok(neu.dataIssue);
  assert.equal(neu.convictionScore, null);
  assert.equal(ok.dataIssue, null);
  assert.ok(ok.convictionScore != null);
  assert.ok(!ok.flags.some((f) => f.key === 'data'));
});

test('a base price of 0 falls back to the previous close (ADROITIND, 15 Oct 2026)', () => {
  const [s] = analyze([{
    SYMBOL: 'AAA', 'PREV. CLOSE': 193.02, 'BASE PRICE': 0, 'FINAL PRICE': 197, CHANGE: 3.98, '%CHANGE': 2.06, 'VALUE (₹ Crores)': 0.66,
  }], master, { bands: { AAA: 20 }, info: {} }).stocks;
  assert.equal(s.circuitBase, 193.02);
  assert.equal(s.upperCircuit, 231.62); // 193.02 × 1.2 = 231.624, floored to the ₹0.01 tick
  assert.equal(s.lowerCircuit, 154.42); // 154.416, rounded up to the tick
  assert.equal(s.circuitHit, null);
  assert.equal(s.dataIssue, null); // prev close + change = final, so the row is consistent
});

// ---- Weight system ----

test('default weights: active ones sum to 100 and every factor has a usable weight to turn on with', () => {
  const w = factorWeights(DEFAULT_FACTOR_SETTINGS);
  assert.equal(Object.values(w).reduce((a, b) => a + b, 0), 100);
  for (const f of CONVICTION_FACTORS) {
    assert.equal(f.weight, 20, f.key); // unit weights: "Check all" gives every factor an equal share
    assert.equal(w[f.key], (f.defaultOn ?? true) ? f.weight : 0);
  }
  assert.deepEqual(factorWeights(undefined), w);
  assert.deepEqual(factorWeights(null), w);
  assert.deepEqual(factorWeights({}), w);
});

test('weights: bad values fall back to the default instead of silently switching a factor off', () => {
  const d = DEFAULT_FACTOR_SETTINGS.sector.weight;
  const weightFor = (weight, on = true) => factorWeights({ sector: { on, weight } }).sector;
  assert.equal(weightFor(null), d); // JSON.stringify(NaN) saves null
  assert.equal(weightFor(undefined), d);
  assert.equal(weightFor(''), d);
  assert.equal(weightFor('  '), d);
  assert.equal(weightFor('abc'), d);
  assert.equal(weightFor(NaN), d);
  assert.equal(weightFor(Infinity), d);
  assert.equal(weightFor(true), d);
  assert.equal(weightFor('35'), 35);
  assert.equal(weightFor(12.5), 12.5);
  assert.equal(weightFor(0), 0);
  assert.equal(weightFor(-5), 0);
  assert.equal(weightFor(500), MAX_FACTOR_WEIGHT);
  assert.equal(weightFor(40, false), 0);
  assert.equal(factorWeights({ sector: { on: 'false', weight: 40 } }).sector, 40); // non-boolean "on" -> default (on)
  assert.equal(factorWeights({ range: { weight: 40 } }).range, 0); // "on" missing -> default (off)
  assert.equal(cleanWeight('7'), 7);
  assert.equal(cleanWeight(''), null);
});

test('weight shares are whole numbers that always add up to exactly 100', () => {
  assert.deepEqual(weightShares({ a: 1, b: 1, c: 1 }), { a: 34, b: 33, c: 33 });
  assert.deepEqual(weightShares({ a: 0, b: 0 }), { a: 0, b: 0 });
  assert.deepEqual(weightShares({ a: 5, b: 0 }), { a: 100, b: 0 });
  assert.deepEqual(weightShares(factorWeights(DEFAULT_FACTOR_SETTINGS)),
    { gap: 20, sector: 20, orders: 20, market: 20, range: 0, value: 20, catalyst: 0, rvol: 0, prevRange: 0 });
  const rand = rng(7);
  for (let i = 0; i < 2000; i++) {
    const weights = Object.fromEntries(KEYS.map((k) => [k, rand() < 0.3 ? 0 : Math.round(rand() * 100)]));
    const shares = weightShares(weights);
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    assert.equal(Object.values(shares).reduce((a, b) => a + b, 0), total ? 100 : 0, JSON.stringify(weights));
    for (const k of KEYS) {
      assert.ok(Number.isInteger(shares[k]));
      if (!weights[k]) assert.equal(shares[k], 0);
      else assert.ok(Math.abs(shares[k] - (weights[k] / total) * 100) < 1, `${k} ${JSON.stringify(weights)}`);
    }
  }
});

test('the score is the weighted average of the factors used, for any weights (incl. F&O scaling)', () => {
  const rand = rng(42);
  const secList = { bands: { AAA: 'none', BBB: 20, CCC: 10, DDD: 20, EEE: 20 }, info: {} };
  const rows = [
    row('AAA', 1.2, { 'TOTAL BUY QTY': 700, 'TOTAL SELL QTY': 300, '52 WEEK HIGH': 150, '52 WEEK LOW': 60 }),
    row('BBB', -2.6, { 'TOTAL BUY QTY': 200, 'TOTAL SELL QTY': 800, 'VALUE (₹ Crores)': 40 }),
    row('CCC', 4.4, { 'TOTAL BUY QTY': 10, 'TOTAL SELL QTY': 990, 'VALUE (₹ Crores)': 1 }),
    row('DDD', 0.8),
    row('EEE', -0.9, { 'VALUE (₹ Crores)': 12 }),
  ];
  for (let i = 0; i < 300; i++) {
    const settings = Object.fromEntries(KEYS.map((k) => [k, { on: rand() < 0.7, weight: Math.round(rand() * 120) - 10 }]));
    const weights = factorWeights(settings);
    for (const s of analyze(rows, master, secList, { convictionFactors: settings }).stocks) {
      const c = s.conviction;
      if (!c.factors.length) { assert.equal(c.score, null); continue; }
      let num = 0;
      let den = 0;
      for (const f of c.factors) {
        const expected = weights[f.key] * (f.key === 'orders' && s.band === 'none' ? FNO_ORDERS_SHARE : 1);
        assert.equal(f.weight, expected, `${s.symbol} ${f.key}`);
        assert.ok(f.weight > 0 && f.value >= 0 && f.value <= 1);
        num += f.value * f.weight;
        den += f.weight;
      }
      assert.equal(c.score, Math.round((num / den) * 100));
      assert.ok(c.score >= 0 && c.score <= 100);
      // Every factor is either used, turned off/zero, or missing data -- never lost.
      const seen = [...c.factors.map((f) => f.label), ...c.excluded, ...c.missing];
      assert.deepEqual([...seen].sort(), CONVICTION_FACTORS.map((f) => f.label).sort());
    }
  }
});

test('only relative weights matter: scaling every weight leaves the scores unchanged', () => {
  const rows = [row('AAA', 1.2, { 'TOTAL BUY QTY': 700, 'TOTAL SELL QTY': 300 }), row('BBB', -2.6), row('CCC', 3)];
  const base = settingsWith({ gap: 15, sector: 25, orders: 5, market: 5, value: 25 });
  const scaled = settingsWith({ gap: 45, sector: 75, orders: 15, market: 15, value: 75 });
  const scores = (s) => analyze(rows, master, null, { convictionFactors: s }).stocks.map((x) => x.convictionScore);
  assert.deepEqual(scores(scaled), scores(base));
});

test('checking every factor scores with all nine when their data is there', () => {
  const all = Object.fromEntries(CONVICTION_FACTORS.map((f) => [f.key, { on: true, weight: f.weight }]));
  const context = {
    history: { stats: { AAA: { prevHigh: 101, prevLow: 98, avgVolume: 1000 } } },
    events: { results: { AAA: [{ at: '2026-10-14T11:00:00.000Z', text: 'financial results' }] }, resultsDue: {}, exDates: {} },
  };
  const [a] = analyze([row('AAA', 1.5, {
    'TOTAL BUY QTY': 700, 'TOTAL SELL QTY': 300, '52 WEEK HIGH': 150, '52 WEEK LOW': 60, 'FINAL VOLUME': 500,
  })], master, null, { convictionFactors: all, context }).stocks;
  assert.deepEqual(a.conviction.excluded, []);
  assert.deepEqual(a.conviction.missing, []);
  assert.equal(a.conviction.factors.length, CONVICTION_FACTORS.length);
});

test('saved settings migrate to new defaults only when they were never customised', () => {
  assert.equal(FACTOR_DEFAULTS_VERSION, 2);
  assert.equal(migrateFactorSettings(V1, undefined), DEFAULT_FACTOR_SETTINGS);
  assert.equal(migrateFactorSettings(V1, 1), DEFAULT_FACTOR_SETTINGS);
  // Saved before the last three factors existed.
  const sixKeys = Object.fromEntries(Object.entries(V1).slice(0, 6));
  assert.equal(migrateFactorSettings(sixKeys, undefined), DEFAULT_FACTOR_SETTINGS);
  // Weights saved as strings by an older build still count as the defaults.
  assert.equal(migrateFactorSettings({ ...V1, gap: { on: true, weight: '20' } }, undefined), DEFAULT_FACTOR_SETTINGS);
  // Customised: kept as they are.
  const custom = { ...V1, orders: { on: false, weight: 20 } };
  assert.equal(migrateFactorSettings(custom, undefined), custom);
  const reweighted = { ...V1, sector: { on: true, weight: 30 } };
  assert.equal(migrateFactorSettings(reweighted, 1), reweighted);
  // Already on the current version: never touched, even if equal to an old default set.
  assert.equal(migrateFactorSettings(V1, FACTOR_DEFAULTS_VERSION), V1);
  assert.equal(migrateFactorSettings(null, undefined), DEFAULT_FACTOR_SETTINGS);
  assert.equal(migrateFactorSettings('junk', undefined), DEFAULT_FACTOR_SETTINGS);
});

test('loadSettings applies the migration and stamps the current version', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    const { loadSettings, saveSettings } = await import('../src/store.js');
    store.set('ad_settings_v1', JSON.stringify({ minMarketCapCr: 7000, convictionFactors: V1 }));
    let s = loadSettings();
    assert.equal(s.minMarketCapCr, 7000);
    assert.deepEqual(s.convictionFactors, DEFAULT_FACTOR_SETTINGS);
    assert.equal(s.convictionFactorsVersion, FACTOR_DEFAULTS_VERSION);

    const custom = { ...V1, sector: { on: true, weight: 40 } };
    store.set('ad_settings_v1', JSON.stringify({ convictionFactors: custom }));
    assert.deepEqual(loadSettings().convictionFactors, custom);

    // After saving under the new version, even V1-looking weights are the user's choice.
    saveSettings({ ...loadSettings(), convictionFactors: V1 });
    s = loadSettings();
    assert.deepEqual(s.convictionFactors, V1);
  } finally {
    delete globalThis.localStorage;
  }
});
