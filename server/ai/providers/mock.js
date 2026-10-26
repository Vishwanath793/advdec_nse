import { createMockEmbedder } from '../rag/embeddings.js';
import { estimateTokens, tokenize } from '../rag/text.js';

/**
 * Offline mock provider: no network, no cost, deterministic. It plans function
 * calls from keywords in the question and writes its answer only from the
 * evidence it was given (copying the numbers), so the whole pipeline —
 * functions, retrieval, citations, checks and the UI — can be tried without a
 * key. It does not understand language; its answers are templates.
 */

export const INSUFFICIENT = 'The available recorded data is insufficient to answer this.';

const FIELD_WORDS = [
  [/conviction( score)?/, 'convictionScore'], [/history score/, 'historyScore'], [/auction score/, 'auctionScore'],
  [/(rvol|relative volume|vol ×|vol x)/, 'rvolX'], [/gap size|abs(olute)? gap/, 'absGap'], [/\bgap\b( %| percent)?/, 'pctChange'],
  [/free[- ]float( market)? cap|ffm ?cap/, 'ffmCapCr'], [/pre-?open value|value \(?₹?/, 'valueCr'], [/delivery %|delivery percent/, 'delivPct'],
  [/quality rank/, 'qualityRank'], [/quality/, 'quality'], [/orders/, 'ordersPct'],
];
const OPS = [[/>=|at least|no less than|or more/, 'gte'], [/<=|at most|no more than|or less/, 'lte'], [/>|above|over|more than|greater than/, 'gt'], [/<|below|under|less than/, 'lt'], [/=|equal to|exactly/, 'eq']];

/** Numerical conditions written in a question ("conviction above 70 and gap between 1 and 3"). */
export function parseConditions(question) {
  // "between 1 and 3" must survive the split on "and".
  const q = question.toLowerCase().replace(/between\s+(-?\d+(?:\.\d+)?)\s*%?\s+and\s+/g, 'between $1 to ');
  const out = [];
  for (const part of q.split(/\band\b|,|;/)) {
    const field = FIELD_WORDS.find(([re]) => re.test(part))?.[1];
    if (!field) continue;
    const between = /between\s+(-?\d+(?:\.\d+)?)\s*%?\s*(?:and|to|-)\s*(-?\d+(?:\.\d+)?)/.exec(part);
    if (between) { out.push({ field, op: 'between', value: Number(between[1]), value2: Number(between[2]), values: null }); continue; }
    const num = /(-?\d+(?:\.\d+)?)/.exec(part.replace(/\d+:\d+/g, ''));
    const op = OPS.find(([re]) => re.test(part))?.[1];
    if (num && op) out.push({ field, op, value: Number(num[1]), value2: null, values: null });
  }
  if (/gap-?ups?\b/.test(q) && !/gap-?downs?/.test(q)) out.push({ field: 'direction', op: 'eq', value: null, value2: null, values: ['up'] });
  if (/gap-?downs?\b/.test(q) && !/gap-?ups?/.test(q)) out.push({ field: 'direction', op: 'eq', value: null, value2: null, values: ['down'] });
  return out;
}

const parse = (e) => { try { return JSON.parse(e.text); } catch { return null; } };
const fmt = (n, unit = '') => (n == null ? 'n/a' : `${n}${unit}`);

function plan(question, context, evidence) {
  const q = question.toLowerCase();
  const known = new Set(context.knownSymbols ?? []);
  const mentioned = (question.match(/\b[A-Z][A-Z0-9&-]{1,19}\b/g) ?? []).filter((s) => known.has(s));
  const symbols = [...new Set([...(context.symbols ?? []), ...mentioned])].slice(0, 5);
  const have = new Set(evidence.filter((e) => e.kind === 'data').map((e) => `${e.meta.fn}:${e.meta.symbol ?? ''}`));
  const calls = [];
  const call = (name, args) => calls.push({ name, args });
  const explanatory = /^(explain|what is|what's|how does|define)\b|difference between/.test(q) && !symbols.length;

  if (/compar/.test(q) && symbols.length >= 2) call('compareStocks', { symbols });
  else if (!explanatory) for (const symbol of symbols.slice(0, 3)) if (!have.has(`getStockAnalysis:${symbol}`)) call('getStockAnalysis', { symbol });
  const conditions = parseConditions(question);
  if (/\bwhich\b|stocks (that|with|where)|satisf|screen|list (the )?stocks/.test(q) && conditions.some((c) => c.field !== 'direction')) {
    call('screenSnapshot', { conditions, useMyFilters: false, tradeableOnly: /tradeable/.test(q), sortBy: conditions.find((c) => c.field !== 'direction')?.field ?? null, sortDir: 'desc', limit: 10 });
  }
  if (/breadth|sector activity|summari[sz]e (the )?(selected )?day|advance|decline/.test(q) && !/conviction/.test(q)) call('getAnalysisSnapshot', {});
  if (/recorded mornings|compare with recorded|this morning compare/.test(q)) { call('getRecordedDates', {}); call('getAnalysisSnapshot', {}); }
  if (/similar|happened after|what happened|past setups|earlier setups/.test(q)) {
    const stock = evidence.map(parse).find((d) => d?.symbol && d?.prices);
    const gap = stock?.prices?.gapPct;
    call('getHistoricalOutcomes', {
      direction: gap > 0 ? 'up' : gap < 0 ? 'down' : 'both',
      minGap: gap != null ? Math.max(0, Math.floor(Math.abs(gap) * 2) / 2 - 0.5) : null,
      maxGap: gap != null ? Math.ceil(Math.abs(gap) * 2) / 2 + 0.5 : null,
      minScore: null, maxScore: null, tradeableOnly: false, sector: null, lastDays: null,
    });
  }
  if (/missing|stale|coverage|blank|incomplete/.test(q)) call('getDataCoverage', { symbol: symbols[0] ?? null });
  return calls;
}

function compose(question, context, evidence) {
  const q = question.toLowerCase();
  const supporting = [];
  const contradicting = [];
  const missing = [];
  const lines = [];
  const cite = (id) => `[${id}]`;

  const compared = evidence.some((x) => x.meta.fn === 'compareStocks');
  for (const e of evidence.filter((x) => x.kind === 'data')) {
    const d = parse(e);
    if (!d) continue;
    switch (e.meta.fn) {
      case 'getStockAnalysis': {
        if (compared) break; // the comparison already has one line per stock
        const c = d.conviction;
        if (c?.score != null) {
          lines.push(`${d.symbol} (${d.direction} ${fmt(d.prices.gapPct, '%')}) has a conviction score of ${c.score} with your active factors ${cite(e.id)}.`);
          const factors = [...(c.factors ?? [])].sort((a, b) => b.sharePct - a.sharePct);
          for (const f of factors) {
            const item = { claim: `${f.label}: scored ${f.score01} of 1 with a ${f.sharePct}% weight share (${f.detail ?? 'no detail'})`, kind: 'observation', sources: [e.id] };
            if (f.score01 >= 0.6) supporting.push(item);
            else if (f.score01 <= 0.4) contradicting.push(item);
          }
          if (c.cappedBy?.length) contradicting.push({ claim: `The score is capped because of ${c.cappedBy.join(', ')}`, kind: 'observation', sources: [e.id] });
          for (const m of c.missingData ?? []) missing.push({ item: `${m} (no data, left out of the score)`, sources: [e.id] });
        } else lines.push(`${d.symbol} has no conviction score: ${c?.reason ?? 'not scored'} ${cite(e.id)}.`);
        if (d.history?.score != null) lines.push(`History score ${d.history.score} (${d.history.coverage} factors) ${cite(e.id)}.`);
        if (d.auction?.score != null) lines.push(`Auction score ${d.auction.score} ${cite(e.id)}.`);
        else if (d.auction?.reason) missing.push({ item: `Auction score: ${d.auction.reason}`, sources: [e.id] });
        if (/filter|pass|fail/.test(q)) {
          lines.push(d.stockFilter.pass
            ? `It passes your Stock filter (quality ${fmt(d.stockFilter.quality)}, rank ${fmt(d.stockFilter.rank)}) ${cite(e.id)}.`
            : `It fails your Stock filter because: ${d.stockFilter.failedBecause.join('; ')} ${cite(e.id)}.`);
        }
        if (/market cap|cap blank/.test(q)) lines.push(`${d.marketCapNote} Free-float cap: ${fmt(d.ffmCapCr)} ₹ Cr ${cite(e.id)}.`);
        for (const f of d.flags ?? []) contradicting.push({ claim: `${f.label}: ${f.detail}`, kind: 'observation', sources: [e.id] });
        break;
      }
      case 'compareStocks':
        for (const s of d.stocks) lines.push(`${s.symbol}: gap ${fmt(s.gapPct, '%')}, conviction ${fmt(s.conviction)}, History ${fmt(s.history)}, Auction ${fmt(s.auction)}, quality rank ${fmt(s.qualityRank)}${s.tradeable ? '' : ', not tradeable'} ${cite(e.id)}.`);
        break;
      case 'screenSnapshot':
        lines.push(d.matched
          ? `${d.matched} stocks meet the conditions; the first ${d.shown} by ${d.sortedBy}: ${d.stocks.map((s) => s.symbol).join(', ')} ${cite(e.id)}.`
          : `No stock in this snapshot meets those conditions ${cite(e.id)}.`);
        break;
      case 'getAnalysisSnapshot': {
        const b = d.breadth;
        lines.push(`On ${d.date}, ${b.advances} stocks advanced and ${b.declines} declined in the pre-open (${b.unchanged} unchanged) ${cite(e.id)}.`);
        const top = d.sectors?.[0];
        if (top) supporting.push({ claim: `Largest sector ${top.sector}: ${top.advances} up, ${top.declines} down`, kind: 'observation', sources: [e.id] });
        break;
      }
      case 'getRecordedDates':
        lines.push(`${d.recorded} recorded days are available for comparison ${cite(e.id)}.`);
        break;
      case 'getHistoricalOutcomes':
        if (!d.withOutcome) lines.push(`No similar recorded setup has a stored outcome yet ${cite(e.id)}.`);
        else {
          lines.push(`Retrospective: ${d.withOutcome} similar recorded setups have outcomes; ${d.closedBeyondEntry} closed beyond the pre-open price, average ${fmt(d.avgCloseVsEntryPct, '%')} ${cite(e.id)}. That is a small sample, not a forecast.`);
        }
        break;
      case 'getDataCoverage':
        for (const m of d.missing ?? []) missing.push({ item: m, sources: [e.id] });
        for (const s of d.stale ?? []) missing.push({ item: `Stale: ${s}`, sources: [e.id] });
        if (d.stock?.convictionMissing?.length) missing.push({ item: `${d.stock.symbol}: no data for ${d.stock.convictionMissing.join(', ')}`, sources: [e.id] });
        if (!d.missing?.length && !d.stale?.length) lines.push(`No missing or stale inputs were found for ${d.date} ${cite(e.id)}.`);
        break;
      default:
    }
  }

  // A document answers only when it shares enough of the question's terms (at least 2, and 40% of them).
  const terms = [...new Set(tokenize(question))];
  const relevant = (d) => {
    const words = new Set(tokenize(`${d.title} ${d.text}`));
    return terms.filter((t) => words.has(t)).length >= Math.max(2, Math.ceil(terms.length * 0.4));
  };
  const top = evidence.filter((x) => x.kind === 'doc').find(relevant);
  if (!lines.length && top) {
    const sentence = top.text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/).slice(0, 3).join(' ');
    lines.push(`From "${top.title}": ${sentence} ${cite(top.id)}`);
    supporting.push({ claim: sentence.slice(0, 240), kind: 'observation', sources: [top.id] });
  }
  const insufficient = !lines.length;
  return {
    answer: insufficient ? INSUFFICIENT : lines.join(' '),
    insufficient,
    supporting,
    contradicting,
    missing,
    sourcesUsed: [...new Set([...supporting, ...contradicting, ...missing].flatMap((x) => x.sources))],
  };
}

export function createMockProvider() {
  let n = 0;
  return {
    name: 'mock',
    model: 'mock-analyst-v1',
    embedder: createMockEmbedder(),
    async respond({ question, context, evidence, tools, round = 1, signal }) {
      if (signal?.aborted) { const e = new Error('Cancelled.'); e.name = 'AbortError'; throw e; }
      // Plans once (the first round), then answers from what came back.
      const calls = tools.length && round === 1 ? plan(question, context, evidence).filter((c) => tools.some((t) => t.name === c.name)) : [];
      const input = estimateTokens(evidence.map((e) => e.text).join('\n')) + estimateTokens(question);
      if (calls.length) {
        return {
          toolCalls: calls.map((c) => ({ callId: `mock_${++n}`, name: c.name, arguments: JSON.stringify(c.args) })),
          continuation: [],
          text: null,
          usage: { input, output: 20 * calls.length },
        };
      }
      const text = JSON.stringify(compose(question, context, evidence));
      return { toolCalls: [], continuation: [], text, usage: { input, output: estimateTokens(text) } };
    },
  };
}
