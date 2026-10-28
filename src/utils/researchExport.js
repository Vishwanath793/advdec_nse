import { buildXlsx, istStamp } from './exportStocks.js';

/**
 * The Research workbook (milestone 3): a candle backtest or a tick replay of
 * recorded mornings, as saved by the backend, in Excel through the same
 * writer as the Stocks export. Pure: result in, bytes out.
 */

const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10);
const num = (x) => (x == null || !Number.isFinite(x) ? (x === Infinity ? 'no losses' : null) : x);

const SUMMARY_HEADERS = ['Trades', 'Days', 'Win rate %', 'Avg win ₹', 'Avg loss ₹', 'Profit factor', 'Net ₹ (after costs)', 'Charges ₹', 'Max drawdown ₹', 'Expectancy ₹', 'Expectancy R', 'Avg reward/risk', 'Longest losing streak'];
const summaryCells = (s) => [
  s.trades, s.days, pct(s.winRate), num(s.avgWin), num(s.avgLoss), num(s.profitFactor), num(s.net), num(s.charges), num(s.maxDrawdown),
  num(s.expectancy), num(s.expectancyR), num(s.avgRewardRisk), s.longestLosingStreak,
];
const breakdownRows = (breakdowns) => Object.entries(breakdowns ?? {}).flatMap(([by, groups]) => groups.map((g) => [by, g.key, ...summaryCells(g.summary ?? g)]));
const TRADE_HEADERS = ['Date', 'Symbol', 'Strategy', 'Side', 'Score', 'Qty', 'Entry', 'Exits', 'Outcome', 'Gross ₹', 'Charges ₹', 'Net ₹', 'R', 'Gap %', 'RVOL', 'Sector', 'Regime'];
const tradeCells = (t) => [
  t.date, t.symbol, t.strategy, t.side, t.score, t.qty, t.entry, (t.exits ?? []).map((x) => `${x.qty}@${x.price} ${x.kind}`).join(', '), t.outcome,
  t.gross, t.charges, t.net, t.r, t.gapPct != null ? Math.round(t.gapPct * 100) / 100 : null, t.rvol != null ? Math.round(t.rvol * 100) / 100 : null, t.sector, t.regime,
];

function settingsRows(settings) {
  const rows = [['Setting', 'Value']];
  const walk = (prefix, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}.${k}` : k, x);
    else rows.push([prefix, Array.isArray(v) ? v.join(', ') : v]);
  };
  walk('', settings ?? {});
  return rows;
}

/** Sheets for a candle backtest result (utils/backtestRunner.js runBacktest plus the run's metadata). */
export function backtestSheets(r) {
  const about = [
    ['BACKTEST: research on past data; nothing was traded.'],
    ['Run', istStamp(new Date(r.ranAt))], ['Period', `${r.first} – ${r.last}`], ['Days tested', r.days], ['Recorded days among them', r.recordedDays],
    ['Stock-days tested', r.stocksTested], ['Kite requests', r.requests ?? null], [],
    ['Limitations'], ...(r.limitations ?? []).map((l) => [l]),
  ];
  return [
    { name: 'About', rows: about, header: false, widths: [28, 90] },
    { name: 'Comparison', rows: [['Variant', ...SUMMARY_HEADERS], ...r.variants.map((v) => [v.label, ...summaryCells(v.summary)])] },
    { name: 'Breakdowns', rows: [['By', 'Group', ...SUMMARY_HEADERS], ...breakdownRows(r.breakdowns)] },
    { name: 'Slippage', rows: [['Slippage bps', ...SUMMARY_HEADERS], ...r.slippage.map((x) => [x.bps, ...summaryCells(x.summary)])] },
    { name: 'Sweeps', rows: [['Parameter', 'Value', ...SUMMARY_HEADERS], ...r.sweeps.flatMap((sw) => sw.values.map((x) => [sw.label, x.value, ...summaryCells(x.summary)]))] },
    {
      name: 'Out of sample',
      rows: r.oos?.skipped ? [['Out-of-sample split'], [r.oos.skipped]] : [['Part', `Split at ${r.oos.split}`, ...SUMMARY_HEADERS], ['In sample', '', ...summaryCells(r.oos.inSample)], ['Out of sample', '', ...summaryCells(r.oos.outOfSample)]],
    },
    {
      name: 'Walk-forward',
      rows: r.walkForward?.skipped ? [['Walk-forward'], [r.walkForward.skipped]] : [
        ['Train', 'Test', `Chosen ${r.walkForward.parameter}`, 'Why', 'Test trades', 'Test net ₹', 'Fixed-setting trades', 'Fixed-setting net ₹'],
        ...r.walkForward.steps.map((s) => [s.trainDays, s.testDays, s.chosen, s.chosenBecause, s.test.trades, s.test.net, s.fixed.trades, s.fixed.net]),
      ],
    },
    { name: 'Trades', rows: [TRADE_HEADERS, ...r.trades.map(tradeCells)] },
    { name: 'Not filled', rows: [['Date', 'Symbol', 'Strategy', 'Status', 'Reason'], ...r.notFilled.map((t) => [t.date, t.symbol, t.strategy, t.status, t.reason])] },
    { name: 'Settings', rows: settingsRows(r.settings) },
  ];
}

/** Sheets for a tick replay of recorded mornings (utils/tickReplay.js replayReport plus metadata). */
export function replaySheets(r) {
  return [
    {
      name: 'About', header: false, widths: [28, 90],
      rows: [['BACKTEST: tick replay of recorded mornings; nothing was traded.'], ['Run', istStamp(new Date(r.ranAt))], ['Days', r.days.map((d) => d.date).join(', ')], [], ['Limitations'], ...r.limitations.map((l) => [l])],
    },
    { name: 'Summary', rows: [['', ...SUMMARY_HEADERS], ['All recorded mornings', ...summaryCells(r.summary)], ...r.days.map((d) => [d.date, ...summaryCells(d.summary)])] },
    { name: 'Breakdowns', rows: [['By', 'Group', ...SUMMARY_HEADERS], ...breakdownRows(r.breakdowns)] },
    { name: 'Trades', rows: [TRADE_HEADERS, ...r.trades.map(tradeCells)] },
    { name: 'Not filled', rows: [['Date', 'Symbol', 'Strategy', 'Status', 'Reason'], ...r.notFilled.map((t) => [t.date, t.symbol, t.strategy, t.status, t.reason])] },
    { name: 'Settings', rows: settingsRows(r.settings) },
  ];
}

/** Sheets for strategy D's volume check (utils/volumeReconcile.js). */
export function reconcileSheets(r) {
  return [
    {
      name: 'Verdict', header: false, widths: [28, 90],
      rows: [['Strategy D volume check: recorded tick volumes vs Kite 1-minute bars'], ['Run', istStamp(new Date(r.ranAt))], ['Mornings', r.dates.join(', ')],
        ['Verdict', r.verdict.text], ...(r.hint ? [['Hint', r.hint]] : []), ['Rule', `±${r.rule.tolerance * 100}%, ${r.rule.minStockDays}+ stock-days, ${r.rule.minMornings}+ mornings`]],
    },
    { name: 'By minute', rows: [['Minute', 'Comparisons', 'Median ticks ÷ Kite', 'Share within tolerance'], ...r.minutes.map((m) => [m.minute, m.samples, m.medianRatio, m.shareWithin])] },
    { name: 'Rows', rows: [['Date', 'Symbol', 'Minute', 'Ticks', 'Ticks (lower bound)', 'Kite bar', 'Ratio', 'Volume start'], ...r.rows.map((x) => [x.date, x.symbol, x.minute, x.ticks, x.ticksLow, x.kite, x.ratio, x.baseline])] },
  ];
}

const SHEETS = { replay: replaySheets, reconcile: reconcileSheets, backtest: backtestSheets };
export const researchWorkbook = (kind, result) => buildXlsx((SHEETS[kind] ?? backtestSheets)(result));
