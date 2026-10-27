import test from 'node:test';
import assert from 'node:assert/strict';
import { istInstant } from '../src/core/calendar.js';
import { createTradingDesk } from '../src/core/tradingDesk.js';
import {
  breakevenStop, check0920, cleanGapExitSettings, cleanGapList, gapEntriesFor, gapExitPlan, gapSummary, gapTradeRows, gapType, ratchetStop,
  replanAfterFill, timeStopDue, trailCandidate, updateBar,
} from '../src/utils/gapExits.js';
import { emptyLedger, gapOrderEvents, ledgerDay, rebuildLedger, stepTick } from '../src/utils/paperLedger.js';
import { readCalendar } from './tv/calendar.js';

const D = '2026-10-19';
const T = (hm, s = 0) => +istInstant(D, hm) + s * 1000;
const RISK = { capital: 100_000, riskPerTradePct: 0.25 };
const base = { symbol: 'X', prevClose: 1000, atr: 30, tick: 0.05 };
const onTick = (p, tick) => Math.abs(Math.round(p / tick) * tick - p) < 1e-6;

test('worked example: normal gap (open 1012, fill 1012.50)', () => {
  const p = gapExitPlan({ ...base, side: 'BUY', open: 1012, entry: 1012.5 }, {}, RISK);
  assert.equal(p.type, 'normal');
  assert.equal(p.g, 0.4);
  assert.equal(p.S, 10.5);
  assert.equal(p.sl, 1002);
  assert.equal(p.t1, 1023);
  assert.equal(p.t2, 1038.75);
  // Reward/risk after costs comes to 1.49 (just under 1.5), so the size is halved: ₹125 ÷ (10.50 + 0.51) = 11 shares.
  // At factor 1 it would have been 22 shares.
  assert.equal(p.rewardRisk, 1.49);
  assert.equal(p.factor, 0.5);
  assert.equal(p.qty, 11);
  assert.match(p.factorReasons[0], /reward\/risk after costs 1\.49 is below 1\.5/);
});

test('worked example: bigger normal gap (open 1020, fill 1021) is halved for weak reward/risk', () => {
  const p = gapExitPlan({ ...base, side: 'BUY', open: 1020, entry: 1021 }, {}, RISK);
  assert.equal(p.S, 14);
  assert.equal(p.sl, 1007);
  assert.equal(p.t1, 1035);
  assert.equal(p.t2, 1040);
  assert.ok(p.rewardRisk < 1.5);
  assert.equal(p.factor, 0.5);
  assert.equal(p.qty, 8);
});

test('worked example: extreme gap (open 1060, fill 1061) trades a quarter of the budget and trails', () => {
  const p = gapExitPlan({ ...base, side: 'BUY', open: 1060, entry: 1061, upperCircuit: 1100, lowerCircuit: 900 }, {}, RISK);
  assert.equal(p.type, 'extreme');
  assert.equal(p.S, 15);
  assert.equal(p.sl, 1046);
  assert.equal(p.t1, 1076);
  assert.equal(p.t2, null);
  assert.equal(p.trailSecondHalf, true);
  assert.equal(p.factor, 0.25);
  assert.equal(p.qty, 4); // ₹62.50 ÷ (15 + 0.53 slippage)
  assert.equal(p.rewardRisk, null, 'trailing plans get no reward/risk cut');
});

test('short-side mirrors of the worked examples', () => {
  const a = gapExitPlan({ ...base, side: 'SELL', open: 988, entry: 987.5 }, {}, RISK);
  assert.deepEqual([a.type, a.S, a.sl, a.t1, a.t2], ['normal', 10.5, 998, 977, 961.25]);
  // STT falls on the short's entry, not its exits: reward/risk lands at 1.5 exactly, so no cut here.
  assert.equal(a.rewardRisk, 1.5);
  assert.equal(a.factor, 1);
  assert.equal(a.qty, 22);
  const b = gapExitPlan({ ...base, side: 'SELL', open: 980, entry: 979 }, {}, RISK);
  assert.deepEqual([b.S, b.sl, b.t1, b.t2, b.factor], [14, 993, 965, 960, 0.5]);
  const c = gapExitPlan({ ...base, side: 'SELL', open: 940, entry: 939, upperCircuit: 1100, lowerCircuit: 900 }, {}, RISK);
  assert.deepEqual([c.type, c.S, c.sl, c.t1, c.t2, c.factor, c.qty], ['extreme', 15, 954, 924, null, 0.25, 4]);
});

test('gap types follow the ATR bands', () => {
  assert.deepEqual([0, 0.19, 0.2, 0.79, 0.8, 1.49, 1.5, 4].map((g) => gapType(g)), ['flat', 'flat', 'normal', 'normal', 'large', 'large', 'extreme', 'extreme']);
  const s = cleanGapExitSettings({ bands: { flat: 0.5, normal: 0.3, large: 'x' }, trail: 'weird', timeStopAt: '08:00' });
  assert.deepEqual(s.bands, { flat: 0.5, normal: 0.5, large: 1.5 }, 'bands stay in order');
  assert.equal(s.trail, '5min');
  assert.equal(s.timeStopAt, '09:45');
});

test('invariants: levels on the tick, never beyond the circuit, the factor floor, at least one share', () => {
  for (const tick of [0.05, 0.1, 1]) {
    for (const open of [1001, 1009, 1024, 1045, 1080, 1095]) {
      for (const side of ['BUY', 'SELL']) {
        const o = side === 'BUY' ? open : 2000 - open;
        const p = gapExitPlan({ ...base, tick, side, open: o, upperCircuit: 1100, lowerCircuit: 900, prevHigh: 1030, prevLow: 970 }, {}, RISK);
        for (const k of ['sl', 't1', 't2']) if (p[k] != null) assert.ok(onTick(p[k], tick), `${k} ${p[k]} on the ₹${tick} tick`);
        assert.ok(p.t1 <= 1100 && p.t1 >= 900, 't1 inside the circuit');
        if (p.t2 != null) assert.ok(p.t2 <= 1100 - 3 * tick + 1e-9 && p.t2 >= 900 + 3 * tick - 1e-9, 't2 3 ticks inside the circuit');
        assert.ok(p.factor >= 0.25);
        assert.ok(p.qty >= 1);
        assert.ok(p.S <= 0.6 * 30 + 1e-9, 'stop never wider than 0.6 ATR');
      }
    }
  }
  // A ₹1,000 account at ₹50,000 a share still gets one share (noted).
  const tiny = gapExitPlan({ ...base, prevClose: 50_000, open: 50_500, atr: 1500, side: 'BUY' }, {}, { capital: 1_000 });
  assert.equal(tiny.qty, 1);
  assert.ok(tiny.notes.includes('minimum one share'));
  // Near the circuit and extreme: 0.25 × 0.5 is floored at 0.25.
  const near = gapExitPlan({ ...base, side: 'BUY', open: 1090, upperCircuit: 1100 }, {}, RISK);
  assert.equal(near.factor, 0.25);
  assert.ok(near.factorReasons.some((r) => /circuit/.test(r)) && near.factorReasons.some((r) => /floor/.test(r)));
});

test('missing ATR is estimated, labelled, and halves the size', () => {
  const p = gapExitPlan({ ...base, atr: null, side: 'BUY', open: 1012 }, {}, RISK);
  assert.equal(p.atrEstimated, true);
  assert.equal(p.atr, 20); // 2% of ₹1,000
  assert.ok(p.factorReasons.some((r) => /ATR missing.*×0\.5/.test(r)));
  assert.ok(p.notes.includes('ATR is an estimate'));
  assert.equal(gapExitPlan({ ...base, side: 'BUY', open: null }).ok, false);
});

test('re-plan after the fill: levels move with the fill, the quantity stays, a far fill is flagged', () => {
  const p = gapExitPlan({ ...base, side: 'BUY', open: 1012 }, {}, RISK);
  assert.equal(p.estimatedEntry, true);
  const near = replanAfterFill(p, 1013);
  assert.equal(near.riskFlag, false);
  const far = replanAfterFill(p, 1030); // 1.8% above the open: stop distance hits the 0.6 ATR cap
  assert.equal(far.S, 18);
  assert.equal(far.sl, 1012);
  assert.equal(far.riskRs, p.qty * 18);
  assert.equal(far.riskFlag, true);
  assert.match(far.notes.at(-1), /more than 1\.5× the planned/);
});

test('management helpers: ratchet, breakeven + costs, 09:20 check, time stop, 5-minute trail', () => {
  assert.equal(ratchetStop(1, 100, 99, 105), 100, 'never widens a long stop');
  assert.equal(ratchetStop(1, 100, 101, 105), 101);
  assert.equal(ratchetStop(1, 100, 106, 105), 100, 'never above the market');
  assert.equal(ratchetStop(-1, 100, 101, 95), 100, 'never widens a short stop');
  assert.equal(ratchetStop(-1, 100, 99, 95), 99);
  const be = breakevenStop({ d: 1, avgEntry: 1000, qty: 10, tick: 0.05 });
  assert.ok(be > 1000 && be < 1002 && onTick(be, 0.05), `breakeven plus costs ${be}`); // about ₹10.50 of charges on 10 shares
  assert.ok(breakevenStop({ d: -1, avgEntry: 1000, qty: 10, tick: 0.05 }) < 1000);

  const ok = check0920({ d: 1, stop: 1002, orLow: 1008, orHigh: 1020, vwap: 1012, ltp: 1018, open: 1012, atr: 30, tick: 0.05 });
  assert.deepEqual([ok.stop, ok.failed], [1006.5, false], 'tightened to the opening-range low − 0.05 ATR');
  const loose = check0920({ d: 1, stop: 1007, orLow: 1004, orHigh: 1020, vwap: 1012, ltp: 1018, open: 1012, atr: 30, tick: 0.05 });
  assert.equal(loose.stop, 1007, 'a lower opening-range low never widens it');
  const failed = check0920({ d: 1, stop: 1002, orLow: 1004, orHigh: 1016, vwap: 1010, ltp: 1006, open: 1012, atr: 30, tick: 0.05 });
  assert.equal(failed.failed, true);
  assert.match(failed.reason, /gap failed at 09:20/);
  assert.equal(check0920({ d: -1, stop: 1000, orLow: 980, orHigh: 990, vwap: 985, ltp: 992, open: 988, atr: 30, tick: 0.05 }).failed, true);

  assert.equal(timeStopDue({ d: 1, avgEntry: 1000, touch: 1004, S: 10, t1Done: false }), true, 'under 0.5 R');
  assert.equal(timeStopDue({ d: 1, avgEntry: 1000, touch: 1006, S: 10, t1Done: false }), false);
  assert.equal(timeStopDue({ d: 1, avgEntry: 1000, touch: 990, S: 10, t1Done: true }), false, 'not after target 1');

  let bar = null;
  let done = null;
  for (const [s, price] of [[0, 100], [60, 98], [200, 101], [300, 103]]) ({ bar, completed: done } = updateBar(bar, price, T('09:20', s)));
  assert.deepEqual([done.low, done.high], [98, 101], 'the 09:20–09:25 bar completed at 09:25');
  assert.equal(trailCandidate({ d: 1, completedBar: done, tick: 0.05 }), 97.95);
  assert.equal(trailCandidate({ d: 1, best: 110, atr: 10, tick: 0.05 }, { trail: 'atr' }), 105);
});

/* ---------- The paper ledger: one gap entry through a morning ---------- */

const depth = (bid, ask, qty = 1000) => ({
  buy: [0, 1, 2, 3, 4].map((i) => ({ price: +(bid - i * 0.05).toFixed(2), qty, orders: 3 })),
  sell: [0, 1, 2, 3, 4].map((i) => ({ price: +(ask + i * 0.05).toFixed(2), qty, orders: 3 })),
});
const tk = (at, ltp, { spread = 0.1, low = null, high = null, vwap = null, open = 1012, qty } = {}) => ({
  token: 7, mode: 'full', ltp, avgPrice: vwap ?? ltp, open, low: low ?? ltp, high: high ?? ltp, exchangeTime: at,
  depth: depth(+(ltp - spread / 2).toFixed(2), +(ltp + spread / 2).toFixed(2), qty),
});

function morning(plan, ticks, { squareOffAt = null } = {}) {
  const orders = gapOrderEvents(emptyLedger(D), [{ symbol: 'X', token: 7, plan }], {
    at: new Date(T('09:14')).toISOString(), activeFrom: new Date(T('09:15')).toISOString(), expiresAt: new Date(T('09:30')).toISOString(),
  });
  const state = rebuildLedger(D, orders);
  const events = [...orders];
  for (const t of ticks) events.push(...stepTick(state, t, t.exchangeTime, RISK, { squareOffAt }));
  return { state, events };
}

test('ledger: no fill before 09:15:00, then a market fill at the ask plus slippage (never the LTP), levels re-planned', () => {
  const plan = gapExitPlan({ ...base, side: 'BUY', open: 1012, upperCircuit: 1200, lowerCircuit: 800 }, {}, RISK);
  const { state } = morning(plan, [tk(T('09:14', 50), 1012), tk(T('09:15', 0.3), 1012, { qty: 5 }), tk(T('09:15', 1), 1012.4)]);
  const o = state.orders[0];
  assert.equal(o.strategy, 'gap915');
  assert.equal(o.tag, 'P915X');
  const p = state.positions[0];
  assert.equal(p.entryQty, plan.qty);
  assert.ok(p.avgEntry > 1012.05, 'filled above the ask (slippage), not at the LTP');
  assert.equal(o.status, 'FILLED');
  assert.ok(p.levels, 're-planned from the fill');
  assert.equal(p.stop, p.levels.sl);
  assert.equal(p.target1, p.levels.t1);
  // A thin book (5 a level) filled in two ticks: the levels follow the final average.
  assert.ok(Math.abs(p.levels.entry - p.avgEntry) < 1e-9);
  assert.deepEqual(ledgerDay(state), { killSwitch: false, realised: 0, trades: 0, consecutiveLosses: 0, open: 0 }, 'gap entries use no 09:20 slots');
});

test('ledger: target 1, breakeven plus costs, then the trail takes the second half', () => {
  const plan = gapExitPlan({ ...base, side: 'BUY', open: 1030, upperCircuit: 1200, lowerCircuit: 800 }, {}, RISK); // large gap: trails
  assert.equal(plan.t2, null);
  const ticks = [tk(T('09:15', 1), 1030, { open: 1030 })];
  for (let s = 60; s <= 300; s += 60) ticks.push(tk(T('09:15', s), 1030 + s / 60, { open: 1030, low: 1029, vwap: 1031 }));
  // 09:20 check passes; up through T1 to 1060 by 09:25; the 09:25–09:30 bar eases to a low of 1052; then a fall.
  for (let s = 0; s <= 540; s += 30) ticks.push(tk(T('09:20', s), s <= 300 ? 1035 + s / 12 : 1060 - ((s - 300) / 240) * 8, { open: 1030, low: 1029, vwap: 1033 }));
  ticks.push(tk(T('09:30', 1), 1058, { open: 1030, low: 1029, vwap: 1040 }));
  ticks.push(tk(T('09:31', 0), 1050, { open: 1030, low: 1029, vwap: 1040 }));
  const { state } = morning(plan, ticks);
  const p = state.positions[0];
  assert.equal(p.status, 'CLOSED');
  assert.deepEqual(p.exits.map((x) => x.kind), ['target1', 'trail']);
  assert.equal(p.exits[0].qty, Math.floor(p.entryQty / 2));
  assert.match(p.stopReason, /^trail/);
  assert.ok(p.exits[1].price > p.avgEntry, 'the trailed half closed in profit');
  assert.ok(p.mfe > 0 && p.mae >= 0);
  assert.equal(state.gap.trades, 1);
  assert.equal(state.gap.wins, 1);
  assert.equal(state.consecutiveLosses, 0);
});

test('ledger: the stop exits at the bid minus slippage, worse than the stop', () => {
  const plan = gapExitPlan({ ...base, side: 'BUY', open: 1012, upperCircuit: 1200, lowerCircuit: 800 }, {}, RISK);
  const { state } = morning(plan, [tk(T('09:15', 1), 1012), tk(T('09:16'), 1008), tk(T('09:17'), 1000)]);
  const p = state.positions[0];
  assert.equal(p.exits[0].kind, 'stop');
  assert.ok(p.exits[0].price < p.levels.sl, `${p.exits[0].price} below the stop ${p.levels.sl}`);
  assert.ok(p.net < 0);
  assert.equal(state.gap.losses, 1);
  assert.equal(state.consecutiveLosses, 0, 'gap entries don\'t count towards the 09:20 losing streak');
  assert.ok(ledgerDay(state).realised < 0, 'but their loss counts towards the daily loss');
});

test('ledger: the gap fails at 09:20 (below VWAP and the open): everything exits', () => {
  const plan = gapExitPlan({ ...base, side: 'BUY', open: 1012, upperCircuit: 1200, lowerCircuit: 800 }, {}, RISK);
  const { state } = morning(plan, [tk(T('09:15', 1), 1012), tk(T('09:18'), 1010), tk(T('09:20', 1), 1008, { vwap: 1010.5, low: 1006 })]);
  const p = state.positions[0];
  assert.equal(p.exits[0].kind, 'gap-failed');
  assert.match(p.exits[0].reason, /gap failed at 09:20/);
  assert.equal(p.check0920.failed, true);
});

test('ledger: the 09:20 check tightens the stop; the time stop exits a trade that went nowhere', () => {
  const plan = gapExitPlan({ ...base, side: 'BUY', open: 1012, upperCircuit: 1200, lowerCircuit: 800 }, {}, RISK);
  const ticks = [tk(T('09:15', 1), 1012), tk(T('09:20', 1), 1014, { low: 1009, vwap: 1012 })];
  for (let m = 21; m <= 46; m += 5) ticks.push(tk(T(`09:${m}`), 1014));
  const { state } = morning(plan, ticks);
  const p = state.positions[0];
  assert.equal(p.check0920.failed, false);
  assert.ok(p.exits.length && p.exits[0].kind === 'time-stop', 'time stop at 09:45');
  assert.match(p.exits[0].reason, /time stop at 09:45/);
  const stops = state.positions[0];
  assert.ok(stops.stop > p.levels.sl, 'the stop was tightened to the opening range at 09:20');
});

test('ledger: square-off closes an open gap entry; rebuilding from the log gives the same day', () => {
  const plan = gapExitPlan({ ...base, side: 'SELL', open: 988, upperCircuit: 1200, lowerCircuit: 800 }, {}, RISK);
  const ticks = [tk(T('09:15', 1), 988, { open: 988 }), tk(T('09:20', 1), 986, { open: 988, high: 990, vwap: 987 }), tk(T('09:46'), 982, { open: 988, high: 990, vwap: 985 })];
  ticks.push(tk(T('15:10', 1), 984, { open: 988, high: 990, vwap: 985 }));
  const { state, events } = morning(plan, ticks, { squareOffAt: T('15:10') });
  const p = state.positions[0];
  assert.equal(p.exits.at(-1).kind, 'squareoff');
  assert.equal(p.status, 'CLOSED');
  // Restart: the state rebuilt from the event log matches (orders, positions, P&L, gap totals).
  const rebuilt = rebuildLedger(D, events);
  assert.deepEqual(rebuilt.positions.map((x) => [x.status, x.qty, x.stop, x.net, x.exits.length]), state.positions.map((x) => [x.status, x.qty, x.stop, x.net, x.exits.length]));
  assert.deepEqual(rebuilt.gap, state.gap);
  assert.equal(rebuilt.realised, state.realised);
});

test('ledger: a restart in the middle of the trade carries on from the rebuilt state', () => {
  const plan = gapExitPlan({ ...base, side: 'BUY', open: 1012, upperCircuit: 1200, lowerCircuit: 800 }, {}, RISK);
  const first = morning(plan, [tk(T('09:15', 1), 1012), tk(T('09:16'), 1014)]);
  const s = rebuildLedger(D, first.events);
  assert.equal(s.positions[0].status, 'OPEN');
  assert.equal(s.positions[0].stop, first.state.positions[0].stop);
  const more = [...stepTick(s, tk(T('09:17'), 1030), T('09:17'), RISK)];
  assert.ok(more.some((e) => e.kind === 'target1'), 'target 1 after the restart');
  assert.equal(s.orders.length, 1, 'no second order');
  assert.equal(gapOrderEvents(s, [{ symbol: 'X', token: 7, plan }], {}).length, 0, 'the same day and stock is never ordered twice');
});

test('report rows and the summary by gap type', () => {
  const plan = gapExitPlan({ ...base, side: 'BUY', open: 1012, upperCircuit: 1200, lowerCircuit: 800 }, {}, RISK);
  const win = morning(plan, [tk(T('09:15', 1), 1012), tk(T('09:17'), 1024), tk(T('09:19'), 1040)]).state;
  const loss = morning(plan, [tk(T('09:15', 1), 1012), tk(T('09:16'), 1000)]).state;
  const rows = gapTradeRows([win, { ...loss, date: '2026-10-20' }]);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].r > 0 && rows[1].r < 0);
  assert.ok(rows[1].maeAtr > 0);
  const normal = gapSummary(rows).find((x) => x.type === 'normal');
  assert.deepEqual([normal.trades, normal.wins, normal.winRate], [2, 1, 50]);
});

test('gap list: cleaned; scheduled 09:15 market orders are shadowed only when on, never changed', () => {
  assert.deepEqual(cleanGapList({ list: [{ symbol: ' infy ', side: 'sell' }, { symbol: 'INFY' }, { symbol: 'bad sym' }, { symbol: 'TCS', side: 'x' }] }),
    { list: [{ symbol: 'INFY', side: 'SELL' }, { symbol: 'TCS', side: 'BUY' }], shadowScheduled: false });
  const scheduled = [
    { id: 'S1', symbol: 'CHOICEIN', side: 'BUY', orderType: 'MARKET', exchange: 'NSE', status: 'scheduled', triggerAt: new Date(T('09:15')).toISOString() },
    { id: 'S2', symbol: 'LIMITED', side: 'BUY', orderType: 'LIMIT', exchange: 'NSE', status: 'scheduled', triggerAt: new Date(T('09:15')).toISOString() },
    { id: 'S3', symbol: 'LATER', side: 'BUY', orderType: 'MARKET', exchange: 'NSE', status: 'scheduled', triggerAt: new Date(T('09:16')).toISOString() },
    { id: 'S4', symbol: 'GONE', side: 'SELL', orderType: 'MARKET', exchange: 'NSE', status: 'cancelled', triggerAt: new Date(T('09:15', 5)).toISOString() },
  ];
  const copy = JSON.stringify(scheduled);
  const window = { from: T('09:15'), to: T('09:16') };
  assert.deepEqual(gapEntriesFor(D, { list: [{ symbol: 'INFY' }] }, scheduled, window).map((e) => e.symbol), ['INFY']);
  const on = gapEntriesFor(D, { list: [{ symbol: 'INFY' }], shadowScheduled: true }, scheduled, window);
  assert.deepEqual(on.map((e) => [e.symbol, e.source]), [['INFY', 'list'], ['CHOICEIN', 'shadow of scheduled order S1']]);
  assert.equal(JSON.stringify(scheduled), copy, 'the scheduled orders are only read');
});

test('desk: onStart plans the gap list from the opening meta and places the paper orders; plan lookup for the Orders page', async () => {
  const meta = {
    7: { kind: 'stock', symbol: 'X', prevClose: 1000, preOpenPrice: 1012, atr14: 30, tick: 0.05, lot: 1, upperCircuit: 1200, lowerCircuit: 800 },
    8: { kind: 'index', symbol: 'NIFTY 50' },
  };
  const files = new Map();
  const logged = [];
  const desk = createTradingDesk({
    store: { read: async (n) => files.get(n) ?? null, write: async (n, v) => { files.set(n, v); } },
    log: { append: (_d, e) => logged.push(e), read: () => [] }, calendar: readCalendar(),
    now: () => new Date(T('09:14')), setTimer: () => 0, clearTimer: () => {},
    gapList: async () => [{ symbol: 'X', side: 'BUY', source: 'list' }, { symbol: 'NOPE', side: 'BUY', source: 'list' }],
    gapFallback: async (symbol) => (symbol === 'Y' ? { symbol, side: 'BUY', prevClose: 100, open: 103, atr: null } : null),
  });
  const r = await desk.onStart({ date: D, meta });
  assert.equal(r.orders, 1);
  const v = desk.view('day');
  assert.equal(v.gapEntries.plans.length, 2);
  assert.match(v.gapEntries.plans[1].error, /not in today's opening universe/);
  assert.equal(v.ledgerState.orders[0].activeFrom, new Date(T('09:15')).toISOString());
  assert.equal(logged.filter((e) => e.type === 'order').length, 1, 'written to the day log');
  assert.equal((await desk.onStart({ date: D, meta })).orders, 0, 'a second start places nothing new');
  assert.equal((await desk.gapPlanFor('X')).from, 'opening universe');
  const y = await desk.gapPlanFor('Y');
  assert.equal(y.from, 'pre-open row');
  assert.equal(y.atrEstimated, true);
  assert.equal(await desk.gapPlanFor('Z'), null);
});
