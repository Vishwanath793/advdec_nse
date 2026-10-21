import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { analyze } from '../src/utils/analysis.js';
import { buildXlsx, columnName, exportFileName, stocksWorkbook } from '../src/utils/exportStocks.js';
import { createAutoExport } from './autoExport.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();
const master = [
  { Symbol: 'AAA', Industry: 'Metals', 'Company Name': 'A & Sons <Ltd>', 'Market Cap (Cr)': '12000' },
  { Symbol: 'BBB', Industry: 'Metals', 'Company Name': 'B Ltd' },
  { Symbol: 'CCC', Industry: 'IT', 'Company Name': 'C Ltd' },
];
const row = (SYMBOL, pct, extra = {}) => ({
  SYMBOL, SERIES: 'EQ', 'PREV. CLOSE': 100, 'BASE PRICE': 100, 'FINAL PRICE': 100 + pct, CHANGE: pct, '%CHANGE': pct,
  'VALUE (₹ Crores)': 5, 'TOTAL BUY QTY': 700, 'TOTAL SELL QTY': 300, ...extra,
});
const rows = [row('AAA', 1.5, { 'FFM CAP (₹ Crores)': 8500.25 }), row('BBB', -1.2), row('CCC', 0.1)];
const secList = { bands: { AAA: 'none', BBB: 20, CCC: 20 }, info: {} };

const sheets = (bytes) => {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
};
/** Cell values of a sheet's XML as rows of strings (enough to check contents). */
const cells = (sheetXml) => [...sheetXml.matchAll(/<row r="\d+">(.*?)<\/row>/g)].map(([, r]) =>
  [...r.matchAll(/<c r="([A-Z]+)\d+"[^>]*>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)<\/c>/g)]
    .reduce((out, [, col, v, t]) => ({ ...out, [col]: v ?? t }), {}));

test('column letters', () => {
  assert.deepEqual([0, 25, 26, 51, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
});

test('file names use the IST date and time', () => {
  assert.equal(exportFileName(new Date('2026-10-16T04:00:00Z')), 'Stocks_2026-10-16_0930.xlsx');
  assert.equal(exportFileName(new Date('2026-10-15T18:30:00Z')), 'Stocks_2026-10-16_0000.xlsx');
});

test('xlsx package has every part, escapes text and skips empty cells', () => {
  const files = sheets(buildXlsx([{ name: 'One', rows: [['a', 'b'], ['x & <y>', null, 3]] }, { name: 'Two', rows: [['k']], filter: false }]));
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    assert.ok(files[part], part);
  }
  assert.match(files['xl/worksheets/sheet1.xml'], /x &amp; &lt;y&gt;/);
  assert.match(files['xl/worksheets/sheet1.xml'], /<c r="C2"><v>3<\/v><\/c>/);
  assert.doesNotMatch(files['xl/worksheets/sheet1.xml'], /r="B2"/);
  assert.match(files['xl/worksheets/sheet1.xml'], /<autoFilter ref="A1:C2"\/>/);
  assert.doesNotMatch(files['xl/worksheets/sheet2.xml'], /autoFilter/);
});

test('stocks workbook carries each factor score and the weight it counted with', () => {
  const factorSettings = { gap: { on: true, weight: 30 }, orders: { on: true, weight: 20 }, sector: { on: false, weight: 40 } };
  const { stocks } = analyze(rows, master, secList, { convictionFactors: factorSettings });
  const files = sheets(stocksWorkbook(stocks, factorSettings, { exportedAt: new Date('2026-10-16T04:00:00Z'), source: 'NSE pre-open · 16-Oct-2026 09:08:00', filters: 'None' }));
  assert.match(files['xl/workbook.xml'], /name="Stocks".*name="Conviction factors".*name="Breakdown"/);

  const table = cells(files['xl/worksheets/sheet1.xml']);
  const header = table[0];
  const col = (label) => Object.keys(header).find((k) => header[k] === label);
  const aaa = table[1];
  assert.equal(aaa[col('Symbol')], 'AAA');
  assert.equal(aaa[col('Company')], 'A &amp; Sons &lt;Ltd&gt;');
  assert.equal(aaa[col('Market cap (₹ Cr)')], '12000'); // from the master list
  assert.equal(aaa[col('Free-float market cap (₹ Cr)')], '8500.25'); // from the NSE pre-open feed (FFM CAP)
  assert.equal(table[2][col('Free-float market cap (₹ Cr)')], undefined); // not in the feed: empty cell
  assert.equal(aaa[col('Conviction')], String(stocks[0].convictionScore));
  assert.equal(aaa[col('Gap size weight')], '30');
  assert.equal(aaa[col('Buy/sell orders weight')], '5'); // F&O: a quarter of 20
  assert.equal(aaa[col('Buy/sell orders score')], '70');
  assert.equal(aaa[col('Sector strength score')], undefined); // turned off
  assert.equal(table[2][col('Buy/sell orders weight')], '20');
  assert.equal(table[3][col('Conviction')], undefined); // 0.1% gap: not scored

  const settings = cells(files['xl/worksheets/sheet2.xml']);
  const sector = settings.find((r) => r.A === 'Sector strength');
  assert.deepEqual([sector.B, sector.C, sector.D], ['No', '40', '0%']);
  const gap = settings.find((r) => r.A === 'Gap size');
  assert.deepEqual([gap.B, gap.C], ['Yes', '30']);
  assert.ok(settings.some((r) => r.A === 'Exported at (IST)' && r.B === '16-Oct-2026 09:30'));

  const breakdown = cells(files['xl/worksheets/sheet3.xml']);
  assert.ok(breakdown.some((r) => r.A === 'AAA' && r.D === 'Gap size' && r.E === '30'));
});

test('the backend saves once per trading day after 9:30 with the browser\'s factor settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-export-'));
  try {
    const at = { now: new Date('2026-10-16T03:50:00Z') }; // 09:20 IST, Friday
    let snapshot = { marketUpdatedAt: '16-Oct-2026 09:08:00', rows };
    const auto = createAutoExport({
      dataDir: join(root, 'data'), exportDir: join(root, 'out'), calendar, now: () => at.now,
      inputs: async () => ({ snapshot, masterRows: master, secList, context: null }),
    });
    assert.deepEqual(await auto.run(), { saved: false, reason: 'Waiting for 09:30 IST.' });

    auto.saveSettings({ gap: { on: false, weight: 20 } });
    at.now = new Date('2026-10-16T04:00:00Z'); // 09:30 IST
    snapshot = { marketUpdatedAt: '15-Oct-2026 09:08:00', rows }; // yesterday's data still loaded
    assert.equal((await auto.run()).reason, "Today's pre-open data hasn't been fetched.");

    snapshot = { marketUpdatedAt: '16-Oct-2026 09:08:00', rows };
    const done = await auto.run();
    assert.equal(done.saved, true);
    assert.deepEqual(readdirSync(join(root, 'out')), ['Stocks_2026-10-16_0930.xlsx']);
    const settings = cells(sheets(readFileSync(done.file))['xl/worksheets/sheet2.xml']);
    assert.equal(settings.find((r) => r.A === 'Gap size').B, 'No'); // used the saved settings
    assert.equal(auto.status().last.date, '2026-10-16');

    at.now = new Date('2026-10-16T05:00:00Z');
    assert.equal((await auto.run()).reason, 'Already saved today.');
    at.now = new Date('2026-10-16T10:30:00Z'); // 16:00 IST
    assert.equal(auto.notDue(), 'Market closed for the day.');
    assert.equal(auto.notDue(new Date('2026-10-17T04:00:00Z')), 'Not a trading day.'); // Saturday
    assert.throws(() => auto.saveSettings('junk'), /must be an object/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
