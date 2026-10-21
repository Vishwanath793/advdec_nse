import test from 'node:test';
import assert from 'node:assert/strict';
import { atrFromBhavDays, createBacktestData, neededDays, planBacktest } from '../src/core/backtestData.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();
const memStore = () => {
  const files = new Map();
  return { files, read: async (n) => (files.has(n) ? JSON.parse(files.get(n)) : null), write: async (n, v) => { files.set(n, JSON.stringify(v)); } };
};

// Eight trading days; AAA gaps up 5% on the last, BBB gaps down 2%, CCC gaps 30% (a corporate action), DDD isn't in the master list.
const DATES = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14'];
function bhavFixture() {
  const bhav = new Map();
  DATES.forEach((d, i) => {
    const last = i === DATES.length - 1;
    const day = (sym, base, open) => [sym, { open, high: base * 1.02, low: base * 0.98, close: base, volume: 1e6 }];
    bhav.set(d, Object.fromEntries([
      day('AAA', 100 + i, last ? 100 + (i - 1) * 1.05 : 100 + i), day('BBB', 200, last ? 196 : 200),
      day('CCC', 50, last ? 70 : 50), day('DDD', 80, last ? 88 : 80),
    ]));
  });
  return bhav;
}
const sectors = new Map([['AAA', 'Information Technology'], ['BBB', 'Metals & Mining'], ['CCC', 'Realty']]);

test('atr: simple average true range of the last 14 completed days; null without enough days', () => {
  const days = Array.from({ length: 15 }, (_, i) => ({ high: 102 + i, low: 98 + i, close: 100 + i }));
  assert.equal(atrFromBhavDays(days), 5); // high−low = 4, but the gap to the previous close adds up to 5
  assert.equal(atrFromBhavDays(days.slice(0, 10)), null);
});

test('planner: gapped stocks from the end-of-day files, biggest first, using only earlier days', () => {
  const plan = planBacktest({ dates: ['2026-10-14'], bhav: bhavFixture(), sectors, minGapPct: 0.5, maxPerDay: 15 });
  assert.equal(plan.days.length, 1);
  const stocks = plan.days[0].stocks;
  // AAA +5%, BBB −2%; CCC (+40%) is a likely corporate action; DDD isn't in the master list.
  assert.deepEqual(stocks.map((s) => s.symbol), ['AAA', 'BBB']);
  const aaa = stocks[0].meta;
  assert.equal(aaa.prevClose, 106);
  assert.equal(aaa.status, 'advance');
  assert.equal(aaa.sectorIndex, 'NIFTY IT');
  assert.equal(aaa.atr14, null); // fewer than 15 earlier days in this fixture
  assert.equal(stocks[1].meta.status, 'decline');
  assert.equal(planBacktest({ dates: ['2026-10-14'], bhav: bhavFixture(), sectors, maxPerDay: 1 }).days[0].stocks.length, 1);
  // The last day's own prices never leak into the previous-day levels.
  const changed = bhavFixture();
  changed.get('2026-10-14').AAA.high = 9999;
  assert.equal(planBacktest({ dates: ['2026-10-14'], bhav: changed, sectors }).days[0].stocks[0].meta.prevHigh, aaa.prevHigh);
});

test('planner: recorded days carry the 09:10 conviction; days without data or stocks are reported, not guessed', () => {
  const scores = new Map([['2026-10-14', { AAA: { score: 77, flags: [{ key: 't2t', severity: 'block' }] } }]]);
  const plan = planBacktest({ dates: ['2026-10-05', '2026-10-13', '2026-10-14'], bhav: bhavFixture(), sectors, scores });
  assert.deepEqual(plan.skipped.noPreviousDay, ['2026-10-05']); // nothing before it
  assert.deepEqual(plan.skipped.noStocks, ['2026-10-13']); // no gaps that day
  assert.equal(plan.days[0].recorded, true);
  assert.deepEqual([plan.days[0].stocks[0].meta.convictionScore, plan.days[0].stocks[0].meta.flags[0].key], [77, 't2t']);
  assert.deepEqual(plan.symbols, ['AAA', 'BBB']);
});

test('needed days: each tested day plus the ten trading days before it (the RVOL baseline)', () => {
  const plan = planBacktest({ dates: ['2026-10-14'], bhav: bhavFixture(), sectors });
  const need = neededDays(plan, calendar).get('AAA');
  assert.equal(need.at(-1), '2026-10-14');
  assert.equal(need.length, 11);
  assert.ok(need.every((d) => d <= '2026-10-14'));
  assert.ok(!need.includes('2026-10-10') && !need.includes('2026-10-11')); // a weekend
});

// A fake Kite: one 1-minute candle for each day it is asked about, counting requests.
function fakeKite() {
  const calls = [];
  return {
    calls,
    historical: async (a) => {
      calls.push(a);
      const days = [];
      for (let t = Date.parse(`${a.from.slice(0, 10)}T00:00:00Z`); t <= Date.parse(`${a.to.slice(0, 10)}T00:00:00Z`); t += 86_400_000) {
        const d = new Date(t);
        if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10));
      }
      return days.map((d) => [new Date(`${d}T09:15:00+05:30`), 100, 101, 99, 100.5, 1000]);
    },
  };
}

test('candles: one request per