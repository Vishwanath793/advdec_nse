# Development log (shared by every developer)

One file where everyone working on this repo, people and Claude Code sessions from any account, records what
they are doing and what they finished. **Read it before you start; add to it when you start and when you finish.**

- **Before starting:** read *Work in progress* and the latest entries, so you don't build the same thing twice
  or change code someone else is in the middle of. Then add yourself to *Work in progress*.
- **When you finish (or stop for the day):** move your line out of *Work in progress* and add an entry at the top
  of *Entries* (newest first) using the template. Commit the log in the same commit as the work, or straight
  after it.
- **Keep it short and factual.** Say what changed, which files, which tests, **what is not verified**, and what
  should happen next. Long design notes belong in [CLAUDE.md](CLAUDE.md) or `docs/`.
- **Pull before you edit this file.** If two people edit it at once, keep both entries when you resolve the
  conflict.

The project-wide rules (PAPER only until milestone 4, the Kite token in memory only, the static IP, don't touch TV
research, and so on) are in [CLAUDE.md](CLAUDE.md) §2. They apply to everyone.

---

## Work in progress

| Who (name / account) | Branch | What | Started | Files / areas touched |
|---|---|---|---|---|
| Vishwanath793 with Claude Code (DELL) — **paused** | android-app | Milestone 3 part 2: Kite historical candle download + cache, server routes, Research section on the Report card page with Excel export. Uncommitted in the shared folder: `src/core/backtestData.js` (planner + candle cache, loads) and `server/backtestData.test.js` (cut off, not in the test script) | 2026-10-19 | new src/core/backtestData.js, server/researchRoutes.js, src/ResearchPanel.jsx; src/ReportCardPage.jsx, src/platform/web.js, server/index.js; tests |
---

## Entry template

```markdown
### YYYY-MM-DD: short title (who, branch, commit)
**What changed:** …
**Files:** …
**Tests / checks:** npm test (N pass), npm run build, npx cap sync android, browser check …
**Not verified:** …
**Next / open questions:** …
```

---

## Entries (newest first)

### 2026-10-27: 9:15 gap entry, phase 1 (PAPER) (Claude Code for vinayakb374, android-app, local commit)
**What changed:** A paper market entry at 09:15 for the stocks on a "gap list". The gap (in ATR) sets the size,
the stop and the targets. It always enters; the gap only makes the size smaller. Spec: [docs/prompt-915-gap-exits.md](docs/prompt-915-gap-exits.md)
(phase 2, LIVE exits, is **not** started).
- Gap types: flat < 0.2 ≤ normal < 0.8 ≤ large < 1.5 ≤ extreme. Size × 1 / 1 / 0.5 / 0.25, × 0.5 near the circuit,
  × 0.5 for a fixed-target plan under the minimum reward/risk, × 0.5 when ATR is missing (estimated at 2%).
  Never below 0.25, never under one share.
- Stop: max(0.35 ATR, just below the half-gap fill) for flat/normal, 0.5 ATR for large/extreme, at most 0.6 ATR.
  T1 1 R (half out, stop to breakeven + costs); T2 = min(2.5 R, 1.3 ATR − gap, previous high) for flat/normal,
  else trail (last 5-minute bar, or ATR). Levels re-planned from the fill.
- 09:20 check (stop to the opening-range low − 0.05 ATR; exit if below VWAP and the open), time stop 09:45
  (under 0.5 R and no T1), square-off, kill switch.
- Same ledger as the 09:20 system (strategy `gap915`, order id `date-symbol-gap915`, tag `P915…`). It doesn't use the
  09:20 slots or the losing streak. Its P&L counts towards the daily loss and is also totalled in `state.gap`.
- Orders page: "9:15 gap entry" card (gap list, plans, positions after the fill, check a stock, report by gap type
  with Excel). The scheduled-order form shows the gap plan's quantity for a 09:15 market order (display only).
  Settings: the numbers. The scanner chart draws the 9:15 levels.
- Optional read-only paper shadow of scheduled MARKET orders sent 09:15:00–09:15:59 (off by default; the real order
  is never changed). The collector always watches the gap-list stocks.
- The simulated replay uses demo gap entries (MOMO, ORBUP, ORBDN short, DEADCAT, GAPPULL, LOCKED) when none of the
  saved list is in it.

**Files:** new `src/utils/gapExits.js`, `src/GapEntryPanel.jsx`, `server/gapExits.test.js`, `docs/prompt-915-gap-exits.md`;
`src/utils/paperLedger.js`, `src/core/paperBroker.js`, `src/core/tradingDesk.js`, `src/core/openingCollector.js`
(onStart hook; replays pass every tick to the desk), `src/utils/simulatedMorning.js`, `server/tradingRoutes.js`,
`server/index.js`, `src/platform/web.js`, `src/OrdersPage.jsx`, `src/TradingPanel.jsx`, `src/OpeningChart.jsx`,
`src/OpeningScanner.jsx`, `src/styles.css`, `server/openingCollector.test.js`, `package.json`.
`server/index.js` and `src/platform/web.js` are also in the paused milestone 3 row. These are additive edits in
other sections; there were no uncommitted changes in them. `src/ReportCardPage.jsx` was left alone, so the gap
report is on the Orders page.

**Tests / checks:** npm test (299 pass, 19 new in `server/gapExits.test.js`), npm run build, npx cap sync android,
`node --check server/index.js`.

**Browser check (same day, after restarting the :3002 backend):**
- No scheduled order was pending; the restart was at 17:26 IST.
- The simulated replay gave the same 5 gap trades as the tests (net ₹189.25 after ₹67.02 charges; LOCKED never
  filled).
- The Orders card, "Check a stock" (INFY from today's pre-open), the empty report with its Excel link, the
  Settings section and the scheduled-order quantity hint all render. There were no console errors.
- The gap list was not saved (still empty) and no order was scheduled.

**Not verified:**
- Nothing has run in market hours.
- The Kite tick fields used at 09:20 (day low/high, average price) are as documented for full mode; they haven't
  been checked live.

**Next / open questions:** Restart the backend, save a gap list, run the simulated replay (Confirm page) and check the
Orders card. Phase 2 (LIVE SL-M/IOC exits on scheduled 09:15 orders) waits for the owner's go-ahead after a paper period.

### 2026-10-27: Kite login redirect works when the backend serves the app (Claude Code for vinayakb374, android-app, local commit)
**Problem:** Settings tells you to set the Kite app's redirect URL to `<origin>/kite/callback`. That path only worked
under the Vite dev server, which serves the app for any path. The backend serves the built app with
`express.static` only, so logging in through `http://localhost:3002` ended on "Cannot GET /kite/callback". The
backend never got a session, and the owner's 09:15 BUY 10 CHOICEIN (order S9, created at 09:12 from the in-app
browser pane, which had no Kite login) failed with "Kite was not connected". Nothing reached Kite.

**What changed:** `server/index.js` serves `dist/index.html` at `/kite/callback`. The page then exchanges the
request token exactly as under Vite.

**Tests / checks:**
- `npm test`: 280 pass.
- One full run had a single failure in the real-time spin test (`orderSender.test.js`). It passed 3 times alone and
  on the next full run, so it looks load-sensitive.
- With the backend restarted on :3002 (no pending orders, no session held), `/kite/callback` returns the app.
- A `status=cancelled` redirect lands on Settings with "Kite login cancelled." and makes no token exchange.

**Not verified:** a real login through the fixed path (the owner logs in next).

### 2026-10-26: AI Analyst tab: read-only, grounded Q&A with structured data and RAG (Claude Code for vinayakb374, android-app, local commit)
**What changed:** a new **AI Analyst** tab and an **Ask AI** button on each Analyzer row. It answers questions
about one snapshot (why a conviction score, why a filter pass/fail, comparisons, exact numeric screens, missing or
stale data, similar recorded setups, breadth) with supporting, contradicting and missing evidence and a source card
for every claim. Full design and setup: [docs/ai-analyst.md](docs/ai-analyst.md).
- **Read-only by construction:** the model can call only seven read-only functions (`server/ai/tools.js`, strict
  schemas plus server-side validation, bounded results). Nothing in `server/ai` imports the scheduler, the Kite
  client, the trading desk or the paper broker; a test checks the sources. Unknown calls (e.g. `placeOrder`) are refused and reported.
- **Exact analysis:** the browser sends the snapshot ID (date + hash of the pre-open rows), the normalised factor
  and Stock filter profile with its hash, and fingerprints of the context and inputs (`src/utils/aiContext.js`).
  The backend recomputes them and refuses a mismatch ("reload the Analyzer"). The context fingerprint counts only
  inputs that can change the numbers: GIFT Nifty, VIX and FII/DII only when their factor is on, and event contents,
  not their re-fetch time. Found in the browser: GIFT Nifty is re-read every 5 min in market hours, so the first
  version refused questions after a few minutes. Recorded mornings are rebuilt as the report card does
  (`recorder.dayInputs`, a new read-only accessor).
- **Numbers come from the data functions** (`server/ai/data.js`, the same `analyze`/`screenStocks`), never the model.
  The server drops citations that weren't supplied and claims left without a source. It checks every stated number
  against the cited evidence and flags probability or promise wording. It strips confidence percentages, and
  treats an uncited answer as "The available recorded data is insufficient to answer this."
- **RAG** (`server/ai/rag/`): an allowlist only. The sources are the READMEs, CLAUDE.md, DEVLOG.md,
  docs/ai-analyst.md and the Analyzer review; a factor glossary generated from the code; approved notes in
  `.data/ai/notes/`; a per-day morning summary and a retrospective outcome summary; and optional TV research
  summaries (`AI_TV_RESEARCH=1`). Secrets are redacted.
  - Chunks split by heading and paragraph, with metadata and a content hash; indexing is incremental.
  - Vectors are stored per embedding model and never mixed.
  - Retrieval is hybrid (exact symbol/date, BM25, vectors) merged by reciprocal rank fusion, de-duplicated, bounded by
    chunks and tokens, and labels keyword-only fallback.
  - The index lives in `.data/ai/index/` and is built in a **worker thread**. Indexing never runs 08:55–09:35 IST on
    trading days; questions pause 09:13–09:31.
- **Dates:** "As known" (default) uses only evidence available by the cutoff and excludes unknown availability.
  "Retrospective" may use later outcomes, shown only in a separate section. Similar setups are picked from morning
  data only; a test changes the outcomes and checks the picks don't change.
- **Providers** (`server/ai/providers/`): an OpenAI adapter with its own key and model (`AI_API_KEY`, `AI_MODEL`,
  default `gpt-6.1-sol`; `AI_EMBEDDING_MODEL`, default `text-embedding-3-small`; names checked on OpenAI's model and
  embeddings pages today). It uses the Responses API with strict JSON schema, `store: false` and no SDK retries.
  The offline **mock** (`AI_PROVIDER=mock`) is free.
  - A per-day usage ledger and budget live in `.data/ai/usage-*.json`; a cost is estimated only if `AI_PRICE_*` is set.
  - Limits: timeout, concurrency, cancellation on disconnect, and an answer cache for as-known questions.
  - TV research code and settings are untouched.
- **UI** (`src/AiAnalystPage.jsx`):
  - choices: snapshot (Analyzer view or a recorded morning), mode, IST cutoff, up to 5 stocks;
  - 11 suggested questions; Cancel, Clear answers, New conversation; a "Read-only research" label;
  - answers as plain text (no HTML) with tap-to-open [E#]/[D#] citations and source cards (excerpt, exchange,
    fetched, available and indexed times);
  - coverage and stale notes, and an index/usage panel with "Update index (free)" and "Embed N passages (about T tokens)".
  - Android: `api.ai = null`, so the tab says it's unavailable and no key is in the APK.

**Files:**
- New: `server/ai/` (config, errors, usage, data, tools, evidence, analyst, snapshots, service, routes, indexWorker,
  eval, evalCli, `providers/` openai, mock and index, `rag/` text, embeddings, indexStore, indexer, retrieve, sources,
  glossary, summaries); `src/utils/aiContext.js`, `src/AiAnalystPage.jsx`, `docs/ai-analyst.md`.
- New tests and fixtures: `server/aiAnalyst.test.js`, `server/aiEval.test.js`, `server/aiService.test.js` (all in
  `npm test`), `server/fixtures/aiFixture.js`, `server/fixtures/ai-eval.json` (22 questions).
- Changed: `server/index.js`, `src/core/recorder.js` (adds `dayInputs`/`days`, read only), `src/App.jsx`,
  `src/platform/web.js`, `src/platform/android.js`, `src/styles.css`, `package.json` (tests, `ai:eval`),
  `.env.example`, `README.md`, `android/README.md`, `.claude/launch.json` (a mock-mode backend config), `CLAUDE.md`.

**Tests / checks:**
- `npm test`: 280 pass (28 new). `npm run build` and `npx cap sync android` succeed.
- Covered:
  - exact symbol/date retrieval; numeric screens and comparisons equal to `analyze()`;
  - hybrid retrieval and de-duplication; incremental indexing; a change of embedding model;
  - missing and stale evidence; the as-known cutoff; outcomes kept out of the setup selection;
  - snapshot, profile and context mismatches; invalid arguments and path traversal (also over HTTP);
  - prompt injection in a document plus a `placeOrder` call; fabricated citations and numbers;
  - OpenAI request shape and error mapping (timeout, 429 rate vs quota, 401) with a fake client;
  - missing key; cancellation; daily budget; concurrency; the quiet window;
  - the worker thread building the index from an allowlist (a planted `.env` and an unapproved note are not indexed).
- Evaluation (mock): retrieval, supported numbers, citations, abstention, required facts and read-only are all 100%
  over 22 cases. It caught a bug in the mock's "between 1 and 3" parsing.
- Real data, offline: 17 documents and 189 passages indexed in 34 ms.
- Browser, backend on :3002 with `AI_PROVIDER=mock`, today's live snapshot:
  - "Ask AI" on an Analyzer row opens the tab with that stock;
  - answers show supporting evidence, missing data and sources; a citation opens its card;
  - at 375 px there is no sideways scroll;
  - the stale-context refusal was seen and then fixed, as described above.

**Not verified:**
- **No call to a real provider was made** (no `AI_API_KEY` on this PC). The OpenAI adapter is tested only with a
  fake client. Not yet confirmed live:
  - that `gpt-6.1-sol` accepts the strict JSON schema together with function tools;
  - that passing back only `function_call` items, without reasoning items, under `store: false` works for this
    model.

  Run `npm run ai:eval -- --yes` once a key is set (about 60 paid calls).
  - First attempt, 26 Oct 16:10 IST, with the owner's key: OpenAI answered the first embedding call with **HTTP 429,
    no quota left** (account billing), so no question ran and no metrics exist yet.
  - The key itself was accepted: no 401 came back.
  - `evalCli.js` now stops with a one-line message instead of a stack trace and a libuv assertion on Windows.
- Answer quality with a real model. The mock only proves the pipeline. Citation and number checks catch
  fabrication, not every unsupported interpretation.
- Side effects of running this folder's backend on :3002 today from 15:20 IST (a trading day; no scheduled order
  was pending, and no Kite session was shared):
  - it ran its normal start-up jobs: today's pre-open was recorded to `.data/recorded/2026-10-26.json`;
  - the 09:30 auto-export, which saves once after a late start, wrote `Downloads/Stocks_2026-10-26_1525.xlsx`
    (the 09:30 file from this morning's other backend is untouched);
  - a late 9:20 confirmation reading was saved (`recorded/confirm-2026-10-26.json`, 15:24) when the Confirm page was
    opened in the shared browser pane.

  The backend was stopped afterwards.

**Next:** set `AI_PROVIDER=openai` and `AI_API_KEY` in `.env`, restart, click "Embed N passages" once, and run the
evaluation against the real model. Approved research notes go in `.data/ai/notes/*.md` with `approved: true` and
`availableAt:` in the front matter.

### 2026-10-24: Timed orders leave at network time, not the PC clock (Claude Code for vinayakb374, android-app, local commit)
**Report:** SAGILITY BUY 4032 limit ₹46.40 at 09:15:00 on 23 Oct showed in Kite as placed at 09:14:59.

**What the data shows:**
- The app's record says the request left at exactly 09:15:00.000 on the PC clock, 0 ms late. That was
  checked: the worker sends within about 1 ms of the target.
- So the PC clock was ahead of network time at that moment. On 24 Oct, measured with four NTP exchanges to
  `time.windows.com`, it was **30–39 ms ahead** and changing from one check to the next. Nothing corrected it: the
  Windows Time service (`w32time`) is **stopped** and set to manual, and the clock was last synced in the
  21 Oct check (0.16 s off, sign not verified).
- A send 30 ms early in real time can reach Kite before 09:15:00.000 and be recorded as 09:14:59 (Kite's times are
  whole seconds). I could not measure the offset on 23 Oct, so the exact size then is unknown.

**What changed:**
- `server/networkClock.js`: asks `time.windows.com` and `time.google.com` for the time over NTP (UDP 123), 4 samples
  each, keeps the fastest. Syncs at start and every 10 minutes (timer unref'd). Rejects replies more than 60 s off.
  If no server answers, the last good offset is kept and the status says so.
- `src/core/orderScheduler.js`:
  - All triggers, checks and timestamps use network time (`netNow`): the PC clock plus the measured offset.
  - The sender still works on the PC clock; the scheduler converts the target to the PC clock when it hands the order
    over, and converts the send times back.
  - Each placed order records `clockOffsetMs` (the offset at the send).
  - A failed Kite check no longer replaces the last good Kite record. It is kept, with `checkError` and
    `checkErrorAt` added. This matters here: the SAGILITY record now shows an error, because a later check overwrote
    the earlier timeline.
- `server/index.js`, `server/orderRoutes.js`: the clock is started and its status is returned with the orders.
- `src/OrdersPage.jsx`: a note under the form: "This PC's clock is N ms ahead/behind network time; orders are timed
  later/earlier by that much". Red above 250 ms. A warning if network time is unavailable. A failed Kite check
  shows the earlier record and says the check failed.

**Files:** `server/networkClock.js`, `server/networkClock.test.js` (new, added to `npm test`);
`src/core/orderScheduler.js`, `server/index.js`, `server/orderRoutes.js`, `src/OrdersPage.jsx`;
`server/orderSender.test.js`, `server/orderRoutes.test.js` (the route now returns `clock`).

**Tests / checks:**
- `npm test`: 252 pass. `npm run build` and `npx cap sync android` succeed.
- New: a PC clock 30 ms ahead sends at network 09:15:00.000 (PC 09:15:00.030), recorded as 0 ms late. A PC clock
  2 s behind is corrected too. The first test was run against the previous scheduler and fails with
  `actual 1792381499970, expected 1792381500000` (30 ms early), so it catches the reported bug.
- The NTP client was run once against the live servers from this PC: `time.windows.com`, offset −39 ms,
  round trip 17 ms.
- The restarted backend on :3002 reports network time (−31 ms). The Orders page shows the note.
- The backend was restarted at 10:00 IST on Saturday (no order pending). Restarting clears the in-memory Kite
  token; the page re-shares it on reconnect.

**Not verified:**
- A real timed order after this change (the next trading day). The fake-clock tests cover the logic, not a live send.
- Whether UDP 123 is open on the owner's network. If it isn't, the note says so and orders use the last offset.
  No offset has been measured yet on 23 Oct, so the size of the early send that day is still unknown.
- Kite's own record of the SAGILITY order (09:14:59 or not) was not readable: Kite keeps the day's orders only, and
  the stored record is now an error.

**Next:**
- The owner should start the Windows Time service so the PC clock itself stays close (as administrator:
  `Set-Service w32time -StartupType Automatic` then `Start-Service w32time`, or Settings → Time & language → Date &
  time → Sync now). The app now corrects the clock either way.
- Check SAGILITY's time in Kite's Orders page (Time column) and compare it with the note on the Orders page.
- Not touched: a folder `outputs/` (22 Oct analysis files) that is not part of this work and is still uncommitted.

### 2026-10-21: Auction layer: gap built and orders held measured over order entry only (Claude Code for vinayakb374, android-app, local commit)
**Why:** the imbalance had already been moved to the close-of-entry reading, but the drift used the last
reading and orders-held used the last buy share against an average that included readings after the matching
(raised in `docs/analyzer-review-2026-10-21.md`, section D). The matching changes pending orders, so this could
read "pulled late" for orders that never changed during entry.

**What changed:**
- `auctionFeatures`:
  - New close-of-entry fields: `gapAtClose`, `buyShareAtClose`, `avgBuyShareToClose` (average of readings up to
    the close only, needs 3), `entryReadings`.
  - The early (09:04) gap now needs 2 minutes before the close, not before the last reading.
  - The final values (`gap`, `buyShare`, `avgBuyShare`, `iep`) are unchanged and still used by room to the circuit
    and futures vs cash (the final equilibrium).
- `auctionEntry(a)` returns the entry readings. Features made before these fields existed fall back to the final
  values, but a null entry value stays null.
- `aDrift` and `aOrdersHeld` (the Auction score and its conviction factors) and the Stock filter's *Gap built* and
  *Orders held* use them. Their hover text names the close of order entry.
- `docs/analyzer-review-repro.mjs`: one line made null-safe (its counter-example now correctly has no orders-held
  reading). Section D of the review document is marked fixed.

**Effect on the real 21 Oct file** (close of entry 09:08:49, 740 stocks):
- orders held changed by more than 1 point for 340 stocks and flipped sign for 8 (e.g. GAIL −3.0 → +3.9 pts,
  AUBANK −3.2 → +3.5);
- the gap moved after the matching by more than 0.05 point for 39 stocks.

**Files:** `src/utils/auctionLayer.js`, `src/utils/screener.js`, `server/auctionLayer.test.js`,
`server/screener.test.js`, `docs/analyzer-review-repro.mjs`, `docs/analyzer-review-2026-10-21.md`.

**Tests / checks:** `npm test`: 239 pass (2 new tests, including the review's counter-example and the
too-few-readings case). `npm run build` and `npx cap sync android` succeed. The repro script runs.

**Not verified:**
- The running app shows this only once the backend has an auction recording to compute from. This folder's
  `.data` has none for 21 Oct; the old backend recorded it in `C:\Users\DELL\advdec_nse\.data`.
- Still open from the review: per-batch receipt times, and a confidence label for the inferred close.

### 2026-10-21: Commit the remaining uncommitted files in the shared folder, at the owner's request (Claude Code for vinayakb374, android-app)
**What changed:** all files that had been left uncommitted were committed as they were, without edits:
- `vite.config.js`: the dev proxy's backend port can be set with `BACKEND_PORT` (default still 3001), for when
  another app uses 3001.
- `.claude/launch.json`: local dev-server configurations (3001/5173 plus 3002 and 5174 variants); CLAUDE.md
  already refers to it.
- **Milestone 3 part 2, paused work by Vishwanath793 (DELL), committed exactly as left:**
  - `src/core/backtestData.js` (the backtest planner and candle cache). It loads, and nothing imports it yet.
  - `server/backtestData.test.js` **ends mid-test (`test('candles: one request per…`) and does not parse.** It is
    intentionally **not** in the `npm test` script, so `npm test` and CI don't load it.
  - Whoever resumes milestone 3 should finish that last test and add the file to the script. The *Work in
    progress* line for it stays.
- `docs/analyzer-review-2026-10-21.md`, `docs/analyzer-review-checks-2026-10-21.json`,
  `docs/analyzer-review-repro.mjs`: a source-level Analyzer review written by another session, and its
  counter-example script (made-up inputs plus local file metadata; it reads `.data/`, makes no network calls).
  Several of its findings overlap the review in this log (coverage of sparse scores, the order buttons, the
  upload date, the backend's single 09:10 attempt, and storage of the secret and token). It also reports that
  Auction drift and orders-held still use readings after the matching, which is still open.

**Checks:** files read in full before committing; no keys or tokens in any of them. `npm test` (237) and
`npm run build` pass with them included.

### 2026-10-21: Analyzer: "Gap vs size" column, the gap normalised for free-float market cap (Claude Code for vinayakb374, android-app, local commit)
**Why:** smaller companies gap more. On 21 Oct, across 2,272 NSE stocks, the median 20-session average absolute
gap was:

| Free-float cap | Median gap |
|---|---|
| < ₹1,000 Cr | 0.96% |
| ₹1,000–5,000 Cr | 0.46% |
| ₹5,000–20,000 Cr | 0.38% |
| ₹20,000 Cr–1 L Cr | 0.43% |
| > ₹1 L Cr | 0.37% |

It bends and then flattens. A single power law (log-log slope −0.20, R² 0.45) would misfit that, so the method
uses size peers instead of a fitted curve.

**What changed:**
- `src/utils/sizeGap.js`:
  - **Typical gap for this size** = the median 20-session average |gap| (NSE end-of-day files) of the
    **100 stocks nearest in free-float cap**, compared on a log scale.
  - The peer pool is every stock in the pre-open feed (all of NSE) with 5 or more sessions of history.
  - **Gap vs size** = |today's gap| ÷ typical gap.
  - Without enough history it uses today's pre-open gaps of the size peers, and labels the source.
- Stocks table: a **Gap vs size** column after %Chg (e.g. "5.4×"). It is sortable, coloured by gap direction,
  bold at 1.5× or more, dotted at 3× or more, and the hover shows the typical gap, the peer cap range and the
  source.
- Excel export: "Gap vs size (×)" and "Typical gap for size (%)".
- Display only: not in any score.

**Files:** new `src/utils/sizeGap.js`, `server/sizeGap.test.js` (added to `npm test`); `src/utils/analysis.js`,
`src/App.jsx`, `src/utils/exportStocks.js`, `src/styles.css`.

**Tests / checks:**
- `npm test`: 237 pass. `npm run build` and `npx cap sync android` succeed.
- Browser (21 Oct): all 750 rows filled.
  - INFY (₹4.07 L Cr) +2.14% = **5.4×** (typical 0.40%).
  - ICICIBANK +1.81% = 4.5×.
  - UTLSOLAR (₹1,441 Cr) −2.33% = 5.0× (typical 0.47% for ₹1,292–1,614 Cr).

**Not verified:** whether a high "gap vs size" predicts continuation or fade. Let the report card judge it before
it goes into a score (it could become a conviction factor or a Stock filter box).

### 2026-10-21: Analyzer: market cap column filled from the NSE pre-open feed (free-float) (Claude Code for vinayakb374, android-app, local commit)
**What changed:**
- The stocks table's empty "Mkt Cap" column is now **"Free-float M.Cap"**. Its value is `FFM CAP (₹ Crores)` from
  the NSE pre-open feed (`ffmMarketCap`), which every pre-open row already had. Before, the app read market cap
  only from the master list, and the bundled list has none.
- **Top 5 Gainers & Losers** now filters on the free-float cap ("Free-float market cap ≥ ₹ … Cr"), so the section
  works with the bundled master list. On 21 Oct, 461 stocks met the ₹5,000 Cr default.
- Excel export: a new "Free-float market cap (₹ Cr)" column. "Market cap (₹ Cr)" from an uploaded master list
  is kept.
- `analyze()` now also returns `hasFreeFloatCap`.

**Files:** `src/App.jsx`, `src/utils/analysis.js`, `src/utils/exportStocks.js`, `src/store.js` (comment),
`server/export.test.js`, `server/preopen.test.js`.

**Tests / checks:**
- `npm test`: 233 pass. `npm run build` and `npx cap sync android` succeed.
- Browser (21 Oct snapshot): all 750 rows have a value (e.g. HDFCBANK ₹10.85 L Cr), and top movers list again.

**Not verified / notes:**
- Free-float cap is smaller than full market cap for promoter-held companies, so the same ₹ floor now keeps fewer
  of them than a full-cap filter would.
- An uploaded pm.csv without an FFM CAP column shows "—" and a note in top movers.

### 2026-10-21: Stock filter: gap size can be capped ("less than"), alone or as a range (Claude Code for vinayakb374, android-app, local commit)
**What changed:**
- The Gap size row has two boxes, **from** and **to** (%, either side), both optional: "to 3" keeps gaps of 3%
  or less up or down, and "0.5 to 3" keeps gaps from 0.5% to 3%.
- New setting `maxGap` (the minimum is still `thresholds.minGap`).
- One chip shows the range, e.g. "Gap size 0.5–3 %".
- A warning appears when "from" is above "to".
- Clear all removes both.

**Files:** `src/utils/screener.js`, `src/StockScreener.jsx`, `src/styles.css`, `server/screener.test.js`.

**Tests / checks:**
- `npm test`: 233 pass. `npm run build` and `npx cap sync android` succeed.
- Browser (this folder's backend :3002, frontend :5174): with Relative volume ≥ 10, "to 2" took 30 matches to 19
  (largest gap shown 1.97%); from 3 to 2 shows the warning and 0 matches.

**Not verified:** nothing beyond the in-app browser.

### 2026-10-21: Stock filter: clearer layout (Claude Code for vinayakb374, android-app, local commit)
**What changed:** layout only; the filter logic and saved settings are unchanged.
- The filters are in four cards:
  - **Pre-open** (NSE 09:08)
  - **Yesterday** (NSE end-of-day)
  - **Auction** (Kite 09:00–09:08)
  - **Result** (direction, top N by quality, tradeable only)
- Each filter is one aligned row: a short label (the full explanation on hover, ⓘ), "≥", the number box with its
  unit after it, and a ★ toggle for "counts in the quality rank".
- A row with a value is highlighted.
- The order side (Gap side / Buy / Sell) and the direction (Both / Gap-ups / Gap-downs) are button groups instead
  of white native drop-downs.
- The count is in the header ("N of M gapped stocks match").
- Each active filter is a chip with × to remove it, plus Clear all (it keeps the ★ choices and the order side).
- The long explanation is folded into "How the filter and the quality rank work".
- At phone width the cards stack, with no sideways scroll.
- `SCREENER_METRICS` gained `group`, `short` and `help`; `SCREENER_GROUPS` was added; `filterLabel` was removed.

**Files:** `src/StockScreener.jsx`, `src/utils/screener.js`, `src/styles.css`.

**Tests / checks:**
- `npm test`: 232 pass. `npm run build` and `npx cap sync android` succeed.
- Browser on :5174 against this folder's backend on :3002: desktop and 375 px; filters, chips and their × work;
  labels no longer cut off.

**Not verified:** nothing functional changed; the layout was checked only in the in-app browser.

**Note:** the other chat's servers (:5173 and :3002, from `C:\Users\DELL\advdec_nse`) had stopped. This chat
started this folder's backend on :3002 (`npm run server` with PORT=3002) and its frontend on :5174, at 17:21
after market hours.

### 2026-10-21: Scheduled orders: exact-second send from a worker thread, and Kite's own timeline per order (Claude Code for vinayakb374, android-app, local commit)
**Why:** the owner's SELL 1000 JUSTDIAL at 09:15:00 left the app 523 ms late (Kite answered in 140 ms) and showed
as executed at 09:15:02 in Kite. A 10:15:00 order on 19 Oct left 4 ms late. So at the open the backend's event loop
is busy: the opening collector's tick flood, synchronous tick-log writes, and the order's own "placing" save were
all ahead of it. The rest of the 2 s is Zerodha/NSE at the open. Separately, Windows time sync is off ("Local CMOS
Clock"); it was 0.16 s off today, and the owner was told how to sync it.

**What changed:**
- **Armed 2 s early** (`PREARM_MS`). The scheduler checks the Kite session and saves "placing" at T−2 s (a crash
  from then on never resends; on restart such an order fails with "check the Kite order book"), then hands the
  order to a sender.
- **Sender** (`createOrderSender` in `core/orderScheduler.js`): waits for the exact time, keeps the 120 ms spacing,
  retries a 429 once and never resends an unknown outcome (unchanged rules). It warms the connection to Kite
  before the time (`GET /user/profile`). Results are plain objects.
- **Backend:** the sender runs in a **worker thread** (`server/orderSender.js` + `server/orderSenderWorker.js`)
  with its own event loop. It sleeps until 15 ms before the time, then checks the clock continuously. If the worker
  dies mid-send, its orders fail with "may or may not have reached Kite, check the order book" and are never
  resent; the next order starts a new worker. **The phone** sends inline, as before.
- **Kite timeline:** 5 s, 30 s and 2 min after placing (until final), the app reads `GET /orders/:id` (history)
  and `GET /orders/:id/trades`. It keeps when Kite received the order, when the exchange registered it, each
  fill, the average price and the status (`kiteTimeline`). On the Orders page this shows under each placed order,
  with a **Read from Kite** button (route `POST /api/orders/scheduled/:id/kite`; Kite keeps the day's orders only).
  The Kite client gained `orderHistory`, `orderTrades` and `profile`.

**Files:**
- New: `server/orderSender.js`, `server/orderSenderWorker.js`, `server/fixtures/fakeOrderWorker.js`,
  `server/orderSender.test.js` (added to `npm test`).
- Changed: `src/core/orderScheduler.js`, `src/core/kite.js`, `server/index.js`, `server/orderRoutes.js`,
  `src/platform/web.js`, `src/platform/android.js`, `src/OrdersPage.jsx`, `src/styles.css`.

**Tests / checks:**
- `npm test`: 232 pass. All 17 existing scheduler tests pass unchanged. New tests cover:
  - arming at T−2 s, and a crash after arming never resending;
  - the warm-up, spacing and unknown-outcome rules;
  - spin timing on real time (≤ 3 ms late);
  - the worker thread: results, sending on time **with the main thread blocked for 600 ms across the time
    (≤ 5 ms late)**, a dying worker, close with an order in flight;
  - the real worker file loading without contacting Kite;
  - the timeline and checks, and the Kite endpoints.
- `npm run build` succeeds.
- Browser: the Orders page renders the new details and button with no errors. The timeline layout was checked
  with **sample data injected in the page**, not a real Kite reply.

**Not verified:**
- **Nothing ran against Kite:** the worker sending a real order, the warm-up call, and `GET /orders/:id`
  (`/trades`) responses with real data. The field names (`order_timestamp`, `exchange_timestamp`,
  `exchange_update_timestamp`, `fill_timestamp`) are from the Kite Connect docs.
- The running backend on :3002 is the old copy in `C:\Users\DELL\advdec_nse`: none of this is live until a backend
  runs from this folder.
- Whether the warm-up connection is still open at T. Node's default keep-alive is about 4 s; the warm-up is 2 s
  before.

**Next:** run the backend from this folder; after the next scheduled order, compare "sent … ms after the time"
with Kite's timeline.

### 2026-10-21: Stock filter: buy/sell side choice, three more auction filters; fix the auction imbalance read after matching (Claude Code for vinayakb374, android-app, local commit)
**What changed:**
- **Stock filter:**
  - Relative volume is labelled "Vol ×" (type 28 for Vol 28×).
  - The buy/sell orders minimum can read the **gap side** (default), the **buy side** or the **sell side**. The
    rank always uses the gap side.
  - New typed filters (and columns, all included in the rank):
    - **Gap-side orders held** (points vs the auction average)
    - **Unmatched auction demand** (× matched volume, positive on the gap side)
    - **Futures auction vs cash** (points, F&O only)
- **Bug fix in the Auction layer (`auctionLayer.js`):**
  - After the matching, Kite reports the imbalance as **0 for every stock**. On 21 Oct, 774 stocks were non-zero
    at 09:08:33, 612 at 09:08:49, 46 at 09:09:06 and none at 09:09:22.
  - The layer read the last reading, so "Unmatched auction demand" was always 0, in both the filter and the
    Auction score.
  - It now reads the **close-of-entry sweep**: the last sweep in which at least half of the day's peak number of
    stocks still reported an imbalance (`closeOfEntryAt`, `auctionImbalance`). The volume and order totals it is
    compared with come from the same sweep.
  - On the 21 Oct file: close of entry 09:08:49, and 562 of 740 stocks have an unmatched quantity (before: 0).
  - The other auction factors are unchanged.

**Files:** `src/utils/screener.js`, `src/StockScreener.jsx`, `src/utils/auctionLayer.js`,
`server/screener.test.js`, `server/auctionLayer.test.js`.

**Tests / checks:**
- `npm test`: 223 pass. `npm run build` succeeds.
- Browser (this folder's frontend on :5174 against the backend on :3002, real 21 Oct data): Vol ≥ 28 → 11
  stocks; orders ≥ 60% gap side → 203, buy side → 33; futures ≥ 0.1 pts → 26; orders held ≥ 5 → 53.

**Not verified:**
- The imbalance fix **in the running app**. The auction features are computed by the backend (the context API),
  and the backend on :3002 runs the old code from `C:\Users\DELL\advdec_nse`, so Unmatched still shows 0 there
  until a backend runs this folder's code.
- Whether 50% of the peak is the right cut-off on other days. Only 21 Oct has been looked at.

**Next:** run the backend from `C:\Users\Public\advdec_nse` (port 3001) and check the Unmatched column.

### 2026-10-21: Analyzer: Stock filter with a quality rank replaces "Sector Bias" (Claude Code for vinayakb374, android-app, local commit)
**What changed:**
- The **Sector Bias (breadth > 65%)** section is removed, along with its `bias` calculation in `App.jsx`. The
  `bias-*` CSS stays because Top movers still uses it.
- The new **Stock filter** section lists every gapped stock with these readings:
  - Gap size (absolute, either side)
  - Relative volume (`rvolX`)
  - Gap-side buy/sell orders (%)
  - Pre-open value percentile ("higher than x% of stocks")
  - Delivery % (yesterday)
  - Delivery quantity surge (`delivQtyX`)
  - Gap built during the auction: the indicative gap's change from 09:04 to the end of order entry, in the gap
    direction, from the Kite pre-open readings
- **Every threshold is typed in by hand.** A blank box is not applied. A stock without the reading fails that
  box. There are also Direction (both / up / down) and Tradeable only.
- **Quality rank:** the average percentile, among all gapped stocks, of the readings ticked "in rank" (needs 3 or
  more). Rank 1 is the best. The rank is computed before the thresholds, so it stays the same as filters change.
  "Quality rank ≤ N" filters on it.
- Filters are saved per browser (`settings.screener`).
- Results show tradeability flags, the quality coverage (e.g. "3/6"), conviction, and the same BUY/SELL buttons
  the old section had (they place the order straight away, as before).
- Pure logic is in `src/utils/screener.js`; the UI is `src/StockScreener.jsx`.

**Files:**
- New: `src/utils/screener.js`, `src/StockScreener.jsx`, `server/screener.test.js` (added to `npm test`).
- Changed: `src/App.jsx`, `src/styles.css`, `package.json`.

**Tests / checks:**
- `npm test`: 220 pass. `npm run build` and `npx cap sync android` succeed.
- Browser, with this folder's frontend on :5174 against the backend already running on :3002, using the real
  21 Oct pre-open and auction readings: 632 gapped stocks, all 632 ranked. Typing thresholds narrowed the list
  632 → 81 → 22 → 14 → 6 → 4, and the values were saved.

**Not verified / notes:**
- The quality rank is a hypothesis, not a measured edge. Circuit-locked or T2T stocks can rank high (e.g. E2E on
  21 Oct), so use "Tradeable only" or check the flags.
- The backend on :3002 gave history `asOf` 2026-10-19 for 21 Oct, so 20 Oct's end-of-day file wasn't cached
  there. That is not caused by this change.
- Sync note: before this work the shared folder was fast-forwarded to origin/android-app plus the unpushed
  commit `b18cac6` from `C:\Users\DELL\advdec_nse`. Nothing was pushed.

**Next:** have the report card measure whether the top-ranked stocks beat the rest.

### 2026-10-20: Conviction factors reach the backend only when changed (Claude Code for vinayakb374, android-app, local commit)
**What changed:**
- Before this fix, every browser that opened the Analyzer sent its own saved conviction factors to the backend
  (`PUT /api/export/settings`), and the last page load won. The backend's copy (`.data/export-settings.json`) is
  what the 09:20 decision and the 09:30 Excel export use. In testing, an in-app preview pane, and the older
  `dist/` build that `npm run server` serves on :3002, overwrote the owner's Auction-layer choice.
- Now a browser sends the factors only when they are **changed there**, not when the page loads.
- A change the backend didn't accept is retried every 15 s, and at once when the page's live-update connection
  reconnects. Until then a red note next to the export status says it isn't saved yet.

**Files:** `src/App.jsx`.

**Tests / checks:**
- `npm test`: 216 pass. `npm run build` and `npx cap sync android` succeed.
- Browser, with the settings request intercepted so the backend file was never written:
  - a page load sends nothing;
  - a change sends once;
  - a failed send shows the note and retries after 15 s;
  - once a retry succeeds, the note clears and retries stop.

**Not verified / known:**
- Through the Vite dev server (5173) the live-update connection doesn't notice a backend restart: the proxy keeps
  the browser side open. So "send again on reconnect", and the existing Kite session re-share, don't fire there.
  The 15 s retry covers the factors. The built app on :3002 connects directly.
- A browser that never changes a factor never sends any, so the backend keeps whatever was last sent.

**Next:** the owner should set the Auction-layer factors once in their own browser so the backend has them.

### 2026-10-20: Auction layer: the pre-open auction as it forms, from Kite /quote (Claude Code for vinayakb374, android-app, local commit)
**What changed:** the NSE 09:10 import only has the auction's final result. Since 7 Sep 2026, Kite's `/quote` updates
during the pre-open, as Zerodha announced on the Kite Connect forum on 5 Sep 2026; the main quote docs don't list
this yet. The fields are `ohlc.open` (the indicative equilibrium price), `volume`, `buy_quantity`, `sell_quantity`
and `total_imbalance_qty`. Two pieces now use them:
- **A recorder** (`core/auctionTracker.js`, backend only, read-only):
  - On trading days, from 09:00:05 to 09:09:45, it reads `/quote` every 15 s for the master-list stocks, their
    near-month futures and the NIFTY / BANKNIFTY futures. That is about 970 instruments, so two requests a sweep,
    within Kite's limit of one a second.
  - Each sweep is saved to `.data/auction/YYYY-MM-DD.json`. After a restart it continues the same file.
  - Without a session it shows "needs-kite" and keeps trying until 09:09:45. On a 403 the error is shown with the
    token redacted.
  - It shares the instruments service with the opening collector. It is woken at 08:58, on start-up, and when a
    Kite session is handed over.
- **A layer on top of the conviction** (`utils/auctionLayer.js`), built the same way as the History layer.
  **Default scores are unchanged** (a test checks this). The six factors are all **off by default**; every
  threshold is a hypothesis:
  - **Gap built during the auction:** the indicative gap at 09:04 vs the end of order entry.
  - **Gap-side orders held:** the final buy/sell share vs its average through the auction (orders pulled late
    count against the gap).
  - **Unmatched auction demand:** the imbalance ÷ matched volume. The side comes from the buy/sell totals unless
    the imbalance is negative.
  - **Futures auction vs cash:** the near-month future's gap minus the stock's gap.
  - **Room to the circuit:** distance to Kite's circuit limit.
  - **Nifty futures pre-open** (market-wide).
  - It also gives a separate **Auction score** (the stock's own five factors, equal weights, 2 or more needed).
- **Where it shows:**
  - Analyzer: an Auction column and an "Auction score" checkbox.
  - "Conviction factors" → *Auction layer*, with Add all / Remove all.
  - A status line under the market panel.
  - Report card: per-factor verdicts, plus "Top 5 by Auction score".
  - Excel: Auction score and Auction factors.
- The context now carries `auction` and `auctionStatus` (`withPreopenBaseline` in `server/index.js`). The report
  card reads `auction/DATE.json` for past days.

**Files:**
- New: `src/core/auctionTracker.js`, `src/utils/auctionLayer.js`, `src/AuctionLayer.jsx`,
  `server/auctionLayer.test.js` (added to `npm test`).
- Changed: `utils/conviction.js`, `utils/analysis.js`, `core/recorder.js`, `utils/reportCard.js`,
  `utils/exportStocks.js`, `App.jsx` (the layer toggle is now shared: `toggleGroupFactors`), `ReportCardPage.jsx`,
  `styles.css`, `server/index.js`, `server/conviction.test.js` (factor lists).

**Tests / checks:**
- `npm test`: 193 pass. `npm run build` and `npx cap sync android` succeed.
- Browser (the frontend already running on 5173, against the real 19 Oct snapshot): the Auction column,
  checkbox and factor group render, with no console errors.

**Not verified:**
- **Nothing has run against Kite in a real pre-open.** Still to check: that `ohlc.open` is 0 or absent before an
  equilibrium exists, the sign of `total_imbalance_qty`, whether stock futures have a usable pre-open price, and
  when order entry really closes. The forum thread disputes it: "09:08" vs "after 09:09".
- The running backend (port 3002, another session) was **not restarted**, so it doesn't record yet. Restart it
  before 09:00, and log in to Kite before 09:00.
- The Android app has no recorder, so it has no auction data and these factors are left out there.

**Next:**
- After the first live morning, open `.data/auction/DATE.json` and check those fields.
- After about 10 recorded days, read each factor's verdict and "Top 5 by Auction score" before turning any factor on.

### 2026-10-20: History layer: inference from the 20-session end-of-day history (Claude Code for vinayakb374, android-app, local commit)
**What changed:** an optional layer **on top of** the conviction score, built only from `context.history.stats`.
**Default scores are unchanged** (a test checks this).
- **Five factors** (`src/utils/historyLayer.js`). Each is direction-aware and scaled to the stock's own history
  instead of fixed % thresholds:
  - **Gap vs its usual gap:** gap ÷ `avgAbsGap`. 1.5–3× its usual scores full marks; under 0.75× is neutral;
    6× or more tapers, because extreme gaps tend to fade.
  - **Delivery quantity surge:** `prevDelivQty ÷ avgDelivQty`, in the direction of yesterday's move
    (`close1 → prevClose`). Full marks at 3×.
  - **Yesterday's volume vs usual:** yesterday's quantity = delivered shares ÷ delivery %, divided by
    `avgVolume`, in the direction of yesterday's move. Full marks at 2×.
  - **Unusual OI build-up:** the build-up type scaled by `foOiRank` (full marks at the 90th percentile) instead
    of the old fixed 10%.
  - **20-session strength vs sector:** `close20 → prevClose` return minus the sector median. Full marks at ±10
    points.
- **Separate:** every scored gap gets its own **History** score (0–100, equal weights, needs 2 or more factors
  with data). It appears in a new column next to Conviction, with the breakdown on hover. A "History score"
  checkbox hides it.
- **Include:** the five factors are also conviction factors, **off by default**. Turn them on one by one in
  "Conviction factors" → *History layer*, or with **Add all to the conviction / Remove all from the conviction**.
- **Report card:** each factor gets its own verdict automatically, and there is a new row "Top 5 by History
  score" next to "Top 5 by conviction".
- **Excel export:** History score and History factors columns.

**Files:**
- New: `src/utils/historyLayer.js`, `src/HistoryLayer.jsx`, `server/historyLayer.test.js` (added to `npm test`).
- Changed: `utils/conviction.js` (adds the factors, off), `utils/analysis.js`, `utils/reportCard.js`,
  `utils/exportStocks.js`, `App.jsx` (History column; the factor panel split into a shared `renderFactorRow`),
  `ReportCardPage.jsx`, `styles.css`, `server/conviction.test.js` (factor lists).

**Tests / checks:**
- `npm test`: 182 pass. `npm run build` succeeds.
- Browser, against the real 19 Oct snapshot: 230 of 750 stocks get a History score. Add all → the conviction
  scores change; Remove all → they return exactly to the originals.

**Not verified:**
- Whether any of these factors predict outcomes. All the thresholds are hypotheses, so let the report card judge
  them before adding them to the conviction.
- The 09:20 decision uses the conviction with the export settings, so it is unaffected unless the factors are
  turned on there.

**Next:** after about 10 recorded days, compare "Top 5 by History score" with "Top 5 by conviction" and read
each factor's verdict.

### 2026-10-20: "How unusual vs the last 20 sessions" research columns (Claude Code for vinayakb374, android-app, local commit)
**What changed:** every comparison uses the 20 completed sessions **before** the observation (never the
observation itself) and shows its coverage ("17/20"). With fewer than 5 sessions of data a cell shows "—" and the
coverage instead of a ratio. **Display only: no score changes** (a test checks the conviction score is unchanged).
- Analyzer: a **Research columns (vs 20 sessions)** checkbox (saved in settings) adds these columns:
  - Pre-open RVOL and pre-open value ×: from the app's own recorded pre-open days, because NSE has no pre-open
    archive. These fill in as days are recorded.
  - Gap ×: absolute gap ÷ the average absolute open-vs-previous-close gap.
  - Delivery quantity ×: delivered shares = quantity × DELIV_PER ÷ 100.
  - RS vs sector: 20-session return minus the sector's median, over today's pre-open stocks.
  - RS vs Nifty.
  - OI change rank: percentile of the absolute OI change %, with OI summed over expiries so roll-overs cancel out.
  - The sector table gets **Adv % vs usual** (percentage points).
- **Market panel** "Compared with the last 20 sessions":
  - India VIX ÷ its 20-session average, plus its percentile.
  - Nifty's 20-session return.
  - FII and DII separately: net amount, 20-day z-score, 5- and 20-day sums, buying days, and whether they agree.
    The figures are labelled as NSE combined NSE+BSE+MSEI (`fiidiiTradeReact`; checked: `fiidiiTradeNse` gives
    different, NSE-only figures).
- 09:20 scanner:
  - The RVOL baseline is now **20 sessions** (was 10).
  - New Value ×, Range × and Gap × columns, plus a line in the detail view.
  - Kite 1-minute candles give each day's 09:15–09:20 value Σ v·(h+l+c)/3 and range % of the open.
  - The history cache has a version number, so the old 10-day entries are fetched again.
- Excel export: the research columns are added, each with its day counts.

**New data sources:**
- NSE's `ind_close_all_DDMMYYYY.csv` (checked that it exists and includes "Nifty 50" and "India VIX"), cached in
  `.data/indices/`.
- F&O files for the last 21 sessions, about 1.2 MB each and downloaded once (`foBackfill`). **The phone doesn't
  backfill**: its OI history builds up day by day.

**Files:**
- New: `src/utils/research.js`, `src/ResearchColumns.jsx`, `server/research.test.js` (added to `npm test`).
- Changed: `core/marketContext.js`, `core/kiteHistory.js`, `core/recorder.js`, `core/openingCollector.js`,
  `utils/openingWindow.js`, `utils/analysis.js`, `utils/exportStocks.js`, `utils/simulatedMorning.js`,
  `App.jsx`, `OpeningScanner.jsx`, `store.js`, `styles.css`, `platform/android.js`, `server/index.js` (context
  now carries `preopen`), `server/marketContext.test.js`.

**Tests / checks:**
- `npm test`: 177 pass. `npm run build` and `npx cap sync android` succeed.
- The new context code ran on a **copy** of `.data` against live NSE: 21 end-of-day files, 21 F&O files and 21
  index files. Nifty's 20-session return was −1.96%; India VIX was 14.77, 1.10× its average (85th percentile).
- Analyzer checked in the browser against the real 19 Oct snapshot: the columns, tooltips and coverage appear.
- Simulated morning: the 09:20 research columns are filled in and the paper results are unchanged.

**Not verified:**
- Nothing has run in market hours.
- Kite's 20-day 1-minute history request is untested live (Kite's limit is 60 days per request).
- Coverage today: pre-open history has 3 recorded days and FII/DII has 2 stored days, so those columns show
  coverage until 5 or more days exist.
- The real backend was not restarted: port 3001 was serving another app, and `vite.config.js` (uncommitted,
  pointing at 3002) was left alone.

**Next / open questions:** let the report card collect days, then check whether any of these improve outcomes
before giving them score weight.

### 2026-10-19: New default conviction factors in the Analyzer (Vishwanath793 with Claude Code, android-app)
**What changed:** at the owner's request, "Reset to defaults" now gives gap size 15, buy/sell orders 100,
pre-open value 100 and relative volume 100 (shares 5/32/32/31%). Everything else is off, keeping its weight:
sector 10, F&O OI 100, India VIX 30, the rest 20. This was the owner's choice, not re-derived from the report card;
the comments in `src/utils/conviction.js` say so.
- `FACTOR_DEFAULTS_VERSION` is now 3. Untouched version-1 or version-2 defaults migrate automatically; customised
  settings are kept.
- The help text in the Analyzer was updated.

**Tests / checks:**
- `conviction.test.js`: the new defaults, the shares, and the migration from version 2.
- Three scoring-mechanics tests now pin V1 or use a factor that is on by default.
- `marketSignals.test.js`: relative volume is now reported missing when there's no volume history.
- `npm test`: 190 pass; build and Android sync OK.
- In the app: the factor list matches the owner's screenshot, and "Reset to defaults" is disabled when the settings
  equal the defaults.

**Not verified:** whether these defaults rank better than version 2. Check the Report card as more days are
recorded.

### 2026-10-19: Fix "Cannot autoslice this instrument" for NSE share orders (Vishwanath793 with Claude Code, android-app)
**What changed:**
- A scheduled MARKET sell of URBANCO (an NSE share) was rejected by Kite: "Cannot autoslice this instrument".
  The "Auto-slice above freeze qty" setting (on by default) sent `autoslice=true` with every market order.
- `orderForm` in `src/core/kite.js` now sends `autoslice` only for derivatives exchanges (`AUTOSLICE_EXCHANGES`:
  NFO, BFO, MCX, CDS, BCD), where freeze quantities apply. This covers scheduled orders, the Analyzer's BUY/SELL
  buttons and the Android app.
- The Settings label explains that the option is F&O only.

**Tests / checks:** `server/kite.test.js` (not sent for NSE, sent for NFO) and `orderScheduler.test.js`.
`npm test`: 187 pass. `npm run build` and `npx cap sync android` OK. The backend was restarted with the fix.

**Context from the same morning:**
- The 09:15 PERSISTENT order and a 09:46 PNB order failed: there was no valid Kite login for the day.
- The owner then hit "No IPs configured for this app" (the static-IP rule) and whitelisted the PC's IP in the Kite
  developer console (Profile → IP Whitelist). The URBANCO rejection shows the IP check now passes.
- The 09:15–09:20 opening window was missed (the backend was stopped about 09:21).

**Not verified:** no order has been placed since the fix.

**Open (worth doing):**
- Treat a Kite login from before 06:00 IST today as expired (Kite's `login_time`): warn on the Orders page and
  don't hand it to the backend.
- Label the static-IP refusal (it arrives as a 403) as an IP problem, not "session expired", in
  `orderScheduler.js`.

### 2026-10-18: Milestone 3 part 1: the backtest engine (Vishwanath793 with Claude Code, android-app)
The owner reassigned milestone 3 from the other developer. Part 1 is the pure research engine and its tests;
part 2 (data download, routes, UI, export) is open.

**What changed:**
- `src/utils/candleWindow.js`: the 09:20 features from Kite 1-minute candles, in the same shape as the live
  window. There is no order book, F&O or circuit limits (left out, not invented), and VWAP comes from the candles.
  It never looks past 09:20.
- `strategies.js`, `confirmation.js`, `tradePlan.js`: for `source: 'candles'`, the order-book checks are marked
  "not tested", factor sources are relabelled, and a missing minute is a hard rejection. **Live behaviour is
  unchanged.**
- `src/utils/candleFills.js`: candle fills. Every ambiguity counts against the trade:
  - A minute with both the stop and a target counts as the stop.
  - Entries fill at the worse of the trigger and the open, plus slippage, within the maximum entry.
  - A gap through the stop fills at the open.
  - Targets are limit fills; T2 counts only after T1.
  - Entries expire; square-off closes what's left; the daily-loss and losing-streak limits are checked at the
    trigger.
- `src/utils/backtestStats.js`: trades, win rate, average win/loss, profit factor, net after costs, maximum
  drawdown, expectancy (₹ and R), average reward/risk, longest losing streak, and breakdowns by gap, RVOL, sector
  and regime.
- `src/utils/backtestRunner.js`:
  - Six comparisons: combined, A, B, C, a simple opening-range baseline, and conviction alone (recorded days
    only).
  - Slippage sensitivity (0/5/10/20 bps) and parameter sweeps (minimum score, A's minimum RVOL, C's maximum
    distance from VWAP).
  - A 70/30 out-of-sample split, and walk-forward over 4 chronological folds (choosing the minimum score in-sample).
  - The limitations listed.
- `src/utils/tickReplay.js`: recorded mornings through the live window → decision → paper ledger. Positions are
  closed at the last bid/ask when the recording ends.
- `src/utils/ticksToCandles.js`: ticks → 1-minute candles.

**Tests / checks:**
- `server/backtest.test.js` (11 tests: features, no look-ahead, "not tested" book checks, every fill rule,
  statistics, the runner, tick replay).
- `npm test`: 187 pass.
- On the simulated morning, candles and paper agree: ORBUP hits T1 and T2, and MOMO is stopped out.

**Finding:** B and C alone took no trades on the simulated morning. Both failed reward/risk after costs (1.35 and
1.40, below 1.5), the same cost effect as milestone 2.

**Not verified:** nothing has run on real historical candles yet, and no recorded tick mornings exist yet.

**Part 2, to do:**
1. **Data:** `src/core/backtestData.js`, read-only Kite historical calls through `createRateLimiter(3)`, cached
   under `.data/candles/`:
   - daily candles per symbol, for gaps, the previous day's high/low/close, and ATR from earlier days only
   - 5-minute candles in chunks of up to 100 days, for the RVOL baseline (the 09:15 candle) and the index moves
   - 1-minute candles for each candidate stock-day (the top N by gap at the open)

   Use recorded days' snapshots, master lists and conviction where they exist. Skip gaps above 20%.
2. **Routes:** `server/researchRoutes.js`, same-origin only. A background job with progress and a cancel option
   that calls `runBacktest`, plus tick replay over `.data/ticks/` (`tickLog.read`).
3. **UI:** a Research section on the Report card page with a BACKTEST badge: the period, the maximum stocks per
   day, the comparison table, the breakdowns, the sensitivity and walk-forward results, the trade list, the
   limitations, and Excel export through `buildXlsx` in `exportStocks.js`. Hide it on Android (no backend).
4. README section, DEVLOG entry, then `npm test` / `npm run build` / `npx cap sync android`.

### 2026-10-18: Milestone 4 groundwork only (Vishwanath793 with Claude Code, android-app)
The owner gave the go-ahead for milestone 4 (LIVE execution). Only this groundwork was done; **LIVE trading is
still not available** (the desk forces PAPER, and `PUT /api/trading/settings` still refuses LIVE).

**What changed:**
- `src/core/kite.js`:
  - New calls: `orders()` (GET /orders), `trades()` (GET /trades), `modifyOrder()` (PUT /orders/:variety/:id),
    `cancelOrder()` (DELETE …), and an optional `timeoutMs`.
  - A request that gets no response, or a 5xx, now throws a `KiteError` with `unknown: true` and status 0 / 5xx.
    Kite may or may not have created the order, so it must be looked up, never resent.
  - `isIpRejection()` for the static-IP refusal. The scheduled-order behaviour is unchanged: it retries only on a
    429.
- `src/utils/liveOrders.js` (pure, not used by anything yet):
  - order tags (`liveTag`, alphanumeric, at most 20 characters)
  - Kite order bodies for entry (SL / LIMIT), stop (SL-M, `market_protection: -1`), target (LIMIT IOC) and exit
    (MARKET, protection −1)
  - `readKiteOrder`, `classifyOrderError` (unknown / ip / session / rate / rejected), `liveConfirmText`,
    `roundToTick`

**Regression found and fixed while testing:**
- `/api/kite/*` passed the error status straight to Express, so a "no response" error (status 0) would have
  crashed the request instead of returning 502.
- The route helper moved to `server/kiteRoute.js`: Kite's own 4xx/5xx pass through, anything else becomes 502,
  and `unknown: true` is added when the outcome is unknown. The final error handler also guards against invalid
  statuses.
- `kite.placeOrder` appends "check your Kite order book before placing it again" to unknown outcomes, so manual
  BUY/SELL, scheduled orders and the Android app all show it.

**Tests / checks:**
- `server/liveOrders.test.js` (9 tests):
  - tags
  - error classes
  - a real AbortSignal timeout (unknown, the hint included, no token in the message)
  - modify/cancel/orders/trades request shapes
  - order bodies against Kite's fields
  - the route status mapping, over HTTP
- One new scheduler test using the real client with no network: fails once, never resends, and shows the hint.
- `npm test`: 176 pass. `npm run build` and `npx cap sync android` OK.
- Against the real backend and Kite (read-only, after a restart):
  - account summary 200
  - INFY quote 200
  - a bad token gives 403 passed through
  - missing fields give 400
  - `PUT /api/trading/settings {mode: LIVE}` gives 409; the mode stays PAPER
  - the owner's PERSISTENT Monday 09:15 order is untouched

**CI:** the first push (b3e5b51) failed the Test step on GitHub (Node 22) while all tests passed here (Node 24).
The likely cause is the real-timeout test waiting only on `AbortSignal.timeout`'s unref'd timer. It now holds a
ref'd timer while it waits (66d62cd), and CI is green: tests, APK, android-latest release.

**Not verified:** the order, modify and cancel calls have not been made against Kite. No order was placed.

**Remaining for milestone 4:**
- **A live broker:** send orders through the tags and a rate-spaced queue, poll the order book, reconcile unknown
  outcomes by tag, rest an SL-M stop after the fills, IOC targets, entry expiry, square-off, the kill switch, an
  append-only `.data/live/` log, and reconciliation after a restart.
- **Wiring into the trading desk:** arming each day (Settings switch + typed `LIVE YYYY-MM-DD` + a check that the
  static IP matches the PC's public IP + a valid session; memory only), sizing from Kite margins, and keeping the
  follow tokens for live positions.
- **Routes and UI:** arm/disarm and the live ledger in the trading panel; a LIVE badge.
- **Tests:** with a fake Kite client only (no live API calls).

Forum source for the IP rule (not in the official order docs): an order from an IP that isn't whitelisted is
rejected with "IP (…) is not allowed to place orders for this app".

### 2026-10-18: Working copy moved to C:\Users\Public\advdec_nse (Vishwanath793 with Claude Code, android-app)
**What changed:**
- The project was copied to `C:\Users\Public\advdec_nse` so several Windows accounts can share it. The old
  `C:\Users\DELL\advdec_nse` is a backup only.
- `CLAUDE.md` now has the per-user setup and the corrected milestone status.
- Milestone 3 is assigned to another developer.

**Tests / checks:**
- From the new folder: `npm test` (167 pass) and `npm run build`.
- The backend and frontend started and the app loaded.

**Not verified:** git and the app from the other Windows accounts.

**Next / open questions:** each account runs `git config --global --add safe.directory C:/Users/Public/advdec_nse`
once, and logs in to Kite again in its browser.

### 2026-10-18: Handoff docs: CLAUDE.md, DEVLOG.md, the spec in docs/ (Vishwanath793 with Claude Code, android-app, feea107 and later)
**What changed:**
- Added [CLAUDE.md](CLAUDE.md): the full handoff (milestones, the owner's rules, verified Kite facts, an
  architecture map, what is unverified, next steps).
- Committed the original 09:20 spec as `docs/prompt-920-trading-system.md` (checked: no keys or tokens).
- Added this shared development log, and the chat session log to README.md.

**Files:** CLAUDE.md, DEVLOG.md, README.md, docs/prompt-920-trading-system.md.
**Not verified:** nothing to verify (documentation only).
**Next / open questions:**
- Push to `main` and `android-app` (this also triggers the Android APK build). The other account sees nothing
  until it's pushed.
- Milestone 3 waits for the owner's go-ahead.

### 2026-10-18: Milestone 2: the 09:20 decision and paper trading (Vishwanath793 with Claude Code, android-app, 9274f4d)
**What changed:**
- The app decides BUY / SELL / NO TRADE once at 09:20 and trades the decisions **on paper only**.
- **Strategies** (`src/utils/strategies.js`, thresholds editable in Settings):
  - A, opening-range breakout/breakdown (shorts MIS only).
  - B, gap-up pullback for gaps of 3.75% or more: a real recovery vs a dead-cat bounce, reported on its own line
    under the scanner.
  - C, opening momentum: overextended moves are rejected.
- **Score:** extends `confirmation.js` (`scoreOpening`, `openingFactors`, `openingRejections`), and every factor
  states its source.
  - Weights: "every factor counts the same" (default) or research weights 20/20/20/15/10/10/5. Missing data is
    left out, not guessed.
  - Tiers: 85+ strong, 70–84 watchlist, 50–69 weak, below 50 reject. A trade needs 70 or more.
  - Stale data, no book, at a circuit, a late start or a 09:10 block is always NO TRADE.
- **Trade plan and risk** (`tradePlan.js`, `risk.js`, `charges.js`):
  - Each trade gets entry, stop and T1/T2 rounded to Kite's tick size, a slippage cap, a size from 0.25% risk,
    and Zerodha's charges.
  - Limits: reward/risk at least 1.5 after costs, 1% daily loss, 2 open positions, 3 trades a day, stop after 2
    losses in a row.
- **Paper broker** (`paperLedger.js`, `paperBroker.js`, `tradingDesk.js`):
  - Fills at the bid/ask plus slippage, never the last price; a thin book gives a partial fill.
  - Half exits at T1 and the stop moves to the entry; a stop can fill worse than its price.
  - Kill switch, square off all, and square-off at 15:10.
  - Append-only log in `.data/paper/`. After a restart the day is rebuilt from the log and reconciled, and no
    order is ever placed twice.
- **Screens:**
  - PAPER badge on every page.
  - Scanner columns: score, strategy, decision, reasons.
  - Stock detail: an SVG chart (candles, range, VWAP, entry/stop/targets) and the score breakdown.
  - A trading panel on Orders; trading settings with LIVE switched off.
- **Simulated morning:** the replay trades on its own in-memory ledger. In the browser: ORBUP hit both targets
  (+₹474 net), MOMO hit its stop (−₹271 net), and the other 11 stocks were NO TRADE with reasons.

**Files:** 22 edited/added (+2088 −37). New: `src/utils/{strategies,tradePlan,risk,charges,decision,paperLedger}.js`,
`src/core/{paperBroker,tradingDesk}.js`, `server/{tradingRoutes,eventLog}.js`, `src/{TradingPanel,OpeningChart}.jsx`,
`server/trading.test.js`. Changed: confirmation.js, openingCollector.js, openingWindow.js, simulatedMorning.js,
OpeningScanner.jsx, OrdersPage.jsx, SettingsPage.jsx, App.jsx, platform/web.js, platform/android.js,
server/index.js, styles.css, README.md, android/README.md.

**Tests / checks:**
- `npm test`: 167 pass. `npm run build` and `npx cap sync android` succeed.
- Browser check of the scanner, chart, trading panel and settings.
- Settings save and the LIVE refusal (409) tested through the real backend.

**Finding:** with ₹1 lakh capital and 0.25% risk, R ≈ ₹250 and costs ≈ ₹50 a round trip, so most breakouts failed
reward/risk ≥ 1.5. Breakout targets were set to 1.5R and 3R, which puts them further away and makes them less
likely to be hit. These defaults are untested guesses; nothing shows the strategies make money.

**Not verified:**
- Nothing has run in market hours: the live decision at the seal, paper fills on real ticks, following open
  positions after 09:30, and the 15:10 square-off.
- Kite's 1-minute historical data (the volume baseline) is untested.
- Paper fills assume the five visible book levels; real queues and hidden orders aren't modelled.
- Android CI for this commit hasn't run (not pushed yet).
- The backend was restarted on a Sunday (no session affected). The settings test saved the defaults to
  `.data/trading-settings.json`. The owner's Monday 09:15 scheduled order is untouched.

**Next:** push (needs the owner's OK); milestone 3 only on the owner's go-ahead.

### 2026-10-18: Milestone 1: the opening-window data collector (Vishwanath793 with Claude Code, main + android-app, 3599186)
**What changed:**
- Read-only collection of 09:15:00–09:19:59 over the Kite WebSocket (full mode), sealed at 09:20.
- Recordings: ticks (`.data/ticks/`), the sealed features (`.data/opening/`), and a cache of the daily
  instruments and history.
- The scanner on the 9:15 Confirm tab.
- A read-only Kite self-check.
- The simulated 13-stock morning.
- An NSE live-price fallback (`POST /api/nse/live`).
- A fix so `/api/orders/session` is no longer called repeatedly.

**Tests / checks:**
- 149 tests passed at the time.
- Pushed as a fast-forward to `main` and `android-app`; the Android CI build passed (APK published).
- Self-check with the real Kite session: instruments, historical, quote and WebSocket all OK.

**Not verified:** behaviour during market hours. (Kite sends volume, average price and depth as 0 on Sundays.)

### Before 2026-10-18: earlier work
Pre-open analyzer, conviction score and factors, tradeability checks, market context and signals, the 9:15
confirmation step, scheduled orders, the daily recorder and report card, TV research, and the Android app
(commits `acd031b` to `ec46497`). See `git log` and [CLAUDE.md](CLAUDE.md) §3.
