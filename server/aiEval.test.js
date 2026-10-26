import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCalendar } from './tv/calendar.js';
import { contextFingerprint, inputsFingerprint, normalizeProfile } from '../src/utils/aiContext.js';
import { aiConfig } from './ai/config.js';
import { createUsageLedger } from './ai/usage.js';
import { createIndexStore } from './ai/rag/indexStore.js';
import { runIndexing } from './ai/rag/indexer.js';
import { createRetriever } from './ai/rag/retrieve.js';
import { buildGlossary } from './ai/rag/glossary.js';
import { createAnalystData } from './ai/data.js';
import { createAnalyst } from './ai/analyst.js';
import { createMockProvider } from './ai/providers/mock.js';
import { fixtureAnalysis, runEvaluation } from './ai/eval.js';
import { FIXTURE_DOCS, MASTER, contextFor, fixtureSnapshots, memoryStore } from './fixtures/aiFixture.js';

/**
 * The evaluation set (server/fixtures/ai-eval.json) run end to end with the
 * offline mock provider: data functions, hybrid retrieval, citations, number
 * checks and abstention. The mock is deterministic, so every metric must be 1;
 * `npm run ai:eval` runs the same set against the configured provider.
 */
test('evaluation set: retrieval, supported numbers, citations, abstention, facts, read-only', async () => {
  const { cases } = JSON.parse(readFileSync(new URL('./fixtures/ai-eval.json', import.meta.url), 'utf8'));
  assert.ok(cases.length >= 20);
  const now = () => new Date('2026-10-26T10:00:00Z');
  const store = memoryStore();
  const provider = createMockProvider();
  const config = { ...aiConfig({ AI_PROVIDER: 'mock' }), quietWindow: null, dailyCallBudget: 10_000, dailyTokenBudget: 1e9 };
  const indexStore = createIndexStore(store);
  const glossary = { docId: 'glossary:factors', sourceType: 'glossary', sourceRef: 'generated', title: 'Factor glossary', kind: 'methodology', availableAt: '2026-10-01T00:00:00.000Z', version: 'glossary-v1', text: buildGlossary() };
  await runIndexing({ indexStore, docs: [...FIXTURE_DOCS, glossary], embedder: provider.embedder });
  const snapshots = fixtureSnapshots();
  const data = createAnalystData({ snapshots, calendar: readCalendar(), now });
  const analyst = createAnalyst({
    config, provider, data, now, calendar: readCalendar(),
    retriever: createRetriever({ indexStore, embedder: provider.embedder }),
    usage: createUsageLedger({ store, config, now }),
  });
  const live = (await snapshots.list()).find((s) => s.source === 'analyzer');
  const analysis = fixtureAnalysis(live.snapshotId, { contextFp: contextFingerprint(contextFor('2026-10-22'), normalizeProfile({})), inputsFp: inputsFingerprint({ masterRows: MASTER, priceBands: null }) });
  const report = await runEvaluation({ analyst, data, analysis, cases });
  const failures = report.results.filter((r) => !(r.retrieval && r.numbers && r.citations && r.abstention && r.facts && r.readOnly));
  assert.deepEqual(failures.map((f) => ({ id: f.id, error: f.error, missing: f.missingEvidence, leaked: f.leaked, numbers: f.numbers, abstention: f.abstention, facts: f.facts, values: f.valueChecks?.filter((v) => !v.ok), answer: f.answer })), []);
  for (const [k, v] of Object.entries(report.metrics)) assert.equal(v, 1, k);
  assert.ok(report.results.some((r) => r.numbersStated > 0));
});
