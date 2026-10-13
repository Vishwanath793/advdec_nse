import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/utils/analysis.js';
import { isTradeable, roomToCircuit } from '../src/utils/tradeability.js';
import { parseSecList } from './priceBands.js';
import { normalizePreopen } from './preopen.js';

const SEC_LIST = [
  'Symbol,Series,Security Name,Band,Remarks',
  'GOOD,EQ,GOOD LTD,20,"-"',
  'TTRADE,BE,T2T LTD,5,"-"',
  'GSMCO,EQ,GSM CO,5,"GSM STAGE - II"',
  'TIGHT,EQ,TIGHT LTD,5,"-"',
  'LOCKED,EQ,LOCKED LTD,5,"-"',
  'FNO,EQ,FNO LTD,No Band,"-"',
  'REIT,RR,SOME REIT,20,"-"',
].join('\n');
const master = ['GOOD', 'TTRADE', 'GSMCO', 'TIGHT', 'LOCKED', 'FNO', 'REIT'].map((Symbol) => ({ Symbol, Industry: 'X' }));
const row = (SYMBOL, finalPrice) => ({
  SYMBOL, 'PREV. CLOSE': 100, 'FINAL PRICE': finalPrice, CHANGE: finalPrice - 100, '%CHANGE': finalPrice - 100,
});

test('flags block T2T series and circuit locks, and warn on surveillance, tight room and odd series', () => {
  const { stocks } = analyze([
    row('GOOD', 103), row('TTRADE', 102), row('GSMCO', 102), row('TIGHT', 104), row('LOCKED', 95), row('FNO', 103), row('REIT', 101),
  ], master, parseSecList(SEC_LIST));
  const flags = Object.fromEntries(stocks.map((s) => [s.symbol, s.flags.map((f) => `${f.severity}:${f.label}`)]));

  assert.deepEqual(flags, {
    GOOD: [],
    TTRADE: ['block:T2T'],
    GSMCO: ['warn:GSM II'],
    TIGHT: ['warn:1.0% to UC'],
    LOCKED: ['block:At LC'],
    FNO: [],
    REIT: ['warn:RR'],
  });
  assert.deepEqual(stocks.filter(isTradeable).map((s) => s.symbol), ['GOOD', 'GSMCO', 'TIGHT', 'FNO', 'REIT']);
  assert.equal(roomToCircuit(stocks[0]).toFixed(2), '16.50'); // (120 - 103) / 103
  assert.equal(roomToCircuit(stocks[5]), null); // F&O: no fixed band
});

test('pre-open series wins over the NSE list, and uploads without a list are unflagged', () => {
  const { rows: [r] } = normalizePreopen({ data: [{ symbol: 'GOOD', series: 'BE', prevClose: 100, finalPrice: 103, change: 3, perChange: 3 }] });
  assert.equal(analyze([r], master, parseSecList(SEC_LIST)).stocks[0].flags[0].label, 'T2T');
  assert.deepEqual(analyze([row('TTRADE', 103)], master).stocks[0].flags, []);
});
