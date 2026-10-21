import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAuctionLayer, AUCTION_FACTORS, auctionFeatures, auctionLayerFactors, closeOfEntryAt } from '../src/utils/auctionLayer.js';
import { AUCTION_END_MS, auctionFile, createAuctionTracker, SWEEP_EVERY_MS } from '../src/core/auctionTracker.js';
import { analyze } from '../src/utils/analysis.js';
import { CONVICTION_FACTORS, DEFAULT_FACTOR_SETTINGS } from '../src/utils/conviction.js';
import { buildReportCard } from '../src/utils/reportCard.js';
import { KiteError } from '../src/core/kite.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const DATE = '2026-10-20'; // a Tuesday
const calendar = { years: { 2026: { holidays: {} } } };
const at = (time) => +new Date(`${DATE}T${time}+05:30`);

/**
 * A recorded morning: AAA gaps up and builds (1% at 09:04 → 2% at 09:08), BBB's gap-up fades,
 * NIFTY's future is up 0.5%. Keys: 0 NSE:AAA, 1 NSE:BBB, 2 AAA future, 3 NIFTY future.
 */
const saved = {
  version: 1,
  date: DATE,
  keys: ['NSE:AAA', 'NSE:BBB', 'NFO:AAA26OCTFUT', 'NFO:NIFTY26OCTFUT'],
  meta: [[100, 90, 105], [200, 160, 240], [101, null, null], [25000, null, null]],
  futures: { AAA: 'NFO:AAA26OCTFUT', NIFTY: 'NFO:NIFTY26OCTFUT' },
  snaps: [
    { t: at('09:01:00'), q: [[0, 0, 0, 0, 0, null], [1, 204, 100, 600, 400, 50]] }, // AAA has no price yet
    { t: at('09:03:00'), q: [[0, 100.5, 500, 500, 500, 0], [1, 204, 200, 600, 400, 100]] },
    { t: at('09:04:00'), q: [[0, 101, 1000, 600, 400, 200], [1, 204, 300, 600, 400, 100], [2, 102, 50, 10, 10, 0], [3, 25100, 10, 5, 5, 0]] },
    { t: at('09:08:30'), q: [[0, 102, 2000, 800, 200, 2000], [1, 201, 400, 400, 600, 100], [2, 103.53, 80, 10, 10, 0], [3, 25125, 20, 5, 5, 0]] },
  ],
};

test('features: final and 09:04 gaps, order shares, futures and the index future', () => {
  const f = auctionFeatures(saved);
  assert.equal(f.snaps, 4);
  assert.equal(f.instruments, 4);
  const a = f.symbols.AAA;
  close(a.gap, 2);
  close(a.earlyGap, 1);
  assert.equal(a.readings, 3); // the 09:01 reading had no indicative price
  close(a.buyShare, 0.8);
  close(a.avgBuyShare, (0.5 + 0.6 + 0.8) / 3);
  assert.equal(a.upperCircuit, 105);
  close(a.future.gap, 2.5049504950495);
  close(f.market.nifty.gap, 0.5);
  assert.equal(f.market.bank, null);
  assert.equal(auctionFeatures(null), null);
  assert.equal(auctionFeatures({ ...saved, snaps: [] }), null);
});

test('factors read in the gap direction', () => {
  const f = auctionFeatures(saved);
  const stock = (sym) => ({ symbol: sym, auction: { ...f.symbols[sym], market: f.market } });
  const up = auctionLayerFactors(stock('AAA'), 1);
  // The gap doubled from 1% to 2%: full marks for a gap-up, zero for a gap-down.
  assert.equal(up.aDrift.value, 1);
  assert.match(up.aDrift.detail, /built/);
  assert.equal(auctionLayerFactors(stock('AAA'), -1).aDrift.value, 0);
  // Buy share 80% at the end vs 63% on average: +17 points, capped at full marks.
  assert.equal(up.aOrdersHeld.value, 1);
  // 2,000 unmatched on the buy side = 1× the 2,000 matched: full marks.
  assert.equal(up.aImbalance.value, 1);
  // Future +2.50% vs cash +2.00%: about +0.5 pts, nearly full marks.
  close(up.aFutures.value, 0.5 + 0.5 * (0.5049504950495 / 0.5 > 1 ? 1 : 0.5049504950495 / 0.5));
  // 105 / 102 − 1 = 2.94% room: just under full marks.
  close(up.aRoom.value, (105 / 102 - 1) * 100 / 3);
  // Nifty future +0.5%: halfway to full marks.
  close(up.aNifty.value, 0.75, 1e-9);

  // BBB: the 2% gap-up faded to 0.5% and buyers were pulled late.
  const b = auctionLayerFactors(stock('BBB'), 1);
  close(b.aDrift.value, 0.5 + 0.5 * Math.max(-1, (0.5 - 2) / 2));
  assert.match(b.aDrift.detail, /faded/);
  assert.ok(b.aOrdersHeld.value < 0.5);
  assert.equal(b.aFutures, undefined); // no future
  assert.deepEqual(auctionLayerFactors({ auction: null }, 1), {});
});

test('the imbalance is read before the matching, when Kite resets it to 0 for every stock', () => {
  // As on 21 Oct 2026: imbalances live through 09:08:30, then 0 everywhere after the matching.
  const after = (time) => ({ t: at(time), q: [[0, 102, 2100, 800, 200, 0], [1, 201, 450, 400, 600, 0]] });
  const withMatching = { ...saved, snaps: [...saved.snaps, after('09:09:10'), after('09:09:30')] };
  const f = auctionFeatures(withMatching);
  assert.equal(f.symbols.AAA.imbalance, 0); // the last reading
  assert.equal(f.symbols.AAA.imbalanceAtClose, 2000); // the close-of-entry reading
  assert.equal(f.symbols.AAA.closeAt, at('09:08:30'));
  const up = auctionLayerFactors({ auction: { ...f.symbols.AAA, market: f.market } }, 1);
  assert.equal(up.aImbalance.value, 1); // 2,000 unmatched ÷ 2,000 matched, as before the matching
  assert.match(up.aImbalance.detail, /09:08:30/);
  assert.equal(closeOfEntryAt([{ t: 1, q: [[0, 1, 1, 1, 1, 0]] }]), null); // no imbalance data at all
});

test('a negative imbalance is taken as the sell side', () => {
  const a = { volume: 100, buyQty: 900, sellQty: 100, imbalance: -50 };
  assert.equal(auctionLayerFactors({ auction: a }, -1).aImbalance.value, 0.75);
});

test('the layer sits on top: default scores unchanged, separate Auction score, factors join only when on', () => {
  const master = ['AAA', 'BBB'].map((Symbol) => ({ Symbol, Industry: 'Metals' }));
  const row = (SYMBOL, prev, final) => ({ SYMBOL, 'PREV. CLOSE': prev, 'FINAL PRICE': final, CHANGE: final - prev, '%CHANGE': ((final - prev) / prev) * 100, 'VALUE (₹ Crores)': 5 });
  const rows = [row('AAA', 100, 102), row('BBB', 200, 201)];
  const auction = auctionFeatures(saved);
  const plain = analyze(rows, master, null, {}).stocks;
  const withAuction = analyze(rows, master, null, { context: { auction } }).stocks;
  const a = withAuction.find((s) => s.symbol === 'AAA');
  assert.ok(AUCTION_FACTORS.every((f) => DEFAULT_FACTOR_SETTINGS[f.key].on === false));
  assert.equal(a.convictionScore, plain.find((s) => s.symbol === 'AAA').convictionScore);
  assert.ok(!a.conviction.factors.some((f) => f.group === 'auction'));
  // Separate score: the stock's own five factors (not the Nifty reading), equal weights.
  assert.equal(a.auctionLayer.coverage, '5/5');
  const own = a.auctionLayer.factors.reduce((sum, f) => sum + f.value, 0) / 5;
  assert.equal(a.auctionScore, Math.round(own * 100));
  assert.ok(withAuction.find((s) => s.symbol === 'BBB').auctionScore < a.auctionScore);
  assert.equal(plain[0].auctionScore, null);

  const on = { ...DEFAULT_FACTOR_SETTINGS, ...Object.fromEntries(AUCTION_FACTORS.map((f) => [f.key, { on: true, weight: 20 }])) };
  const included = analyze(rows, master, null, { convictionFactors: on, context: { auction } }).stocks.find((s) => s.symbol === 'AAA');
  assert.deepEqual(included.conviction.factors.filter((f) => f.group === 'auction').map((f) => f.key), AUCTION_FACTORS.map((f) => f.key));
  assert.notEqual(included.convictionScore, a.convictionScore);
  assert.equal(CONVICTION_FACTORS.filter((f) => f.group === 'auction').length, AUCTION_FACTORS.length);
});

test('separate score needs two factors and a scored gap', () => {
  const stocks = [
    { symbol: 'A', conviction: { direction: 'up' }, auction: { iep: 101, upperCircuit: 110 } }, // room only
    { symbol: 'B', conviction: null, auction: saved },
  ];
  applyAuctionLayer(stocks);
  assert.equal(stocks[0].auctionScore, null);
  assert.equal(stocks[0].auctionLayer.coverage, '1/5');
  assert.equal(stocks[1].auctionLayer, null);
});

test('report card ranks the top picks by Auction score', () => {
  const trade = (symbol, auction, ret) => ({ date: 'd', symbol, dir: 1, gap: 1, score: 50, auction, tradeable: true, factors: {}, ret, best: ret, worst: 0, filled: false });
  const card = buildReportCard([{ date: 'd', trades: [trade('A', 90, 2), trade('B', null, -3), trade('C', 40, 1)] }]);
  assert.equal(card.picks.up.auction.n, 2);
  assert.equal(card.picks.up.auction.continued, 1);
});

// --- The recorder ---------------------------------------------------------------------------

function memoryStore() {
  const files = new Map();
  return {
    files,
    read: async (name) => (files.has(name) ? structuredClone(files.get(name)) : null),
    write: async (name, value) => { files.set(name, structuredClone(value)); },
  };
}

/** A clock and timers that run only when the test advances them. */
function fakeClock(start) {
  let t = start;
  let timers = [];
  return {
    now: () => new Date(t),
    setTimer: (fn, ms) => { const id = { at: t + ms, fn }; timers.push(id); return id; },
    clearTimer: (id) => { timers = timers.filter((x) => x !== id); },
    /** Run every timer due by `until`, in order, letting each sweep finish. */
    async runUntil(until) {
      for (;;) {
        const next = timers.filter((x) => x.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((x) => x !== next);
        t = next.at;
        next.fn();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await new Promise((r) => setImmediate(r));
      }
      t = until;
    },
  };
}

const instruments = {
  load: async () => ({
    equity: (s) => (['AAA', 'BBB'].includes(s) ? { token: 1 } : null),
    future: (s) => ({ AAA: { tradingsymbol: 'AAA26OCTFUT' }, NIFTY: { tradingsymbol: 'NIFTY26OCTFUT' } })[s] ?? null,
  }),
};

function fakeKite({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    quote: async ({ instruments: list, accessToken }) => {
      calls.push({ list, accessToken });
      if (fail) throw fail;
      return Object.fromEntries(list.map((k, i) => [k, {
        ohlc: { open: 100 + calls.length, close: 100 }, volume: 10 * calls.length, buy_quantity: 60, sell_quantity: 40,
        total_imbalance_qty: 5, lower_circuit_limit: 80, upper_circuit_limit: 120 + i,
      }]));
    },
  };
}

test('recorder: arms before 09:00, reads every 15 s until 09:09:45, then finishes', async () => {
  const clock = fakeClock(at('08:58:00'));
  const store = memoryStore();
  const kite = fakeKite();
  const tracker = createAuctionTracker({
    store, kite, instruments, calendar, symbols: () => ['AAA', 'BBB', 'ZZZ', 'aaa'], wait: async () => {}, ...clock,
  });
  tracker.setSession({ apiKey: 'key', accessToken: 'token123' });
  await tracker.wake();
  assert.equal(tracker.status().phase, 'waiting');
  await clock.runUntil(at('09:00:05'));
  const file = store.files.get(auctionFile(DATE));
  // ZZZ is not in Kite's instruments; duplicates are dropped; futures for AAA and NIFTY are added.
  assert.deepEqual(file.keys, ['NSE:AAA', 'NSE:BBB', 'NFO:AAA26OCTFUT', 'NFO:NIFTY26OCTFUT']);
  assert.equal(file.snaps.length, 1);
  assert.deepEqual(file.snaps[0].q[0], [0, 101, 10, 60, 40, 5]);
  assert.deepEqual(file.meta[1], [100, 80, 121]);
  assert.equal(tracker.status().phase, 'recording');

  await clock.runUntil(at('09:00:00') + AUCTION_END_MS + SWEEP_EVERY_MS);
  const expected = Math.floor((AUCTION_END_MS - 5_000) / SWEEP_EVERY_MS) + 1;
  assert.equal(store.files.get(auctionFile(DATE)).snaps.length, expected);
  assert.equal(tracker.status().phase, 'done');
  const f = await tracker.features(DATE);
  assert.equal(f.snaps, expected);
  assert.ok(f.symbols.AAA.gap > 0);
});

test('recorder: without a session it asks for Kite and starts once a session arrives', async () => {
  const clock = fakeClock(at('09:02:00'));
  const store = memoryStore();
  const kite = fakeKite();
  const tracker = createAuctionTracker({ store, kite, instruments, calendar, symbols: () => ['AAA'], wait: async () => {}, ...clock });
  await tracker.wake();
  await clock.runUntil(at('09:02:00'));
  assert.equal(tracker.status().phase, 'needs-kite');
  assert.equal(kite.calls.length, 0);
  tracker.setSession({ apiKey: 'key', accessToken: 'token123' });
  await clock.runUntil(at('09:02:30'));
  assert.ok(kite.calls.length >= 1);
  assert.equal(tracker.status().phase, 'recording');
});

test('recorder: a refused request is shown with the token redacted, and it keeps trying', async () => {
  const clock = fakeClock(at('09:00:00'));
  const kite = fakeKite({ fail: new KiteError('Insufficient permission for token123', 403) });
  const tracker = createAuctionTracker({ store: memoryStore(), kite, instruments, calendar, symbols: () => ['AAA'], wait: async () => {}, ...clock });
  tracker.setSession({ apiKey: 'key', accessToken: 'token123' });
  await tracker.wake();
  await clock.runUntil(at('09:00:40'));
  const s = tracker.status();
  assert.equal(s.phase, 'needs-kite');
  assert.equal(s.errors, 3);
  assert.ok(!JSON.stringify(s).includes('token123'));
  await clock.runUntil(at('09:12:00'));
  assert.equal(tracker.status().phase, 'missed');
});

test('recorder: a restart mid-auction keeps the saved instrument order and adds to it', async () => {
  const store = memoryStore();
  store.files.set(auctionFile(DATE), { ...structuredClone(saved), snaps: saved.snaps.slice(0, 2) });
  const clock = fakeClock(at('09:05:00'));
  const tracker = createAuctionTracker({ store, kite: fakeKite(), instruments, calendar, symbols: () => ['BBB', 'AAA'], wait: async () => {}, ...clock });
  tracker.setSession({ apiKey: 'key', accessToken: 'token123' });
  await tracker.wake();
  await clock.runUntil(at('09:05:00'));
  const file = store.files.get(auctionFile(DATE));
  assert.deepEqual(file.keys, saved.keys);
  assert.equal(file.snaps.length, 3);
});

test('recorder: weekends and unknown years do nothing; after the window it reports what was saved', async () => {
  const sat = fakeClock(+new Date('2026-10-24T08:59:00+05:30'));
  const kite = fakeKite();
  const t1 = createAuctionTracker({ store: memoryStore(), kite, instruments, calendar, ...sat });
  assert.equal((await t1.wake()).phase, 'closed');
  const late = fakeClock(at('11:00:00'));
  const store = memoryStore();
  store.files.set(auctionFile(DATE), saved);
  const t2 = createAuctionTracker({ store, kite, instruments, calendar, ...late });
  assert.equal((await t2.wake()).phase, 'done');
  assert.equal(kite.calls.length, 0);
});
