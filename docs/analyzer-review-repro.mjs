import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { analyze } from '../src/utils/analysis.js';
import { screenStocks } from '../src/utils/screener.js';
import { isTradeable } from '../src/utils/tradeability.js';
import { auctionFeatures, auctionLayerFactors } from '../src/utils/auctionLayer.js';
import { preopenBaseline, applyResearch } from '../src/utils/research.js';
import { historyStats } from '../src/core/marketContext.js';
import { fromColumns } from '../src/core/recorder.js';
const master = ['A', 'B', 'C'].map(Symbol => ({ Symbol, Industry: 'Test' }));
const row = (SYMBOL, overrides = {}) => ({ SYMBOL, 'PREV. CLOSE': 100, 'FINAL PRICE': 101, CHANGE: 1, '%CHANGE': 1, ...overrides });
const report = {};
const sparse = analyze([row('A')], master).stocks[0];
assert.equal(sparse.convictionScore, 100);
report.sparseScore = { score: sparse.convictionScore, available: sparse.conviction.factors.map(f => f.key), missing: sparse.conviction.missing };
const inconsistent = analyze([row('A', { 'FINAL PRICE': 100 })], master).stocks[0];
assert.equal(inconsistent.convictionScore, null);
assert.equal(isTradeable(inconsistent), true);
assert.equal(screenStocks([inconsistent], { tradeableOnly: true }).matched.length, 1);
report.inconsistent = { conviction: inconsistent.convictionScore, tradeable: isTradeable(inconsistent), screenerMatches: 1 };
const badPct = analyze([row('A', { '%CHANGE': -5 })], master).stocks[0];
assert.equal(badPct.dataIssue, null);
assert.equal(badPct.conviction.direction, 'up');
report.pctMismatch = { status: badPct.status, pctChange: badPct.pctChange, dataIssue: badPct.dataIssue, score: badPct.convictionScore };
const dup = analyze([row('A'), row('A')], master);
assert.equal(dup.summary.total, 2);
report.duplicateRows = { uniqueSymbols: 1, total: dup.summary.total };
const t = time => +new Date(`2026-10-21T${time}+05:30`);
const a = auctionFeatures({date: '2026-10-21', keys: ['NSE:A'], meta: [[100, 80, 120]], futures: {}, snaps: [
  { t: t('09:04:00'), q: [[0, 101, 100, 80, 20, 60]] },
  { t: t('09:07:00'), q: [[0, 102, 100, 90, 10, 80]] },
  { t: t('09:09:00'), q: [[0, 102, 100, 10, 90, 0]] },
]}).symbols.A;
assert.equal(a.closeAt, t('09:07:00'));
assert.equal(a.buyShare, .1);
report.auctionPhase = { inferredClose: new Date(a.closeAt).toISOString(), closeBuyShare: a.buyAtClose / (a.buyAtClose + a.sellAtClose), ordersHeldUsesBuyShare: a.buyShare, heldScore: auctionLayerFactors({ auction: a }, 1).aOrdersHeld?.value ?? null }; // null since 21 Oct: too few order-entry readings, post-matching ones excluded
const baseline = preopenBaseline(Array.from({ length: 5 }, (_, i) => ({ date: `2026-10-${10+i}`, symbols: { A: [i === 0 ? 100 : null, 1] }, sectors: {} })));
const research = applyResearch([{ symbol: 'A', finalVolume: 200, valueCr: 2 }], { preopen: baseline })[0];
assert.equal(research.preRvolX, 2);
report.baselineCoverage = { actualVolumeDays: 1, reportedDays: research.researchDays.preopen, preRvolX: research.preRvolX };
const h = historyStats([{date:'2026-10-16',rows:{A:{high:101,low:99,close:100,open:100,volume:100}}},{date:'2026-10-20',rows:{A:{high:111,low:109,close:110,open:110,volume:100}}}]);
report.compressedHistory = { availableDates: ['2026-10-16','2026-10-20'], close1: h.A.close1, avgAbsGap: h.A.avgAbsGap };
const index = JSON.parse(readFileSync(new URL('../.data/recorded/index.json', import.meta.url)));
report.localRecordedDays = index.days.map(d => d.date);
report.localAuctionDirectoryPresent = existsSync(new URL('../.data/auction/', import.meta.url));
const saved = JSON.parse(readFileSync(new URL('../.data/recorded/2026-10-21.json', import.meta.url)));
const rows = fromColumns(saved.snapshot);
report.latestArchive = { date: saved.date, marketUpdatedAt: saved.marketUpdatedAt, rows: rows.length, uniqueSymbols: new Set(rows.map(r => r.SYMBOL)).size, eventsDate: saved.events?.date ?? null, marketDate: saved.market?.date ?? null };
console.log(JSON.stringify(report, null, 2));
