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
| — | — | Nothing in progress. Next planned: milestone 3 (research), **waiting for the owner's go-ahead** | — | — |

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
