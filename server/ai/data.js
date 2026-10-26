import { analyze } from '../../src/utils/analysis.js';
import { screenStocks } from '../../src/utils/screener.js';
import { weightShares, MIN_GAP_PCT } from '../../src/utils/conviction.js';
import { isTradeable, roomToCircuit } from '../../src/utils/tradeability.js';
import { previousTradingDays } from '../../src/core/calendar.js';
import { MIN_RESEARCH_DAYS } from '../../src/utils/research.js';
import { normalizeProfile, profileHash } from '../../src/utils/aiContext.js';
import { aiError } from './errors.js';

/**
 * Read-only structured access to the Analyzer's data for the AI Analyst.
 * Every number the assistant states about a stock or a day comes from these
 * functions (the same pure analysis the Analyzer runs), never from the model.
 * Nothing here can place, change or cancel an order or change a setting: the
 * `snapshots` service it is given only reads.
 *
 * `snapshots` (wired in server/index.js; faked in tests):
 *   list()                       -> [{ snapshotId, date, source, exchangeAt, fetchedAt, recordedAt, stocks }]
 *   open({ source, snapshotId }) -> { snapshotId, date, source, rows, masterRows, secList, context,
 *                                     times: { exchangeAt, fetchedAt, recordedAt, availableAt }, contextFp, inputsFp } | null
 *   openRecorded(date)           -> the same for a recorded day | null
 *   outcome(date)                -> { rows, availableAt } | null   (stored files only, never a download)
 *   extras(date)                 -> { auction, opening, paper } summaries | null
 */

export const MAX_SCREEN_ROWS = 25;
export const MAX_COMPARE = 5;
export const MAX_OUTCOME_TRADES = 25;

/** Fields a screen may filter or sort on, each read from an analysed stock (or its Stock filter row). */
export const SCREEN_FIELDS = {
  pctChange: { label: 'Gap %', get: (s) => s.pctChange },
  absGap: { label: 'Gap size % (either side)', get: (s) => (s.pctChange == null ? null : Math.abs(s.pctChange)) },
  convictionScore: { label: 'Conviction score', get: (s) => s.convictionScore },
  historyScore: { label: 'History score', get: (s) => s.historyScore },
  auctionScore: { label: 'Auction score', get: (s) => s.auctionScore },
  quality: { label: 'Quality (Stock filter)', get: (s, r) => r?.quality ?? null },
  qualityRank: { label: 'Quality rank', get: (s, r) => r?.rank ?? null },
  ffmCapCr: { label: 'Free-float market cap (₹ Cr)', get: (s) => s.ffmCap },
  marketCapCr: { label: 'Market cap from the master list (₹ Cr)', get: (s) => s.marketCap },
  valueCr: { label: 'Pre-open value (₹ Cr)', get: (s) => s.valueCr },
  finalPrice: { label: 'Pre-open price (₹)', get: (s) => s.finalPrice },
  rvolX: { label: 'Relative volume (× typical)', get: (s) => s.rvolX },
  ordersPct: { label: 'Gap-side orders (% of pending)', get: (s, r) => r?.metrics?.ordersPct ?? null },
  valuePct: { label: 'Pre-open value percentile', get: (s, r) => r?.metrics?.valuePct ?? null },
  delivPct: { label: 'Delivery % (yesterday)', get: (s) => s.delivPct },
  delivX: { label: 'Delivery % vs usual (×)', get: (s) => s.delivX },
  delivQtyX: { label: 'Delivery quantity vs 20 sessions (×)', get: (s) => s.delivQtyX },
  gapX: { label: 'Gap vs its usual gap (×)', get: (s) => s.gapX },
  sizeGapX: { label: 'Gap vs size (×)', get: (s) => s.sizeGapX },
  rsSectorPct: { label: '20-session return vs sector (points)', get: (s) => s.rsSectorPct },
  foOiChangePct: { label: 'Futures OI change yesterday (%)', get: (s) => s.foOiChangePct },
  roomPct: { label: 'Room to the circuit (%)', get: (s) => roomToCircuit(s) },
  driftPts: { label: 'Gap built during the auction (points)', get: (s, r) => r?.metrics?.driftPts ?? null },
  heldPts: { label: 'Gap-side orders held (points)', get: (s, r) => r?.metrics?.heldPts ?? null },
};
export const NUMERIC_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'between'];
export const CATEGORY_FIELDS = { sector: (s) => s.sector, direction: (s) => (s.status === 'advance' ? 'up' : s.status === 'decline' ? 'down' : 'flat') };
export const SORT_FIELDS = Object.keys(SCREEN_FIELDS);

/** Numbers rounded for the model: 2 decimals, or 3 below 1, so stated figures can be matched to the source. */
export function roundDeep(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const d = Math.abs(value) < 1 ? 1000 : 100;
    return Math.round(value * d) / d;
  }
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v)]));
  return value;
}

const compare = (v, op, a, b) => {
  if (v == null) return false;
  switch (op) {
    case 'gt': return v > a;
    case 'gte': return v >= a;
    case 'lt': return v < a;
    case 'lte': return v <= a;
    case 'eq': return Math.abs(v - a) < 1e-9;
    case 'between': return v >= Math.min(a, b) && v <= Math.max(a, b);
    default: return false;
  }
};

function factorList(factors, withWeights = false) {
  const shares = withWeights ? weightShares(Object.fromEntries(factors.map((f) => [f.key, f.weight]))) : null;
  return factors.map((f) => ({
    key: f.key, label: f.label, score01: f.value,
    ...(withWeights ? { weight: f.weight, sharePct: shares[f.key] } : {}),
    detail: f.detail ?? null,
  }));
}

export function createAnalystData({ snapshots, calendar, now = () => new Date() }) {
  const analyses = new Map(); // `${snapshotId}|${profileHash}|${contextFp}` -> { result, screen, byCode }

  function analysisFor(snap, profile) {
    const key = `${snap.snapshotId}|${profileHash(profile)}|${snap.contextFp ?? ''}|${snap.inputsFp ?? ''}`;
    if (!analyses.has(key)) {
      const result = analyze(snap.rows, snap.masterRows ?? [], snap.secList ?? null, { convictionFactors: profile.convictionFactors, context: snap.context ?? null });
      const screen = screenStocks(result.stocks, profile.screener);
      analyses.set(key, {
        result,
        screen,
        bySymbol: new Map(result.stocks.map((s) => [s.symbol, s])),
        screenBySymbol: new Map(screen.rows.map((r) => [r.stock.symbol, r])),
        isin: new Map((snap.masterRows ?? []).map((m) => [String(m.Symbol ?? '').trim().toUpperCase(), String(m['ISIN Code'] ?? m.ISIN ?? '').trim() || null])),
      });
      while (analyses.size > 12) analyses.delete(analyses.keys().next().value);
    }
    return analyses.get(key);
  }

  /**
   * One question's view: the snapshot, the normalised profile, the mode and cutoff.
   * In "as known" mode the snapshot must have been available by the cutoff.
   */
  async function session({ ref, profile, mode, cutoff }) {
    const snap = await snapshots.open(ref);
    if (!snap) throw aiError('snapshot', 'That snapshot is not available on the backend (it may be an uploaded file, or a newer NSE snapshot has replaced it). Reload the Analyzer or pick a recorded day.');
    const p = normalizeProfile(profile);
    const cut = mode === 'as-known' ? (cutoff ?? snap.times.availableAt) : now().toISOString();
    if (mode === 'as-known' && snap.times.availableAt && snap.times.availableAt > cut) {
      throw aiError('stale', `This view uses data that became available at ${snap.times.availableAt}, after the cutoff ${cut}. Choose a later cutoff, the recorded morning of that day, or Retrospective research.`);
    }
    return { snap, profile: p, profileHash: profileHash(p), mode, cutoff: cut, analysis: () => analysisFor(snap, p) };
  }

  const baseMeta = (s, extra = {}) => ({
    snapshotId: s.snap.snapshotId, date: s.snap.date, source: s.snap.source,
    exchangeAt: s.snap.times.exchangeAt ?? null, fetchedAt: s.snap.times.fetchedAt ?? null, availableAt: s.snap.times.availableAt ?? null,
    profileHash: s.profileHash, retrospective: false, ...extra,
  });

  function stockView(s, a) {
    const stock = a.bySymbol.get(s);
    if (!stock) return null;
    const row = a.screenBySymbol.get(s);
    const c = stock.conviction;
    const buyPct = stock.buyQty != null && stock.sellQty != null && stock.buyQty + stock.sellQty > 0 ? (stock.buyQty / (stock.buyQty + stock.sellQty)) * 100 : null;
    const notScored = !stock.status || stock.status === 'unchanged' ? 'unchanged in the pre-open, so not scored'
      : stock.dataIssue ? 'inconsistent NSE pre-open data, so not scored'
        : Math.abs(stock.pctChange ?? 0) < MIN_GAP_PCT ? `gap under ${MIN_GAP_PCT}%, so not scored` : null;
    return roundDeep({
      symbol: stock.symbol,
      company: stock.company,
      isin: a.isin.get(stock.symbol) ?? null,
      sector: stock.sector,
      direction: stock.status === 'advance' ? 'gap-up' : stock.status === 'decline' ? 'gap-down' : 'unchanged',
      prices: { prevClose: stock.prevClose, basePrice: stock.circuitBase, preopenFinalPrice: stock.finalPrice, change: stock.change, gapPct: stock.pctChange },
      ffmCapCr: stock.ffmCap,
      marketCapCr: stock.marketCap,
      marketCapNote: stock.ffmCap == null
        ? 'No free-float market cap: the pre-open row has no FFM CAP value.'
        : stock.marketCap == null ? 'Free-float cap from the NSE pre-open row (FFM CAP). The master list has no full market-cap value for this stock.' : 'Free-float cap from the NSE pre-open row; full cap from the master list.',
      preopen: { valueCr: stock.valueCr, finalVolume: stock.finalVolume, buyQty: stock.buyQty, sellQty: stock.sellQty, buyPct, gapSideOrdersPct: row?.metrics?.ordersPct ?? null },
      conviction: c ? {
        score: c.score, rawScore: c.rawScore, cappedBy: c.cappedBy, direction: c.direction,
        factors: factorList(c.factors, true), missingData: c.missing, factorsOff: c.excluded.length,
      } : { score: null, reason: notScored },
      history: stock.historyLayer ? { score: stock.historyLayer.score, coverage: stock.historyLayer.coverage, factors: factorList(stock.historyLayer.factors), missingData: stock.historyLayer.missing } : null,
      auction: stock.auctionLayer ? { score: stock.auctionLayer.score, coverage: stock.auctionLayer.coverage, factors: factorList(stock.auctionLayer.factors), missingData: stock.auctionLayer.missing }
        : { score: null, reason: stock.auction ? 'not scored (no conviction direction)' : 'no Kite auction recording for this stock on this day' },
      signals: {
        rvolX: stock.rvolX, rvolPercentile: stock.rvolRank == null ? null : stock.rvolRank * 100, avgVolume: stock.avgVolume,
        delivPct: stock.delivPct, usualDelivPct: stock.delivAvg, delivX: stock.delivX, prevMovePct: stock.prevMovePct,
        prevHigh: stock.prevHigh, prevLow: stock.prevLow, rangeBreak: stock.rangeBreak, ret5Pct: stock.ret5, ret20Pct: stock.ret20,
        futuresOiChangePct: stock.foOiChangePct, futuresPricePct: stock.foPricePct, oiBuild: stock.foBuild,
        resultsSinceLastClose: stock.results ? true : false, resultsDue: stock.resultsDue ? true : false, exDate: stock.exDate ?? null,
        eventsChecked: stock.eventsChecked,
      },
      research: {
        gapX: stock.gapX, avgAbsGapPct: stock.avgAbsGap, delivQtyX: stock.delivQtyX, rsSectorPts: stock.rsSectorPct, rsNiftyPts: stock.rsNiftyPct,
        oiRankPct: stock.oiRank == null ? null : stock.oiRank * 100, preopenRvolX: stock.preRvolX, preopenValueX: stock.preValueX, sessionsWithData: stock.researchDays ?? null,
      },
      gapVsSize: { x: stock.sizeGapX ?? null, typicalGapPct: stock.sizeTypicalGap ?? null },
      circuit: { bandPct: stock.bandPct, band: stock.band, upper: stock.upperCircuit, lower: stock.lowerCircuit, atCircuit: stock.circuitHit, roomPct: roomToCircuit(stock) },
      tradeable: isTradeable(stock),
      flags: (stock.flags ?? []).map((f) => ({ label: f.label, severity: f.severity, detail: f.detail })),
      dataIssue: stock.dataIssue,
      stockFilter: row ? { pass: row.pass, failedBecause: row.failed, quality: row.quality, qualityReadings: row.qualityParts, rank: row.rank } : { pass: false, failedBecause: ['not a gapped stock'] },
    });
  }

  const ensureSymbol = (a, symbol) => {
    if (!a.bySymbol.has(symbol)) throw aiError('invalid', `${symbol} is not in this snapshot's analysed stocks (it may be missing from the master list).`);
  };

  // ---- the read-only functions the assistant can call ----

  async function getAnalysisSnapshot(s) {
    const { result, screen } = s.analysis();
    const gapped = result.stocks.filter((x) => x.conviction);
    const top = (dir) => gapped.filter((x) => Math.sign(x.pctChange) === dir).sort((x, y) => dir * (y.pctChange - x.pctChange)).slice(0, 5)
      .map((x) => ({ symbol: x.symbol, gapPct: x.pctChange, conviction: x.convictionScore, valueCr: x.valueCr }));
    const topConviction = [...gapped].sort((x, y) => (y.convictionScore ?? -1) - (x.convictionScore ?? -1)).slice(0, 5)
      .map((x) => ({ symbol: x.symbol, conviction: x.convictionScore, gapPct: x.pctChange }));
    return {
      result: roundDeep({
        date: s.snap.date,
        breadth: { ...result.summary, adRatio: result.summary.adRatio === Infinity ? null : result.summary.adRatio },
        scoredGaps: gapped.length,
        gapUps: gapped.filter((x) => x.pctChange > 0).length,
        gapDowns: gapped.filter((x) => x.pctChange < 0).length,
        notTradeable: result.stocks.filter((x) => !isTradeable(x)).length,
        sectors: result.sectors.slice(0, 12).map((x) => ({ sector: x.sector, advances: x.advances, declines: x.declines, unchanged: x.unchanged, total: x.total, advPct: x.total ? (x.advances / x.total) * 100 : null, advVsUsualPts: x.advVsUsualPp ?? null })),
        largestGapUps: top(1),
        largestGapDowns: top(-1),
        topConviction,
        stockFilter: { gapped: screen.gapped, matched: screen.matched.length, ranked: screen.ranked },
      }),
      meta: baseMeta(s, { title: `Analyzer snapshot ${s.snap.date}` }),
    };
  }

  async function getStockAnalysis(s, { symbol }) {
    const a = s.analysis();
    ensureSymbol(a, symbol);
    return { result: stockView(symbol, a), meta: baseMeta(s, { title: `${symbol} analysis, ${s.snap.date}`, symbol }) };
  }

  async function compareStocks(s, { symbols }) {
    const a = s.analysis();
    symbols.forEach((sym) => ensureSymbol(a, sym));
    const rows = symbols.map((sym) => {
      const v = stockView(sym, a);
      return {
        symbol: v.symbol, sector: v.sector, direction: v.direction, gapPct: v.prices.gapPct, conviction: v.conviction.score,
        convictionFactors: (v.conviction.factors ?? []).map((f) => ({ label: f.label, score01: f.score01, sharePct: f.sharePct })),
        history: v.history?.score ?? null, auction: v.auction?.score ?? null, quality: v.stockFilter.quality, qualityRank: v.stockFilter.rank,
        ffmCapCr: v.ffmCapCr, valueCr: v.preopen.valueCr, rvolX: v.signals.rvolX, gapSideOrdersPct: v.preopen.gapSideOrdersPct,
        delivPct: v.signals.delivPct, gapVsSizeX: v.gapVsSize.x, tradeable: v.tradeable, flags: v.flags.map((f) => f.label),
        passesMyFilter: v.stockFilter.pass,
      };
    });
    return { result: { date: s.snap.date, stocks: rows }, meta: baseMeta(s, { title: `Comparison of ${symbols.join(', ')}, ${s.snap.date}` }) };
  }

  async function screenSnapshot(s, { conditions, useMyFilters, tradeableOnly, sortBy, sortDir, limit }) {
    const { result, screen, screenBySymbol } = s.analysis();
    const pool = useMyFilters ? screen.matched.map((r) => r.stock) : result.stocks;
    const matched = pool.filter((st) => {
      if (tradeableOnly && !isTradeable(st)) return false;
      return conditions.every((c) => {
        if (CATEGORY_FIELDS[c.field]) {
          const v = String(CATEGORY_FIELDS[c.field](st) ?? '').toLowerCase();
          const vals = (c.values ?? []).map((x) => x.toLowerCase());
          return c.op === 'in' ? vals.includes(v) : v === vals[0];
        }
        return compare(SCREEN_FIELDS[c.field].get(st, screenBySymbol.get(st.symbol)), c.op, c.value, c.value2);
      });
    });
    const key = sortBy ?? 'convictionScore';
    const get = (st) => SCREEN_FIELDS[key].get(st, screenBySymbol.get(st.symbol));
    matched.sort((x, y) => ((get(y) ?? -Infinity) - (get(x) ?? -Infinity)) * (sortDir === 'asc' ? -1 : 1) || x.symbol.localeCompare(y.symbol));
    const fields = [...new Set(['pctChange', 'convictionScore', key, ...conditions.filter((c) => SCREEN_FIELDS[c.field]).map((c) => c.field)])];
    return {
      result: roundDeep({
        date: s.snap.date,
        conditions: conditions.map((c) => ({ field: c.field, label: SCREEN_FIELDS[c.field]?.label ?? c.field, op: c.op, value: c.value, value2: c.value2, values: c.values })),
        appliedMyStockFilter: Boolean(useMyFilters), tradeableOnly: Boolean(tradeableOnly),
        matched: matched.length,
        shown: Math.min(matched.length, limit),
        sortedBy: `${key} ${sortDir === 'asc' ? 'ascending' : 'descending'}`,
        stocks: matched.slice(0, limit).map((st) => ({
          symbol: st.symbol, sector: st.sector,
          ...Object.fromEntries(fields.map((f) => [f, SCREEN_FIELDS[f].get(st, screenBySymbol.get(st.symbol))])),
          tradeable: isTradeable(st),
        })),
      }),
      meta: baseMeta(s, { title: `Screen of ${s.snap.date}: ${matched.length} matches` }),
    };
  }

  async function getRecordedDates(s) {
    const list = (await snapshots.list()).filter((x) => x.source === 'recorded');
    const days = [];
    let hidden = 0;
    for (const d of list) {
      const extras = (await snapshots.extras(d.date)) ?? {};
      const outcome = await snapshots.outcome(d.date);
      const known = (at) => s.mode !== 'as-known' || (at != null && at <= s.cutoff);
      if (!known(d.recordedAt)) { hidden++; continue; }
      days.push({
        date: d.date, snapshotId: d.snapshotId, stocks: d.stocks, exchangeAt: d.exchangeAt, recordedAt: d.recordedAt,
        auctionRecorded: Boolean(extras.auction),
        openingSealed: extras.opening && known(extras.opening.sealedAt) ? extras.opening : null,
        paper: extras.paper && known(extras.paper.availableAt) ? extras.paper : null,
        outcomeStored: Boolean(outcome && known(outcome.availableAt)),
      });
    }
    return {
      result: roundDeep({ recorded: days.length, hiddenAfterCutoff: hidden, days }),
      meta: baseMeta(s, { title: 'Recorded days', retrospective: s.mode !== 'as-known' }),
    };
  }

  /**
   * Similar recorded setups and what happened after them. Setups are chosen
   * from each day's morning data only (the same profile); the end-of-day
   * outcome is joined afterwards and never used to choose them. In "as known"
   * mode only days whose outcome was published by the cutoff are used.
   */
  async function getHistoricalOutcomes(s, q) {
    // Other recorded days only (the selected day is the one being asked about). As known: only days before it.
    const all = (await snapshots.list())
      .filter((x) => x.source === 'recorded' && x.date !== s.snap.date && (s.mode !== 'as-known' || x.date < s.snap.date))
      .sort((x, y) => x.date.localeCompare(y.date));
    const list = q.lastDays ? all.slice(-q.lastDays) : all;
    const excluded = [];
    const selected = [];
    let considered = 0;
    for (const d of list) {
      const outcome = await snapshots.outcome(d.date);
      if (!outcome) { excluded.push({ date: d.date, reason: 'no end-of-day file stored' }); continue; }
      if (s.mode === 'as-known' && !(outcome.availableAt <= s.cutoff)) { excluded.push({ date: d.date, reason: 'outcome published after the cutoff' }); continue; }
      const snap = await snapshots.openRecorded(d.date);
      if (!snap) { excluded.push({ date: d.date, reason: 'recording incomplete (no master list)' }); continue; }
      considered++;
      const a = analysisFor(snap, s.profile);
      // Selection: morning fields only.
      const picks = selectSetups(a.result.stocks, q);
      for (const st of picks) selected.push({ date: d.date, stock: st, outcome: outcome.rows?.[st.symbol] ?? null });
    }
    // Outcomes joined after the selection.
    const trades = selected.map(({ date, stock, outcome }) => {
      const dir = stock.pctChange > 0 ? 1 : -1;
      const entry = stock.finalPrice;
      const move = (p) => (p > 0 && entry > 0 ? ((dir * (p - entry)) / entry) * 100 : null);
      return {
        date, symbol: stock.symbol, direction: dir > 0 ? 'gap-up' : 'gap-down', gapPct: stock.pctChange, conviction: stock.convictionScore,
        closeVsEntryPct: outcome ? move(outcome.close) : null,
        bestPct: outcome ? move(dir > 0 ? outcome.high : outcome.low) : null,
        worstPct: outcome ? move(dir > 0 ? outcome.low : outcome.high) : null,
        gapFilled: outcome && stock.prevClose != null ? (dir > 0 ? outcome.low <= stock.prevClose : outcome.high >= stock.prevClose) : null,
      };
    });
    const withClose = trades.filter((t) => t.closeVsEntryPct != null);
    const avg = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
    const med = (xs) => { const v = [...xs].sort((x, y) => x - y); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
    return {
      result: roundDeep({
        query: q,
        method: 'Entry at the pre-open final price in the gap direction; outcome from that day\'s NSE end-of-day file (close, high, low). Setups were chosen from morning data only.',
        daysConsidered: considered,
        excludedDays: excluded,
        setups: trades.length,
        withOutcome: withClose.length,
        closedBeyondEntry: withClose.filter((t) => t.closeVsEntryPct > 0).length,
        avgCloseVsEntryPct: avg(withClose.map((t) => t.closeVsEntryPct)),
        medianCloseVsEntryPct: med(withClose.map((t) => t.closeVsEntryPct)),
        gapFilled: trades.filter((t) => t.gapFilled).length,
        smallSample: withClose.length < 30,
        trades: trades.slice(0, MAX_OUTCOME_TRADES),
      }),
      meta: baseMeta(s, { title: `Recorded setups and later outcomes (${trades.length})`, retrospective: true, availableAt: null }),
    };
  }

  async function getDataCoverage(s, { symbol }) {
    const { result } = s.analysis();
    const c = s.snap.context ?? {};
    const prev = previousTradingDays(s.snap.date, 1, calendar)[0] ?? null;
    const outcome = await snapshots.outcome(s.snap.date);
    const stale = [];
    const missing = [];
    if (!c.history) missing.push('20-session end-of-day history');
    else if (c.history.asOf !== prev) stale.push(`End-of-day history is as of ${c.history.asOf ?? 'none'}; the previous session was ${prev}.`);
    if (c.history && c.history.foAsOf == null) missing.push('F&O open interest (previous session)');
    if (!c.events) missing.push('corporate events for the day');
    if (!c.market?.gift) missing.push('GIFT Nifty morning reading');
    else if (c.market.gift.morning === false) stale.push('GIFT Nifty was read after the pre-open closed.');
    if (!c.market?.vix) missing.push('India VIX for the previous session');
    if (!c.market?.flows) missing.push('FII/DII flows for the previous session');
    if (!c.auction) missing.push('Kite auction readings (09:00–09:09)');
    if ((c.preopen?.days ?? 0) < MIN_RESEARCH_DAYS) missing.push(`recorded pre-open baseline (${c.preopen?.days ?? 0} of ${MIN_RESEARCH_DAYS} days needed)`);
    if (!s.snap.secList) missing.push('NSE price bands and surveillance list');
    if (!result.stocks.some((x) => x.marketCap != null)) {
      missing.push(result.hasMarketCap ? "full market cap (the master list's market-cap column is empty)" : 'full market cap (the master list has no market-cap column)');
    }
    const stock = symbol && result.stocks.find((x) => x.symbol === symbol);
    if (symbol && !stock) throw aiError('invalid', `${symbol} is not in this snapshot.`);
    return {
      result: roundDeep({
        date: s.snap.date,
        snapshot: { stocks: result.stocks.length, skippedNotInMaster: result.summary.skipped, exchangeAt: s.snap.times.exchangeAt, fetchedAt: s.snap.times.fetchedAt, recordedAt: s.snap.times.recordedAt ?? null },
        history: c.history ? { asOf: c.history.asOf, sessions: c.history.days, foAsOf: c.history.foAsOf ?? null } : null,
        events: c.events ? { fetchedAt: c.events.fetchedAt ?? null } : null,
        market: { gift: Boolean(c.market?.gift), vix: Boolean(c.market?.vix), flows: Boolean(c.market?.flows) },
        auction: c.auction ? { readings: c.auction.snaps, from: c.auction.from, to: c.auction.to } : null,
        preopenBaselineDays: c.preopen?.days ?? 0,
        masterListHasMarketCap: result.hasMarketCap,
        freeFloatCapAvailable: result.hasFreeFloatCap,
        outcomeForThisDay: outcome ? (s.mode === 'as-known' && !(outcome.availableAt <= s.cutoff) ? 'stored, but published after the cutoff' : 'stored') : 'not stored',
        missing,
        stale,
        stock: stock ? {
          symbol,
          convictionMissing: stock.conviction?.missing ?? null,
          historyMissing: stock.historyLayer?.missing ?? null,
          auctionMissing: stock.auctionLayer?.missing ?? (stock.auction ? null : ['no auction recording for this stock']),
          researchSessions: stock.researchDays ?? null,
          dataIssue: stock.dataIssue,
          ffmCapMissing: stock.ffmCap == null,
        } : null,
      }),
      meta: baseMeta(s, { title: `Data coverage, ${s.snap.date}${symbol ? ` (${symbol})` : ''}`, symbol: symbol ?? null }),
    };
  }

  return {
    session,
    analysisFor,
    functions: { getAnalysisSnapshot, getStockAnalysis, screenSnapshot, compareStocks, getRecordedDates, getHistoricalOutcomes, getDataCoverage },
  };
}

/** Recorded setups matching `q`, from morning fields only (no outcome is visible here). */
export function selectSetups(stocks, q) {
  return stocks.filter((st) => {
    if (!st.conviction || !(st.finalPrice > 0)) return false;
    if (q.direction === 'up' && !(st.pctChange > 0)) return false;
    if (q.direction === 'down' && !(st.pctChange < 0)) return false;
    const gap = Math.abs(st.pctChange);
    if (q.minGap != null && gap < q.minGap) return false;
    if (q.maxGap != null && gap > q.maxGap) return false;
    if (q.minScore != null && !(st.convictionScore >= q.minScore)) return false;
    if (q.maxScore != null && !(st.convictionScore <= q.maxScore)) return false;
    if (q.tradeableOnly && !isTradeable(st)) return false;
    if (q.sector && st.sector.toLowerCase() !== q.sector.toLowerCase()) return false;
    return true;
  });
}
