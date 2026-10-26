# AI Analyst

The **AI Analyst** tab answers research questions about an Analyzer snapshot: why a stock has its conviction score,
why it passes or fails the Stock filter, how stocks compare, which stocks meet exact conditions, what data is
missing or stale, and what happened after similar recorded setups. Every answer lists its sources.

It is **read-only research**. It cannot place, modify, cancel or schedule orders, square off positions or change
any setting. That is enforced in code: the model can call only seven read-only functions (`server/ai/tools.js`),
and nothing under `server/ai` imports the order scheduler, the Kite client, the trading desk or the paper broker
(a test checks this). Scores are rankings, not win probabilities, and nothing here predicts profit.

## Set it up

The app runs normally without any of this; the tab then says "AI not configured".

In the backend `.env` (never in the browser or the Android app):

| Setting | Meaning |
|---|---|
| `AI_PROVIDER` | `off` (default), `openai`, or `mock` (offline, free, template answers) |
| `AI_API_KEY` | the provider key. Separate from TV research's `OPENAI_API_KEY` (it may hold the same value) |
| `AI_MODEL` | generation model (default `gpt-6.1-sol`, from OpenAI's model list checked 26 Oct 2026) |
| `AI_EMBEDDING_MODEL` | embedding model (default `text-embedding-3-small`); `none` = keyword search only |
| `AI_MAX_OUTPUT_TOKENS`, `AI_EVIDENCE_TOKENS` | answer length and evidence budget per question |
| `AI_TIMEOUT_MS`, `AI_MAX_CONCURRENT` | per call timeout (45 s) and questions at once (2) |
| `AI_DAILY_TOKEN_BUDGET`, `AI_DAILY_CALL_BUDGET` | daily limits per IST day (300,000 tokens, 300 calls) |
| `AI_PRICE_INPUT_PER_1M`, `AI_PRICE_OUTPUT_PER_1M`, `AI_PRICE_EMBEDDING_PER_1M`, `AI_PRICE_CURRENCY` | optional prices; without them no cost is estimated |
| `AI_TV_RESEARCH` | `1` also indexes completed TV research summaries (read only; off by default) |
| `AI_QUIET_WINDOW` | IST window when questions wait on trading days (default `09:13-09:31`; `off`) |
| `AI_AUTO_EMBED` | `1` embeds new passages automatically each evening (costs tokens); default off |

Restart the backend after changing `.env`.

### Try it without paid calls

Start the backend with `AI_PROVIDER=mock` (for example `set AI_PROVIDER=mock&& npm run server` in `cmd`). The mock
plans function calls from keywords and writes template answers from the same data and sources, so the whole
pipeline (functions, retrieval, citations, checks, UI) works offline. It does not understand language.

`npm run ai:eval` runs the evaluation set (below) against the configured provider; with a real provider it asks for
`-- --yes` first because it makes about 60 paid calls.

## How an answer is built

1. **The analysis is identified exactly.** "Ask AI" on an Analyzer row sends the snapshot ID (trading date + a hash
   of the pre-open rows), the normalised conviction factors and Stock filter settings with their hash, and
   fingerprints of the market context and inputs. The backend recomputes each one. A mismatch (for example the
   backend refreshed its market context after the page loaded) is refused with "reload the Analyzer"; the backend
   never silently explains different numbers. Recorded mornings are rebuilt from what was saved that morning, as
   the report card does.
2. **Structured data, not the model, supplies numbers.** `server/ai/data.js` runs the same pure `analyze()` and
   `screenStocks()` as the Analyzer. Functions: `getAnalysisSnapshot`, `getStockAnalysis`, `screenSnapshot`
   (validated fields and operators only), `compareStocks` (2–5), `getRecordedDates`, `getHistoricalOutcomes`,
   `getDataCoverage`. Every argument is validated and every result bounded. No SQL, code, file paths or URLs.
3. **Documents come from an allowlist (RAG).** `server/ai/rag/sources.js`: README, the Android README, CLAUDE.md,
   DEVLOG.md, this guide, the Analyzer review; a factor glossary generated from the current code; approved research
   notes; one compact summary per recorded morning; one retrospective outcome summary per day with a stored
   end-of-day file; optionally TV research summaries. Never `.env`, keys, sessions, orders, browser profiles, logs,
   ticks or `node_modules`, and secrets are redacted before indexing.
4. **Indexing** (in a worker thread, never 08:55–09:35 IST on trading days): normalise → chunk by headings and
   paragraphs (a chunk never crosses a heading or mixes dates) → embed → `.data/ai/index/`. Incremental by content
   hash. Vectors are stored per embedding model and version and never mixed. Each chunk keeps its id, source type
   and reference, symbol, trading date, availability and ingestion times, version, content hash.
5. **Hybrid retrieval** (`rag/retrieve.js`): exact symbol/date matches, BM25 keyword search and vector similarity,
   merged by reciprocal rank fusion (exact matches weigh 1.5), de-duplicated by content hash, and cut to 6 chunks
   and the token budget. Without embeddings the answer says "keyword only" and why.
6. **Grounded answer.** The model gets the evidence with ids (`E1` data, `D1` documents; documents fenced as
   untrusted data), may call the read-only functions, and must return JSON: answer, supporting, contradicting,
   missing, sources. The server then removes citations that were never supplied, drops claims left without a source,
   checks every stated number against the cited evidence, flags probability or profit wording, removes confidence
   percentages, and treats an answer citing nothing as "The available recorded data is insufficient to answer
   this." Titles, dates, excerpts and links are resolved on the server.

## As known vs retrospective

- **As known at the selected time** (default): the cutoff is when the snapshot became available (or a time you
  type, IST). Market documents published after the cutoff, or with unknown availability, are left out. The Analyzer
  view is refused if any of its inputs arrived after the cutoff. Similar setups come only from earlier days whose
  end-of-day file was published by the cutoff.
- **Retrospective research**: later outcomes may be used, and claims resting on them appear only under "Later
  outcomes (retrospective)".
- Similar setups are always chosen from morning data only; outcomes are joined afterwards (a test changes the
  outcomes and checks the selection does not change).
- Times shown: exchange timestamp (NSE update time), fetch time, availability time, trading date, all IST.

## Costs and safety limits

Each question uses 1–3 generation calls plus one embedding call. Usage is counted per IST day in
`.data/ai/usage-YYYY-MM-DD.json`; the daily budget stops further calls. Answers in "as known" mode are cached by
question, snapshot, profile, context, prompt version, model and index version. Questions pause 09:13–09:31 IST on
trading days, and an AI failure never touches the opening collector, the order sender or other pages.

## Evaluation

`server/fixtures/ai-eval.json` holds 22 questions over made-up data (`server/fixtures/aiFixture.js`), each with the
evidence that must be supplied, evidence that must be excluded, required facts, required values (checked against
the data function's own result and its citation) and whether to abstain. Metrics: retrieval success, supported
numbers, citation validity, correct abstention, required facts, read-only. `server/aiEval.test.js` runs it with the
mock (all must be 100%); `npm run ai:eval` runs it against a real provider.

## Android

The phone app shows the tab as unavailable: it has no secure backend connection, and provider keys are never put
in the APK.
