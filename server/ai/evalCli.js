import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { readCalendar } from '../tv/calendar.js';
import { contextFingerprint, inputsFingerprint, normalizeProfile } from '../../src/utils/aiContext.js';
import { aiConfig, configProblem } from './config.js';
import { createUsageLedger } from './usage.js';
import { createIndexStore } from './rag/indexStore.js';
import { runIndexing } from './rag/indexer.js';
import { createRetriever } from './rag/retrieve.js';
import { buildGlossary } from './rag/glossary.js';
import { createAnalystData } from './data.js';
import { createAnalyst } from './analyst.js';
import { makeProvider } from './providers/index.js';
import { fixtureAnalysis, runEvaluation } from './eval.js';
import { FIXTURE_DOCS, MASTER, contextFor, fixtureSnapshots, memoryStore } from '../fixtures/aiFixture.js';

/**
 * npm run ai:eval [-- --yes]
 * Runs the evaluation set (server/fixtures/ai-eval.json, made-up data) against
 * the provider configured in .env. With a real provider this makes paid calls
 * (about 2–3 per question plus embeddings for the small fixture index), so it
 * needs --yes. With AI_PROVIDER=mock it is free and offline.
 */
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

async function main() {
  const config = { ...aiConfig(), quietWindow: null };
  const problem = configProblem(config);
  if (problem) throw new Error(problem);
  if (config.provider !== 'mock' && !process.argv.includes('--yes')) {
    throw new Error(`This calls ${config.provider} (${config.model}, ${config.embeddingModel}) about 60 times. Run with -- --yes to go ahead.`);
  }
  const { cases } = JSON.parse(readFileSync(new URL('../fixtures/ai-eval.json', import.meta.url), 'utf8'));
  const store = memoryStore();
  const provider = makeProvider(config);
  const now = () => new Date();
  const usage = createUsageLedger({ store, config, now });
  const indexStore = createIndexStore(store);
  const glossary = { docId: 'glossary:factors', sourceType: 'glossary', sourceRef: 'generated', title: 'Factor glossary', kind: 'methodology', availableAt: '2026-10-01T00:00:00.000Z', version: 'glossary-v1', text: buildGlossary() };
  await runIndexing({ indexStore, docs: [...FIXTURE_DOCS, glossary], embedder: provider.embedder, onUsage: ({ input }) => usage.add('embed', { input }) });
  const snapshots = fixtureSnapshots();
  const data = createAnalystData({ snapshots, calendar: readCalendar(), now });
  const analyst = createAnalyst({ config, provider, data, retriever: createRetriever({ indexStore, embedder: provider.embedder }), usage, calendar: readCalendar(), now });
  const live = (await snapshots.list()).find((s) => s.source === 'analyzer');
  const analysis = fixtureAnalysis(live.snapshotId, { contextFp: contextFingerprint(contextFor('2026-10-22'), normalizeProfile({})), inputsFp: inputsFingerprint({ masterRows: MASTER, priceBands: null }) });
  const report = await runEvaluation({ analyst, data, analysis, cases });
  for (const r of report.results) {
    const fails = ['retrieval', 'numbers', 'citations', 'abstention', 'facts', 'readOnly'].filter((k) => !r[k]);
    console.log(`${fails.length ? 'FAIL' : 'ok  '} ${r.id}${fails.length ? ` (${fails.join(', ')})` : ''}${r.error ? ` error: ${r.error}` : ''}`);
  }
  console.log('\nMetrics:', Object.fromEntries(Object.entries(report.metrics).map(([k, v]) => [k, `${Math.round(v * 100)}%`])));
  console.log('Usage:', await usage.summary());
}

// A clean message and exit code instead of a stack trace (process.exit here trips a libuv assertion on Windows).
main().catch((error) => {
  console.error(`Evaluation stopped: ${error.message}`);
  process.exitCode = 1;
});
