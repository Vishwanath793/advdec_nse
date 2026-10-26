import { normalizeProfile, profileHash } from '../../src/utils/aiContext.js';
import { extractNumbers, supported } from './evidence.js';

/**
 * Evaluation of the AI Analyst over a fixed question set
 * (server/fixtures/ai-eval.json). Fluent wording is not a criterion; each case
 * is scored on:
 *  - retrieval: the expected evidence (data function or document) was supplied,
 *    and evidence that must be excluded (after the cutoff) was not;
 *  - numbers: every number stated in the answer and claims was found in the cited evidence;
 *  - citations: no fabricated or unsupplied ids;
 *  - abstention: "insufficient" exactly when expected;
 *  - facts: required phrases are stated, and required values equal the data
 *    function's own result and are cited from that function (evidence supports the claim);
 *  - read-only: no refused (order-changing or unknown) function calls.
 */

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Keys of the evidence a response was given: `fn:SYMBOL` for data, the document id for passages. */
function evidenceKeys(r) {
  return new Set([...(r.sources ?? []), ...(r.consulted ?? [])].map((s) => (s.kind === 'doc' ? String(s.chunkId ?? '').split('#')[0] : `${s.ref}:${s.symbol ?? ''}`)));
}

export async function runEvaluation({ analyst, data, analysis, cases }) {
  const results = [];
  for (const c of cases) {
    const mode = c.mode ?? 'as-known';
    const body = { question: c.question, symbols: c.symbols ?? [], mode, history: [], analysis };
    let r;
    try { r = await analyst.ask(body); } catch (error) {
      results.push({ id: c.id, error: error.message, retrieval: false, numbers: false, citations: false, abstention: false, facts: false, readOnly: true });
      continue;
    }
    const keys = evidenceKeys(r);
    const has = (k) => (k.endsWith(':') ? [...keys].some((x) => x === k || x.startsWith(k)) : keys.has(k));
    const text = [r.answer, ...[...r.supporting, ...r.contradicting, ...r.retrospective].map((x) => x.claim), ...r.missing.map((m) => m.item)].join('\n');
    const stated = extractNumbers(text);

    const valueChecks = [];
    for (const v of c.requiredValues ?? []) {
      const session = await data.session({ ref: { source: analysis.source, snapshotId: analysis.snapshotId }, profile: analysis.profile, mode, cutoff: null });
      const expected = get((await data.functions[v.fn](session, v.args)).result, v.path);
      const statedOk = typeof expected === 'number' && stated.some((n) => supported(n, [expected]) && Math.abs(Math.abs(n.value) - Math.abs(expected)) < 1);
      const citedFromFn = r.sources.some((s) => s.ref === v.fn || (v.fn === 'getStockAnalysis' && s.ref === 'compareStocks'));
      valueChecks.push({ ...v, expected, ok: statedOk && citedFromFn });
    }
    const missingEvidence = (c.expectEvidence ?? []).filter((k) => !has(k));
    const leaked = (c.absentEvidence ?? []).filter((k) => has(k));
    results.push({
      id: c.id,
      retrieval: !missingEvidence.length && !leaked.length,
      missingEvidence,
      leaked,
      numbers: r.checks.unsupportedNumbers.length === 0,
      numbersStated: stated.length,
      numbersUnsupported: r.checks.unsupportedNumbers.length,
      citations: r.checks.unknownCitations.length === 0 && r.checks.droppedClaims.length === 0,
      abstention: r.insufficient === Boolean(c.expectInsufficient),
      facts: (c.requiredText ?? []).every((t) => text.toLowerCase().includes(t.toLowerCase())) && valueChecks.every((v) => v.ok),
      valueChecks,
      readOnly: r.checks.refusedCalls.length === 0,
      answer: r.answer,
    });
  }
  const share = (k) => results.filter((x) => x[k]).length / Math.max(1, results.length);
  const stated = results.reduce((n, x) => n + (x.numbersStated ?? 0), 0);
  const unsupported = results.reduce((n, x) => n + (x.numbersUnsupported ?? 0), 0);
  return {
    cases: results.length,
    metrics: {
      retrievalSuccess: share('retrieval'),
      supportedNumbers: stated ? (stated - unsupported) / stated : 1,
      citationValidity: share('citations'),
      correctAbstention: share('abstention'),
      requiredFacts: share('facts'),
      readOnly: share('readOnly'),
    },
    results,
  };
}

/** The analysis context for the fixture's Analyzer view, as the browser would send it. */
export function fixtureAnalysis(snapshotId, { contextFp, inputsFp }) {
  const profile = normalizeProfile({});
  return { source: 'analyzer', snapshotId, profile, profileHash: profileHash(profile), contextFp, inputsFp };
}
