import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPriceBandService, parseSecList } from './priceBands.js';
import { analyze, circuitFor, tickSize } from '../src/utils/analysis.js';

const SEC_LIST = [
  'Symbol,Series,Security Name,Band,Remarks',
  'ELECTCAST,W1,ELECTROSTEEL CASTINGS LIMITED,5,"-"',
  'ELECTCAST,EQ,ELECTROSTEEL CASTINGS LIMITED,20,"-"',
  'RELIANCE,EQ,RELIANCE INDUSTRIES LIMITED,No Band,"-"',
  'LOTUSDEV,BE,SRI LOTUS DEVELOPERS AND REALTY LIMITED,5,"-"',
].join('\r\n');

test('price band list prefers EQ series and marks F&O stocks', () => {
  const { bands, info } = parseSecList(SEC_LIST);
  assert.deepEqual(bands, { ELECTCAST: 20, RELIANCE: 'none', LOTUSDEV: 5 });
  assert.deepEqual(info.ELECTCAST, { series: 'EQ', remarks: '' });
  assert.deepEqual(info.LOTUSDEV, { series: 'BE', remarks: '' });
  assert.throws(() => parseSecList('Symbol,Series,Security Name,Band,Remarks\n'), /no usable rows/);
});

test('tick sizes follow NSE price slabs', () => {
  assert.deepEqual([249.99, 250, 999, 1000, 5000, 10000, 20000].map(tickSize), [0.01, 0.05, 0.05, 0.1, 0.5, 1, 5]);
});

test('circuit limits round inward to the tick and flag stocks at the limit', () => {
  // SUNTV, base 599.90, 20% band: NSE publishes 479.95 / 719.85.
  assert.deepEqual(circuitFor(20, 599.9, 588), { upperCircuit: 719.85, lowerCircuit: 479.95, circuitHit: null });
  assert.deepEqual(circuitFor(20, 605, 588), { upperCircuit: 726, lowerCircuit: 484, circuitHit: null });
  // Tick 0.01 below ₹250: 213.7 * 1.05 = 224.385 -> 224.38; * 0.95 = 203.015 -> 203.02.
  assert.deepEqual(circuitFor(5, 213.7, 224.38), { upperCircuit: 224.38, lowerCircuit: 203.02, circuitHit: 'upper' });
  // Tick 0.10 for ₹1,000–5,000: 1213.45 * 1.05 = 1274.1225 -> 1274.10; * 0.95 = 1152.7775 -> 1152.80.
  assert.deepEqual(circuitFor(5, 1213.45, 1152.8), { upperCircuit: 1274.1, lowerCircuit: 1152.8, circuitHit: 'lower' });
  assert.equal(circuitFor(5, 200, 209.99).circuitHit, null);
  assert.equal(circuitFor('none', 100, 80).upperCircuit, null);

  const master = [{ Symbol: 'LOTUSDEV', Industry: 'Realty' }, { Symbol: 'RELIANCE', Industry: 'Energy' }];
  const rows = [
    { SYMBOL: 'LOTUSDEV', 'PREV. CLOSE': '200', 'FINAL PRICE': '210', CHANGE: '10', '%CHANGE': '5' },
    { SYMBOL: 'RELIANCE', 'PREV. CLOSE': '1400', 'FINAL PRICE': '1410', CHANGE: '10', '%CHANGE': '0.71' },
  ];
  const [lotus, reliance] = analyze(rows, master, parseSecList(SEC_LIST)).stocks;
  assert.equal(lotus.upperCircuit, 210);
  assert.equal(lotus.circuitHit, 'upper');
  // NSE's BASE PRICE (from the pre-open import) wins over prev close.
  const adjusted = analyze([{ ...rows[0], 'BASE PRICE': 190 }], master, parseSecList(SEC_LIST)).stocks[0];
  assert.equal(adjusted.upperCircuit, 199.5);
  assert.equal(reliance.band, 'none');
  assert.equal(analyze(rows, master).stocks[0].upperCircuit, null);
});

test('bands are fetched once per IST day and the last good copy survives failures', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'nse-bands-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  let fail = false;
  let clock = new Date('2026-10-05T03:00:00Z');
  const service = createPriceBandService({
    file: join(directory, 'bands.json'),
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (fail) return { ok: false, status: 503 };
      return { ok: true, text: async () => SEC_LIST };
    },
  });
  assert.equal((await service.get()).bands.LOTUSDEV, 5);
  await service.get();
  assert.equal(calls, 1);

  clock = new Date('2026-10-05T20:00:00Z'); // next IST day
  fail = true;
  const stale = await service.get();
  assert.equal(calls, 2);
  assert.equal(stale.bands.LOTUSDEV, 5);
  assert.match(stale.lastError, /HTTP 503/);
});
