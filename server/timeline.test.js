/**
 * End-to-end timeline over a fake NSE and a fake clock: a weekend viewing
 * Friday's pre-open, Monday's 08:50 warm-up, 09:07 GIFT Nifty, 09:10
 * recording, 09:30 Excel save, the evening's VIX and FII/DII, the Dussehra
 * holiday, and the report card afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { previousTradingDays } from '../src/core/calendar.js';
import { createMarketContextService, MARKET_RETRY_MS } from '../src/core/marketContext.js';
import { createRecorder } from '../src/core/recorder.js';
import { createAutoExport } from './autoExport.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();
const SYMBOLS = ['AAA', 'BBB', 'CCC'];
const master = SYMBOLS.map((Symbol) => ({ Symbol, Industry: 'Metals', 'Company Name': `${Symbol} Ltd` }));
// Trading days with end-of-day files: 21 sessions up to Mon 19 Oct 2026.
const SESSIONS = previousTradingDays('2026-10-20', 25, calendar).reverse();
const nseDate = (iso) => `${iso.slice(8, 10)}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+iso.slice(5, 7) - 1]}-${iso.slice(0, 4)}`;
const ist = (iso, time) => new Date(`${iso}T${time}:00+05:30`);

function memoryStore(initial = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    files,
    read: async (name) => (files.has(name) ? JSON.parse(files.get(name)) : null),
    write: async (name, value) => { files.set(name, JSON.stringify(value)); },
  };
}

/** Closing price of a symbol on session i (rising AAA, falling BBB, flat CCC). */
const closeOf = (sym, i) => ({ AAA: 100 + i, BBB: 200 - i, CCC: 50 }[sym]);

function bhavCsv(iso) {
  const i = SESSIONS.indexOf(iso);
  const header = 'SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER';
  const rows = SYMBOLS.map((s) => {
    const c = closeOf(s, i);
    const deliv = s === 'AAA' && iso === '2026-10-16' ? 80 : 40; // AAA: heavy delivery on Friday
    return `${s}, EQ, ${nseDate(iso)}, ${closeOf(s, i - 1)}, ${c}, ${c + 1}, ${c - 1}, ${c}, ${c}, ${c}, 1000, 1, 1, 400, ${deliv}`;
  });
  return [header, ...rows].join('\n');
}

/** A fake NSE whose answers depend on the fake clock. */
function fakeNse(clock) {
  const calls = [];
  const failing = new Set();
  const reply = (status, body, type = 'application/json') => ({
    ok: status >= 200 && status < 300, status, headers: { get: () => type },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
    arrayBuffer: async () => (body instanceof Uint8Array ? body.buffer : new ArrayBuffer(0)),
  });
  async function fetchImpl(url) {
    calls.push(url);
    const now = clock.now;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    for (const f of failing) if (url.includes(f)) return reply(500, {});
    const bhav = /sec_bhavdata_full_(\d\d)(\d\d)(\d{4})\.csv/.exec(url);
    if (bhav) {
      const iso = `${bhav[3]}-${bhav[2]}-${bhav[1]}`;
      // Published at 18:30 on the day itself.
      const published = SESSIONS.includes(iso) && now >= ist(iso, '18:30');
      return published ? reply(200, bhavCsv(iso), 'text/csv') : reply(404, '');
    }
    const fo = /BhavCopy_NSE_FO_0_0_0_(\d{4})(\d\d)(\d\d)_F_0000\.csv\.zip/.exec(url);
    if (fo) {
      const iso = `${fo[1]}-${fo[2]}-${fo[3]}`;
      if (!SESSIONS.includes(iso) || now < ist(iso, '18:30')) return reply(404, '');
      // AAA futures: price up 1%, open interest up 8% (long build-up).
      const csv = [
        'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4',
        `${iso},${iso},FO,NSE,STF,1,,AAA,,2026-10-27,2026-10-27,,,AAAFUT,1,1,1,101,101,100,1,101,108000,8000,9,1,9,F1,100,,,,,`,
      ].join('\n');
      return reply(200, zipSync({ [`BhavCopy_NSE_FO_${iso}.csv`]: strToU8(csv) }), 'application/zip');
    }
    // The latest session whose close is published (VIX at 15:30, FII/DII at 19:00).
    const last = (after) => [...SESSIONS].reverse().find((d) => now >= ist(d, after));
    if (url.includes('/marketStatus')) {
      const morning = time >= '06:00' && time <= '09:15';
      return reply(200, {
        marketState: [{ index: 'NIFTY 50', last: 23000, tradeDate: `${nseDate(last('15:30'))} 15:30` }],
        giftnifty: { LASTPRICE: morning ? 23100 : 23300, DAYCHANGE: 50, PERCHANGE: morning ? 0.6 : 1.4, TIMESTMP: `${nseDate(today)} ${time}` },
      });
    }
    if (url.includes('/allIndices')) {
      const d = last('15:30');
      return reply(200, { timestamp: `${nseDate(d)} 15:30`, data: [{ index: 'INDIA VIX', last: 14 + SESSIONS.indexOf(d) / 10, percentChange: d === '2026-10-19' ? -8 : 2, previousClose: 14 }] });
    }
    if (url.includes('/fiidiiTradeReact')) {
      const d = last('19:00');
      return reply(200, [{ category: 'FII/FPI', date: nseDate(d), netValue: d === '2026-10-19' ? '2400' : '-900' }, { category: 'DII', date: nseDate(d), netValue: '500' }]);
    }
    if (url.includes('corporate-announcements')) {
      return reply(200, [
        { symbol: 'AAA', an_dt: '16-Oct-2026 08:00:00', desc: 'Financial Result Updates' }, // before Friday's open
        { symbol: 'BBB', an_dt: '16-Oct-2026 17:00:00', desc: 'Financial Result Updates' }, // after it
      ]);
    }
    if (url.includes('corporates-corporateActions') || url.includes('event-calendar')) return reply(200, []);
    return reply(404, '');
  }
  return { fetchImpl, calls, failing };
}

const snapshotRows = (pct) => SYMBOLS.map((s, i) => ({
  SYMBOL: s, SERIES: 'EQ', 'PREV. CLOSE': 100, 'BASE PRICE': 100, 'FINAL PRICE': 100 + pct[i], CHANGE: pct[i], '%CHANGE': pct[i],
  'VALUE (₹ Crores)': 5 + i, 'TOTAL BUY QTY': 600, 'TOTAL SELL QTY': 400,
}));

test('a weekend view of Friday uses only what was known on Friday morning', async () => {
  const clock = { now: ist('2026-10-17', '12:00') }; // Saturday
  const nse = fakeNse(clock);
  const ctx = createMarketContextService({ store: memoryStore(), fetchImpl: nse.fetchImpl, now: () => clock.now, calendar });

  const friday = await ctx.get({ date: '2026-10-16' });
  assert.equal(friday.date, '2026-10-16');
  assert.equal(friday.history.asOf, '2026-10-15'); // not Friday's own close
  assert.equal(friday.history.stats.AAA.prevClose, closeOf('AAA', SESSIONS.indexOf('2026-10-15')));
  assert.deepEqual(Object.keys(friday.events.results), ['AAA']); // the 17:00 announcement came after the open
  // Thursday's VIX and FII/DII were never captured; Friday's must not stand in for them.
  assert.deepEqual([friday.market.vix, friday.market.flows], [null, null]);

  const today = await ctx.get(); // Saturday: prepares for the next session
  assert.equal(today.history.asOf, '2026-10-16');
  assert.equal(today.market.vix.date, '2026-10-16');
  assert.equal(today.market.flows.fii, -900);
  // A future date is treated as today.
  assert.equal((await ctx.get({ date: '2026-10-21' })).date, '2026-10-17');
});

test('a trading day: 08:50 warm-up, 09:07 GIFT, 09:10 record, 09:30 Excel, evening signals, holiday, report card', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timeline-'));
  try {
    const clock = { now: ist('2026-10-19', '08:50') }; // Monday
    const nse = fakeNse(clock);
    const store = memoryStore();
    const ctx = createMarketContextService({ store, fetchImpl: nse.fetchImpl, now: () => clock.now, calendar });

    // 08:50 warm-up.
    let c = await ctx.get({ force: true });
    assert.equal(c.history.asOf, '2026-10-16');
    assert.equal(c.history.stats.AAA.prevDelivery, 80);
    assert.equal(c.history.stats.AAA.avgDelivery, 40);
    // Friday's F&O file: AAA futures long build-up.
    assert.equal(c.history.foAsOf, '2026-10-16');
    assert.equal(c.history.stats.AAA.foOiChangePct, 8);
    assert.equal(c.history.stats.AAA.foPricePct, 1);
    assert.equal(c.history.stats.BBB.foOi, undefined); // not an F&O stock
    assert.deepEqual([c.market.vix.date, c.market.flows.date], ['2026-10-16', '2026-10-16']);
    assert.equal(c.market.gift.morning, true);

    // 09:07: GIFT Nifty just before the pre-open closes.
    clock.now = ist('2026-10-19', '09:07');
    await ctx.refreshMarket();
    c = await ctx.get();
    assert.equal(new Date(c.market.gift.at).toISOString(), ist('2026-10-19', '09:07').toISOString());
    assert.deepEqual([c.market.gift.pct, c.market.gift.morning], [0.6, true]);

    // 09:10: the pre-open is fetched and recorded with that morning's inputs.
    clock.now = ist('2026-10-19', '09:10');
    const snapshot = { marketUpdatedAt: '19-Oct-2026 09:08:00', fetchedAt: clock.now.toISOString(), rows: snapshotRows([1.5, -1.2, 0.8]) };
    const recorder = createRecorder({
      store, calendar, context: ctx, now: () => clock.now,
      inputs: async () => {
        const cx = await ctx.get();
        return { masterRows: master, secList: null, events: cx.events, market: cx.market };
      },
    });
    assert.equal((await recorder.record(snapshot)).recorded, true);
    const saved = await store.read('recorded/2026-10-19.json');
    assert.equal(saved.market.gift.pct, 0.6);
    assert.equal(saved.market.flows.date, '2026-10-16');

    // A failing source is retried, but not on every request.
    clock.now = ist('2026-10-19', '09:12');
    nse.failing.add('/allIndices');
    await assert.rejects(ctx.refreshMarket(), /India VIX unavailable/);
    const before = nse.calls.filter((u) => u.includes('/allIndices')).length;
    clock.now = new Date(+clock.now + 10_000);
    assert.equal((await ctx.get()).market.vix.date, '2026-10-16'); // stored readings still served
    assert.equal(nse.calls.filter((u) => u.includes('/allIndices')).length, before); // within the retry wait
    clock.now = new Date(+clock.now + MARKET_RETRY_MS);
    nse.failing.clear();
    await ctx.get();
    assert.equal(nse.calls.filter((u) => u.includes('/allIndices')).length, before + 1);

    // 09:30: the Excel file, scored with GIFT Nifty and delivery switched on.
    clock.now = ist('2026-10-19', '09:30');
    const auto = createAutoExport({
      dataDir: join(root, 'data'), exportDir: join(root, 'out'), calendar, now: () => clock.now,
      inputs: async () => ({ snapshot, masterRows: master, secList: null, context: await ctx.get() }),
    });
    auto.saveSettings({ gift: { on: true, weight: 20 }, delivery: { on: true, weight: 20 }, oi: { on: true, weight: 20 } });
    const done = await auto.run();
    assert.equal(done.saved, true);
    const breakdown = strFromU8(unzipSync(readFileSync(done.file))['xl/worksheets/sheet3.xml']);
    assert.match(breakdown, /GIFT Nifty 23,100 \(\+0\.60%\) at 09:07 IST/);
    assert.match(breakdown, /on 80\.0% delivery, 2\.0× its usual 40\.0%/);
    assert.match(breakdown, /Futures \+1\.00% with open interest \+8\.0% yesterday: long build-up/);

    // Evening: Monday's VIX close and FII/DII arrive and are kept for the next session.
    clock.now = ist('2026-10-19', '19:30');
    await ctx.refreshMarket();
    // Tuesday is Dussehra; Wednesday's morning uses Monday's readings.
    clock.now = ist('2026-10-21', '08:50');
    c = await ctx.get({ force: true });
    assert.deepEqual([c.market.previousSession, c.market.vix.pct, c.market.flows.fii], ['2026-10-19', -8, 2400]);
    assert.equal(c.history.asOf, '2026-10-19');

    // Report card (Wednesday): Monday is scored against Monday's end-of-day file.
    const report = await recorder.report({ gap: { on: true, weight: 20 }, gift: { on: true, weight: 20 } });
    assert.deepEqual(report.pending, []);
    assert.equal(report.totals.days, 1);
    assert.equal(report.totals.trades, 3);
    const aaa = report.days[0].up.topPicks.find((p) => p.symbol === 'AAA');
    assert.ok(aaa, 'AAA is a gap-up pick');
    // Entry 101.5 at the pre-open; Monday closed at closeOf('AAA', i) for its session.
    const close = closeOf('AAA', SESSIONS.indexOf('2026-10-19'));
    assert.ok(Math.abs(aaa.ret - ((close - 101.5) / 101.5) * 100) < 1e-9);
    assert.equal(report.factors.find((f) => f.key === 'gift').marketWide, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('older end-of-day files are upgraded once for delivery %, and kept if the download fails', async () => {
  const clock = { now: ist('2026-10-19', '08:50') };
  const nse = fakeNse(clock);
  const old = { AAA: [101, 99, 100, 1000, 100] }; // saved before delivery % was kept
  const store = memoryStore({ 'bhav/2026-10-16.json': old });
  const ctx = createMarketContextService({ store, fetchImpl: nse.fetchImpl, now: () => clock.now, calendar });
  const rows = await ctx.day('2026-10-16');
  assert.equal(rows.AAA.delivery, 80);
  assert.equal((await store.read('bhav/2026-10-16.json')).AAA.length, 6);
  await ctx.day('2026-10-16');
  assert.equal(nse.calls.filter((u) => u.includes('16102026')).length, 1); // not downloaded again

  const offline = memoryStore({ 'bhav/2026-10-16.json': old });
  const failing = createMarketContextService({
    store: offline, fetchImpl: async () => { throw new Error('offline'); }, now: () => clock.now, calendar,
  });
  assert.deepEqual((await failing.day('2026-10-16')).AAA, { high: 101, low: 99, close: 100, volume: 1000, open: 100, delivery: null });
});
