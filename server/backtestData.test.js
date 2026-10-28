import test from 'node:test';
import assert from 'node:assert/strict';
import { atrFromBhavDays, createBacktestData, MAX_DAYS, neededDays, planBacktest, tradingDaysBetween } from '../src/core/backtestData.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();
const memStore = () => {
  const files = new Map();
  return { files, read: async (n) => (files.has(n) ? JSON.parse(files.get(n)) : null), write: async (n, v) => { files.set(n, JSON.stringify(v)); } };
};

// Eight trading days, each opening at the previous close; AAA gaps up 5% on the last, BBB gaps down 2%, CCC gaps 30% (a corporate action), DDD isn't in the master list.
const DATES = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14'];
function bhavFixture() {
  const bhav = new Map();
  DATES.forEach((d, i) => {
    const last = i === DATES.length - 1;
    const day = (sym, base, open) => [sym, { open, high: base * 1.02, low: base * 0.98, close: base, volume: 1e6 }];
    bhav.set(d, Object.fromEntries([
      day('AAA', 100 + i, last ? (100 + i - 1) * 1.05 : 100 + Math.max(0, i - 1)), day('BBB', 200, last ? 196 : 200),
      day('CCC', 50, last ? 70 : 50), day('DDD', 80, last ? 88 : 80),
    ]));
  });
  return bhav;
}
const sectors = new Map([['AAA', 'Information Technology'], ['BBB', 'Metals & Mining'], ['CCC', 'Realty']]);

test('atr: simple average true range of the last 14 completed days; null without enough days', () => {
  const days = Array.from({ length: 15 }, (_, i) => ({ high: 102 + i, low: 98 + i, close: 100 + i }));
  assert.equal(atrFromBhavDays(days), 4); // high−low 4 beats both gaps to the previous close (3 and 1)
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

test('needed days: each tested day plus the 20 trading days before it (the RVOL baseline)', () => {
  const plan = planBacktest({ dates: ['2026-10-14'], bhav: bhavFixture(), sectors });
  const need = neededDays(plan, calendar).get('AAA');
  assert.equal(need.at(-1), '2026-10-14');
  assert.equal(need.length, 21);
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

test('candles: one request per stretch of days, cached per stock; today is never cached', async () => {
  const kite = fakeKite();
  const store = memStore();
  const data = createBacktestData({ store, kite, instruments: null, calendar, now: () => new Date('2026-10-14T12:00:00+05:30'), limiter: { run: (fn) => fn() } });
  const days = ['2026-10-05', '2026-10-06', '2026-10-13', '2026-10-14'];
  const got = await data.minuteCandles('AAA', 1, days, { apiKey: 'k', accessToken: 't' });
  assert.equal(kite.calls.length, 1); // 05 → 13 fits in one stretch; 14 is today
  assert.equal(kite.calls[0].interval, 'minute');
  assert.equal(got['2026-10-05'].length, 1);
  assert.equal(got['2026-10-14'], null); // today: not fetched, not cached
  await data.minuteCandles('AAA', 1, days.slice(0, 3), { apiKey: 'k', accessToken: 't' });
  assert.equal(kite.calls.length, 1); // all from the cache
  // Days far apart: one request per stretch of at most SPAN_DAYS.
  const kite2 = fakeKite();
  const data2 = createBacktestData({ store: memStore(), kite: kite2, instruments: null, calendar, now: () => new Date('2026-10-14T12:00:00+05:30'), limiter: { run: (fn) => fn() } });
  await data2.minuteCandles('BBB', 2, ['2026-06-01', '2026-10-05'], {});
  assert.equal(kite2.calls.length, 2);
});

test('trading days between two dates: holidays and weekends left out, never today or later, at most MAX_DAYS', () => {
  const d = tradingDaysBetween('2026-10-01', '2026-10-31', calendar, '2026-10-14');
  assert.ok(d.length > 0 && d.every((x) => x < '2026-10-14'));
  assert.ok(!d.includes('2026-10-10') && !d.includes('2026-10-11'));
  assert.ok(tradingDaysBetween('2025-01-01', '2026-10-31', calendar, '2026-10-14').length <= MAX_DAYS);
});

/** Kite with five window candles a day per instrument (volume by token, so baselines are checkable), and 09:20+ candles. */
function kiteWithWindow() {
  const calls = [];
  return {
    calls,
    historical: async (a) => {
      calls.push(a);
      const out = [];
      for (let t = Date.parse(`${a.from.slice(0, 10)}T00:00:00Z`); t <= Date.parse(`${a.to.slice(0, 10)}T00:00:00Z`); t += 86_400_000) {
        const d = new Date(t).toISOString().slice(0, 10);
        if (!(new Date(t).getUTCDay() % 6)) continue;
        // The tested day (14th) trades ten times the volume of earlier days, so the baseline must not include it.
        const vol = d === '2026-10-14' ? 10_000 : 1_000;
        for (const m of ['15', '16', '17', '18', '19', '20', '21']) out.push([new Date(`${d}T09:${m}:00+05:30`), 100, 101, 99, 100.5, vol]);
      }
      return out;
    },
  };
}

test('loadDays: gapped stocks with tokens, candles, the RVOL baseline from earlier days only, index candles; skips are reported', async () => {
  const kite = kiteWithWindow();
  const bhav = bhavFixture();
  const instruments = {
    load: async () => ({
      equity: (s) => ({ AAA: { token: 11, tick: 0.05, lot: 1 } }[s] ?? null), // BBB has no token
      index: (name) => ({ 'NIFTY 50': 256265, 'NIFTY BANK': 260105, 'NIFTY IT': 259849 }[name] ?? null),
    }),
  };
  const progress = [];
  const data = createBacktestData({
    store: memStore(), kite, instruments, calendar, now: () => new Date('2026-10-15T12:00:00+05:30'), limiter: { run: (fn) => fn() },
    context: { day: async (d) => bhav.get(d) ?? null }, sectors: () => sectors,
    recordedScores: async (d) => (d === '2026-10-14' ? { AAA: { score: 81, flags: [] } } : null),
  });
  const r = await data.loadDays({ from: '2026-10-14', to: '2026-10-14', session: { apiKey: 'k', accessToken: 't' }, onProgress: (p) => progress.push(p.stage) });
  assert.equal(r.days.length, 1);
  const day = r.days[0];
  assert.equal(day.recorded, true);
  assert.deepEqual(day.stocks.map((s) => s.meta.symbol), ['AAA']);
  assert.deepEqual(r.skipped.noToken, ['BBB']);
  const aaa = day.stocks[0];
  assert.equal(aaa.meta.convictionScore, 81);
  assert.equal(aaa.meta.token, 11);
  assert.equal(aaa.meta.openVol5Avg, 5_000); // five 1,000-volume candles on each earlier day; never the tested day's 10,000s
  assert.deepEqual(aaa.meta.volumeMedians, { openingMedian: 5_000, minuteMedian: [1_000, 1_000, 1_000, 1_000, 1_000], sessions: 20 });
  assert.ok(aaa.candles[0][0] instanceof Date);
  assert.ok(day.indices['NIFTY 50'].length > 0 && day.indices['NIFTY IT'].length > 0);
  assert.ok(r.requests >= 4); // AAA, plus three indices
  assert.ok(progress.includes('NSE end-of-day files') && progress.at(-1) === 'Data ready');
  // Cancelled between downloads.
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(data.loadDays({ from: '2026-10-14', to: '2026-10-14', session: {}, signal: ac.signal }), /Cancelled/);
  // A period with no trading days, and no end-of-day source, are clear errors.
  await assert.rejects(data.loadDays({ from: '2026-10-10', to: '2026-10-11', session: {} }), /No completed trading days/);
});
