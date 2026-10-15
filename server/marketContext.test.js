import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMarketContextService, historyStats, parseBhavcopy, parseExDates, parseNseDate, parseResults,
  parseResultsDue, previousTradingDays,
} from './marketContext.js';
import { analyze } from '../src/utils/analysis.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();
const bhav = (rows) => [
  'SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER',
  ...rows.map(([s, h, l, c, v, series = 'EQ']) => `${s}, ${series}, 12-Oct-2026, ${c}, ${c}, ${h}, ${l}, ${c}, ${c}, ${c}, ${v}, 1, 1, 1, 1`),
].join('\n');

test('previous trading days skip weekends and NSE holidays', () => {
  // 13 Oct 2026 is a Tuesday; 14 Sep 2026 (Ganesh Chaturthi) is a holiday.
  assert.deepEqual(previousTradingDays('2026-10-13', 3, calendar), ['2026-10-12', '2026-10-09', '2026-10-08']);
  assert.ok(!previousTradingDays('2026-09-20', 6, calendar).includes('2026-09-14'));
});

test('end-of-day files give yesterday\'s range and average volume', () => {
  const day1 = { date: '2026-10-09', rows: parseBhavcopy(bhav([['HCLTECH', 1230, 1200, 1216.7, 3000000]])) };
  const day2 = { date: '2026-10-12', rows: parseBhavcopy(bhav([['HCLTECH', 1236.8, 1206, 1223, 2000000], ['HCLTECH', 9, 9, 9, 9, 'BL']])) };
  assert.deepEqual(historyStats([day1, day2]).HCLTECH, { prevHigh: 1236.8, prevLow: 1206, prevClose: 1223, avgVolume: 2500000, volumeDays: 2 });
  assert.throws(() => parseBhavcopy('A,B\n1,2'), /Unexpected end-of-day file format/);
});

test('corporate feeds: results since the last close, results due today and ex-dates', () => {
  assert.equal(parseNseDate('12-Oct-2026 16:58:53').toISOString(), '2026-10-12T11:28:53.000Z');
  const since = new Date('2026-10-12T15:30:00+05:30');
  const results = parseResults([
    { symbol: 'HCLTECH', an_dt: '12-Oct-2026 16:58:53', desc: 'Outcome of Board Meeting', attchmntText: 'HCL Technologies Limited has submitted to the Exchange, the financial results for the period ended September 30, 2026.' },
    { symbol: 'EARLY', an_dt: '12-Oct-2026 11:00:00', desc: 'Financial Result Updates', attchmntText: '' }, // during yesterday's session
    { symbol: 'OTHER', an_dt: '12-Oct-2026 18:00:00', desc: 'Outcome of Board Meeting', attchmntText: 'Appointment of director' },
  ], since);
  assert.deepEqual(Object.keys(results), ['HCLTECH']);
  assert.deepEqual(parseResultsDue([{ symbol: 'DEN', date: '13-Oct-2026', purpose: 'Financial Results' }, { symbol: 'X', date: '13-Oct-2026', purpose: 'Fund Raising' }], '2026-10-13'), { DEN: 'Financial Results' });
  assert.deepEqual(parseExDates([{ symbol: 'OLAELEC', exDate: '13-Oct-2026', subject: 'Rights 2:25 @ Premium Rs 17/-' }, { symbol: 'Y', exDate: '14-Oct-2026', subject: 'Dividend' }], '2026-10-13'), { OLAELEC: ['Rights 2:25 @ Premium Rs 17/-'] });
});

test('signals feed the analysis: flags, badges data and optional conviction factors', () => {
  const master = ['HCLTECH', 'OLAELEC', 'QUIET'].map((Symbol) => ({ Symbol, Industry: 'X' }));
  const rows = [
    { SYMBOL: 'HCLTECH', 'PREV. CLOSE': 1223, 'FINAL PRICE': 1245.4, CHANGE: 22.4, '%CHANGE': 1.83, 'FINAL VOLUME': 116198 },
    { SYMBOL: 'OLAELEC', 'PREV. CLOSE': 35.68, 'FINAL PRICE': 34.4, CHANGE: -1.28, '%CHANGE': -3.59, 'FINAL VOLUME': 1000 },
    { SYMBOL: 'QUIET', 'PREV. CLOSE': 100, 'FINAL PRICE': 101, CHANGE: 1, '%CHANGE': 1, 'FINAL VOLUME': 10 },
  ];
  const context = {
    history: { stats: {
      HCLTECH: { prevHigh: 1236.8, prevLow: 1206, avgVolume: 2786938 },
      OLAELEC: { prevHigh: 36, prevLow: 35, avgVolume: 1000000 },
      QUIET: { prevHigh: 102, prevLow: 99, avgVolume: 10000 },
    } },
    events: { results: { HCLTECH: [{ at: '2026-10-12T11:28:53.000Z', text: 'financial results' }] }, resultsDue: {}, exDates: { OLAELEC: ['Rights 2:25'] } },
  };
  const on = { catalyst: { on: true, weight: 15 }, rvol: { on: true, weight: 15 }, prevRange: { on: true, weight: 15 } };
  const [hcl, ola, quiet] = analyze(rows, master, null, { context, convictionFactors: on }).stocks;

  assert.equal(hcl.rangeBreak, 'above');
  assert.equal(ola.rangeBreak, 'below');
  assert.equal(quiet.rangeBreak, 'inside');
  assert.equal(hcl.rvolPct.toFixed(2), '4.17');
  assert.equal(hcl.rvolRank, 1);
  assert.deepEqual(ola.flags.map((f) => f.label), ['Ex-date']);
  const factor = (s, key) => s.conviction.factors.find((f) => f.key === key)?.value;
  assert.deepEqual([factor(hcl, 'catalyst'), factor(ola, 'catalyst'), factor(quiet, 'catalyst')], [1, 0, 0.5]);
  assert.deepEqual([factor(hcl, 'prevRange'), factor(quiet, 'prevRange')], [1, 0.5]);

  // Without context these factors are simply unavailable.
  const plain = analyze(rows, master).stocks[0];
  assert.ok(!plain.conviction.factors.some((f) => ['catalyst', 'rvol', 'prevRange'].includes(f.key)));
  assert.equal(plain.rangeBreak, null);
});

test('service caches end-of-day files and survives a failing events feed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nse-context-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('sec_bhavdata_full')) {
      if (url.includes('09102026')) return { ok: false, status: 404 };
      return { ok: true, status: 200, text: async () => bhav([['HCLTECH', 1236.8, 1206, 1223, 2000000]]) };
    }
    return { ok: false, status: 503 };
  };
  const svc = createMarketContextService({ dir, fetchImpl, now: () => new Date('2026-10-13T03:30:00Z'), calendar });
  const first = await svc.get();
  assert.equal(first.history.asOf, '2026-10-12');
  assert.equal(first.history.days, 20); // 21 wanted, one missing (404)
  assert.equal(first.events, null);
  assert.match(first.error, /Corporate events: NSE request failed \(HTTP 503\)/);
  const bhavCalls = calls.filter((u) => u.includes('sec_bhavdata_full')).length;
  await svc.get({ force: true });
  // Cached files are not downloaded again; only the 404 day is skipped for the session.
  assert.equal(calls.filter((u) => u.includes('sec_bhavdata_full')).length, bhavCalls);
});
