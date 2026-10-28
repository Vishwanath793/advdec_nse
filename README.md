# Advance / Decline

Install with `npm install`, then run `npm run server` and `npm run dev` in separate terminals. Open http://127.0.0.1:5173.

**Continuing development (including with Claude Code):** [CLAUDE.md](CLAUDE.md) has the full handoff: what each
milestone built, the owner's rules, verified Kite API facts, an architecture map, what is still unverified, and
the plan for milestones 3 and 4. The original 09:20 system spec is `docs/prompt-920-trading-system.md`.

**Several developers?** Everyone uses the shared log [DEVLOG.md](DEVLOG.md): read *Work in progress* and the latest
entries before starting, add yourself while working, and add an entry (what changed, tests, what is not
verified, next steps) when you finish. See [Development log](#development-log-latest-session) below for the
latest session.

## Daily NSE pre-open import

Settings → NSE pre-open data controls the backend cron job. It defaults to enabled at 09:10 every day in Asia/Kolkata (IST), independent of the computer's timezone. Save NSE schedule applies changes immediately; Fetch now imports on demand.

The backend and computer must be running and awake at the scheduled time. Closing the browser is fine. This is an application cron job, not a Windows service; missed runs while stopped are not replayed. Restart `npm run server` to resume the saved schedule.

The schedule, last attempt/error, and latest successful snapshot persist in `.data/nse-preopen.json`. Only NSE settings/data are stored there. The browser opens one server-sent event connection, receives cached data once, and receives subsequent updates only when the data or schedule changes. It does not poll. Small keep-alive comments maintain the connection, and a dropped connection reconnects automatically without fetching from NSE. Data is analyzed with the bundled master stock list using the same filtering and sector calculations as CSV uploads. A manually uploaded CSV stays displayed until a newer NSE snapshot arrives (or the page is reloaded).

NSE's source timestamp and the fetch time are shown separately, because weekends/holidays may return a previous trading session. Failed, empty, or invalid responses retain the last successful snapshot. Requests time out after 25 seconds; overlapping scheduled/manual requests share one fetch. No Kite orders are submitted by the import.

Validation: `npm test` and `npm run build`.

## Opening window 09:15–09:20 (Kite WebSocket)

The PC backend collects the first five minutes over the Kite Connect WebSocket (full mode), seals the window at
09:20, decides BUY / SELL / NO TRADE once, and trades the decisions **on paper only** (milestone 2). Everything is on
the **9:15 Confirm** tab (scanner) and the **Orders** tab (trading panel). Needs a Kite Connect plan with market data
(WebSocket, quotes, historical). The mode badge in the menu bar shows the mode on every page: **PAPER**. LIVE
execution is milestone 4 and doesn't exist yet.

### Daily pre-market routine

1. Start the backend (`npm run server`, or the Windows start-up task) before **08:50**; keep the PC awake.
2. **Log in to Kite** (Settings → Connect) before 09:15. Kite sessions expire every morning around 06:00, so log in
   each trading day. Keep the app open once after logging in: the browser hands the session to the backend, which
   holds it in memory only (never on disk, never logged).
3. On the 9:15 Confirm tab, press **Check Kite setup**. It runs read-only calls only (instruments dump, one
   historical request, one quote, an 8-second WebSocket subscription) and shows what came back.
4. The 09:10 pre-open import triggers the preparation: the universe (gapped stocks above the minimum gap, the
   watchlist, NIFTY 50, NIFTY BANK, matching sector indices, near-month futures of F&O stocks), instrument tokens
   from that day's Kite dump, ATR(14) and the average 09:15–09:20 volume from Kite historical candles (3 requests a
   second), and a `/quote` check of circuit limits and previous closes. It connects at **09:14**, seals at
   **09:20:00** (+1.5 s for ticks still in flight) and disconnects at 09:30.

### What is recorded

- `.data/instruments/YYYY-MM-DD.json`: that day's tokens, tick and lot sizes, near-month futures.
- `.data/history/YYYY-MM-DD.json`: ATR(14), average opening volume, futures' previous OI.
- `.data/ticks/YYYY-MM-DD.ndjson.gz`: every tick 09:14–09:25 with the local receipt time and the exchange
  timestamp, including five-level depth. Kite has no depth history, so this recording is the only source of depth
  data for research.
- `.data/opening/YYYY-MM-DD.json`: the sealed 09:20 features; `…-universe.json`: what was subscribed and why.

### Troubleshooting and recovery

- **Kite login needed / session expired**: log in again; the scanner shows *Kite login needed* before 09:15.
- **WebSocket down**: the client reconnects with backoff (1, 2, 5, 10 s) and re-subscribes; after six attempts that
  never connect (typically an expired login) it stops and says so. The confirmation checks below the scanner keep
  working from `/quote` polling or the NSE fallback.
- **Backend restarted**: before 09:20 it rebuilds the day and flags a late start as a *partial* window; after the
  seal it shows the saved window and never collects again; started after 09:20 with nothing saved, the day is
  marked *missed*. Holidays and years missing from `server/tv/holidays.json` fail closed.
- **Replay simulated morning** runs a deterministic 13-stock morning through the same pipeline (no Kite needed).

### Where each figure comes from

| Figure | Source |
|---|---|
| LTP, last traded qty, cumulative volume, average traded price, total buy/sell qty, OHLC, OI, last trade time, exchange timestamp, five-level depth | Direct from Kite (WebSocket full mode) |
| Official open, day high/low (= opening range at 09:20) | Direct from Kite (tick OHLC fields) |
| VWAP | Kite's average traded price, labelled as such (includes the pre-open trade); no self-computed VWAP |
| Gap %, 5-minute return, body and wick %, close position in the range, distance from VWAP and previous high/low | Calculated |
| One-minute candles | Calculated from sampled ticks: highs/lows approximate (labelled) |
| Window volume, volume per minute, acceleration | Calculated from cumulative volume (pre-open auction excluded; duplicates, out-of-order ticks and resets handled) |
| RVOL | Calculated: window volume ÷ average 09:15–09:20 volume from Kite 1-minute historical candles |
| ATR(14) | Calculated from Kite daily historical candles (completed days only) |
| Imbalance (best, top-3, top-5), spread in ₹ and bps, liquidity, stability, liquidity drop, impact cost | Calculated from Kite depth; these are pending orders, not trades |
| Depth history for research | Needs self-recorded data (Kite has none) |
| Futures OI change | Calculated from Kite OI vs the previous close (Kite historical with OI), else the first tick of the day (labelled) |
| Premium/discount, futures–spot agreement, build-up reading | Calculated; readings are conditional, not certain |
| NIFTY 50, NIFTY BANK, sector index since open | Direct from Kite index ticks; relative strength calculated |
| Breadth (% above previous close / VWAP) | Calculated over the tracked universe only, labelled; separate from NSE's exchange-wide advance/decline |
| Circuit limits, previous close check | Direct from Kite `/quote` before 09:15 |
| Option chain / PCR | Not available from Kite as a chain; not built |
| 09:20 score, strategy checks, trade plan, reward/risk, paper fills and P&L | Calculated (below) |
| Brokerage, STT, exchange, SEBI, stamp duty, GST | Zerodha's published intraday equity charges (`src/utils/charges.js`, checked 18 Oct 2026; update when they change) |

### 09:20 decision (paper trading, milestone 2)

At the seal, every stock in the window goes through three strategies (`src/utils/strategies.js`, pure functions,
every threshold editable in **Settings → 09:20 trading**):

- **A. Opening-range breakout / breakdown**: close near the top (bottom) of the 09:15–09:20 range, RVOL, the VWAP
  side, a sector not against it, range width 0.15–1.2× ATR, a tight spread. Entry one tick beyond the range; stop at
  the other side (the midpoint for a wide range); targets 1.5R and 3R. Shorts are intraday (MIS) only.
- **B. Gap-up pullback recovery** (gap of 3.75% or more): high, then a real pullback that doesn't fill the gap, then
  a recovery back above VWAP on more volume than the selling. Weak volume or staying below VWAP reads as a
  dead-cat bounce. Gap-ups get their own line under the scanner (real recovery / dead-cat bounce / gap filled /
  no pullback yet).
- **C. Opening momentum**: at least four of five minutes the same way, strong RVOL, close near the extreme, small
  rejection wick, Nifty and sector aligned, a stable book. Rejected when already overextended (too far from VWAP,
  too big a move, too wide a range). Entry right after 09:20 at the ask (bid for shorts).

Each passing signal gets a **trade plan** (`tradePlan.js`): entry, stop, T1, T2 rounded to Kite's tick size;
the maximum entry slippage; size = risk per trade ÷ stop distance (capped by capital × MIS leverage, whole lots);
Zerodha charges; and reward/risk **after costs** (half exits at T1, the rest at T2).

The **score** extends the Confirm page's weighted checks (`scoreOpening` in `confirmation.js`; pass 1, neutral or
caution ½, fail 0). Factors are grouped into price action, opening-range setup, relative volume, depth, F&O,
sector/benchmark and feasibility. The weights come from a preset: *every factor counts the same* (default), or
*research groups* 20/20/20/15/10/10/5. A factor with no data (no future, no ATR) is left out and the rest rescaled;
the coverage is shown. Tiers: 85+ strong, 70–84 watchlist, 50–69 weak, below 50 reject. A trade needs at least
70 (configurable), a valid plan and **no hard rejection**. Stale data, too few ticks, no two-sided book, sitting at
a circuit, a partial window (backend started after 09:15) and the 09:10 tradeability blocks always mean NO TRADE,
whatever the score. Eligible stocks are ranked by score and fill the free slots under the risk limits; the rest are
NO TRADE with the reason.

**Risk defaults** (Settings): ₹1,00,000 capital, 0.25% risk per trade, 1% daily loss limit, 2 open positions,
3 trades a day, minimum reward/risk 1.5 after costs, stop for the day after 2 losses in a row, MIS leverage 5,
paper slippage 5 bps, maximum entry slippage 15 bps, maximum spread 25 bps, entries cancelled at 09:30, square-off
at 15:10. With small risk per trade, costs are a large share of R (about ₹50 a round trip on ₹50,000), so many
setups fail the after-cost reward/risk check. That is deliberate.

**Paper fills** (`src/utils/paperLedger.js`) never use the last traded price:
- **Entries** trigger when the last price crosses the trigger, as an exchange stop order does. They fill against
  the opposite side of the five-level book plus slippage, level by level, only within the maximum entry price, so
  a thin book gives a **partial fill**. A triggered entry beyond its limit waits, like a stop-loss limit order,
  until the entry window ends. The daily-loss and losing-streak limits are checked again when an entry triggers;
  if either is hit, the entry is rejected.
- **Exits**: half at T1 (resting limit), then the stop moves to the entry price; the rest at T2. A stop exits at
  the bid (ask) minus slippage, which can be worse than the stop price. Square-off at 15:10.
- **Kill switch** (Orders tab): cancels pending entries, closes open positions at the bid/ask, blocks new trades.
  **Square off all** closes everything now.
- Open paper positions keep a WebSocket connection to their stocks after 09:30, until they close.

None of this means a real stop or target would fill at the same price, and nothing here says the strategies make
money: they are hypotheses to test on recorded mornings (milestone 3).

**Records**: `.data/paper/YYYY-MM-DD.ndjson` is the append-only event log: decision, orders, triggers, fills,
rejections, cancellations, exits, stop moves, kill switch. Download it from the Orders tab. `…/YYYY-MM-DD.json` is
a snapshot and `…-decision.json` is the full decision (every factor, check and plan). After a restart the day is
rebuilt from the log and compared with the snapshot (reconciliation; the log wins). Each order id is the day, stock
and strategy, and a day is decided only once, so a restart never places an order twice. Without a decision by the
end of the entry window, a restarted backend doesn't decide late.

**Try it without Kite**: 9:15 Confirm → **Replay simulated morning**. It replays 13 scenarios (valid and invalid
for every strategy). The paper trades go to a separate *Simulated replay* ledger, which is in memory only and never
mixed with today's. Expected result: ORBUP and MOMO are bought; ORBUP exits at T1 and T2, MOMO at its stop. The
rest are NO TRADE, each with a reason.

**Everything is adjustable** (Settings → 09:20 trading): each strategy threshold; the score preset (*every factor by
its own weight*, *research groups*, or *my own group weights*); each factor's on/off switch and weight (0–10 within
its group); the tiers; every factor's pass/warn line and the minimum ticks; the Zerodha charge rates (with the date
you checked them); and the opening universe (minimum 09:10 gap, watchlist, futures). The defaults are the values
above. **Restore the defaults** puts them back. A factor switched off still shows its reading in the candidate
detail, marked "not scored".

### Research: backtests and tick replay (milestone 3)

On the **Report card** tab, under the report, the **Research** section (badge **BACKTEST**: nothing is traded). The
backend runs one job at a time in the background (a worker thread), never 08:55–09:35 IST on trading days.

- **Candle backtest** (needs a Kite login): pick a period (up to 60 trading days), the number of stocks a day and the
  minimum gap. Each day's stocks are the biggest gaps at the open in NSE's end-of-day files (open vs the previous
  close; above 20% is skipped as a likely corporate action). Kite historical 1-minute candles for them, the ten
  days before (the RVOL baseline) and the indices are downloaded once at 3 requests a second and cached in
  `.data/candles/`; a second run of the same period makes no Kite calls. The same strategies, score, plan and
  limits run on the candles; fills resolve every ambiguity against the trade (`candleFills.js`). It compares the
  combined decision, A, B and C alone, a simple opening-range baseline and the 09:10 conviction alone (recorded
  days only), with breakdowns by strategy, gap, RVOL, sector and Nifty regime, slippage sensitivity, parameter
  ranges, a 70/30 out-of-sample split and a 4-fold walk-forward.
- **Tick replay**: the mornings the collector recorded (`.data/ticks/`), through the same window, decision and paper
  ledger as live: the only test of the order-book rules. Recordings end at 09:25, so what's still open then closes
  at the last recorded bid/ask.
- **Settings for this run** override the score and strategy thresholds for that run only (never saved).
- **Export to Excel**: every table, the trades, the limitations and the settings used.

Candles can't test depth, spread, F&O or circuit rules (marked "not tested"); the universe uses today's master
list and instrument tokens (survivorship bias). Results on a few weeks are a small sample: look for settings that
hold up across the parameter ranges and out of sample, not the single best number.

## TV research: Zee Business + CNBC Awaaz

Open **TV research** in the navigation. This is a Node.js scheduler plus React dashboard integrated into the existing application. It uses the **OpenAI API**, which is billed separately from a ChatGPT subscription; results appear here and in local files, not in ChatGPT website history.

### Setup

1. Use Node.js 22 or later and run `npm install`.
2. Copy `.env.example` to `.env`. Set `OPENAI_API_KEY` locally. Do not paste the key into chat or commit it. `OPENAI_MODEL` defaults to `gpt-4.1` for its large context window. Choose a model with enough context for both complete Hindi transcripts and at least 32,000 output tokens.
3. Run `npm run tv:browser` to install Chromium, or set `TV_BROWSER_CHANNEL=chrome` to use an installed Google Chrome. A separate browser profile is kept in `.data/tv/browser-profile`; your personal Chrome profile is not used. This workspace is configured for installed Chrome.
4. Run `npm run build`, then `npm start`. Open http://127.0.0.1:3001/#/tv-research. For development, run `npm run server` and `npm run dev` in separate terminals.
5. Optional persistent Windows startup: run `powershell -NoProfile -File scripts/install-startup.ps1` (add `-Port 3002` to use a port other than `.env`'s `PORT`). This registers `AdvanceDecline-Backend` for your user at login and before the evening run, starts it hidden, and logs to `.data/backend.log`. The user must be logged in and the PC awake. It does not wake a sleeping PC. Do not run a second backend instance on the same port. After editing `.env`, restart this task (or the terminal backend).

The backend serves the built UI and binds to loopback. TV routes additionally reject non-local hosts/origins. Do not expose the application with a public tunnel; authentication for a shared deployment is not included.

### Daily workflow

- The scheduler is enabled by default at **19:00 Asia/Kolkata**. It calculates the broadcast date in IST and builds both URLs in the supplied formats: `11th september` for Zee, `11th Sept 2026` for CNBC. It selects the first qualifying video in YouTube's current result order: at least seven hours, completed, expected channel/show, and exact broadcast date including year in the title. Up to six batches of search results are checked. A still-live stream, stale broadcast, ambiguous date, or missing duration is rejected.
- It opens `https://downsub.com/?url=` with the encoded canonical watch URL and downloads the **Hindi (auto-generated) TXT** track. Playlist parameters are deliberately omitted so another playlist item cannot replace the selected broadcast. Each source URL, duration, file size and SHA-256 digest is saved.
- Both entire UTF-8 caption texts are submitted inline to the Responses API in one first request, with the user's first prompt verbatim. No file-search sampling or local truncation is used. The second request includes both transcripts, the completed first response, and the user's second prompt verbatim. Additional instructions distinguish source text from instructions and count distinct named analysts, not repeated mentions. Ties, uncertainty and insufficient evidence must be disclosed.
- Context truncation is disabled. Oversized input, incomplete output, blocked downloads, absent captions, CAPTCHA or login challenges cause a visible failure. No partial result is labeled complete. The code cannot guarantee the model found every recommendation or that the source captions cover every word of a broadcast.
- Runs persist under `.data/tv/runs/YYYY-MM-DD/`: `zee.txt`, `cnbc.txt`, `extraction.md`, `consensus.md`, and `run.json`. Browser failures also save `browser-error.png`. The dashboard has source/download links and run history. Stored data and `.env` are gitignored.
- Overlapping jobs share the active run; completed dates are reused. Failed runs retry after 30 minutes, up to four attempts total, through 23:00 IST. Restarting the server catches up only the current evening. Saved transcripts and a completed extraction are reused on retry. A crash can still cause an API call to repeat if its result was not yet saved. Manual runs can retry beyond the automatic limit and select earlier market dates.

### Calendar maintenance

`server/tv/holidays.json` contains NSE **capital market (equity)** holidays for 2026 from [NSE circular CMTR/71775](https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf). It is not the currency or settlement calendar. Every Saturday and Sunday is excluded, including special weekend sessions, as requested. Add exchange-announced changes and each new year's official calendar to this file. Unknown years fail closed. This does not automatically detect later exchange holiday revisions.

For the current date, Saturday 12 September 2026, the next eligible run is **Tuesday 15 September 2026 at 19:00 IST**: Monday 14 September is Ganesh Chaturthi.

### Verification and troubleshooting

- `npm test`: holiday/date boundaries, URLs, duration parsing, correct video selection, complete transcript submission, prompt sequencing, retry limits, overlap and saved-file reuse, plus existing pre-open tests.
- `npm run build`: React production build.
- `npm run tv:check -- 2026-09-11`: live browser/download check without any paid API call. Saves files separately in `.data/tv/download-checks/2026-09-11/`.
- `npm run tv:run -- 2026-09-11`: full real run for a market date (uses the configured paid API).
- `npm run tv:setup-browser`: opens the separate automation profile for you to complete Downsub verification yourself. Close the browser before retrying a run. A future challenge may still interrupt unattended execution.
- Downsub and YouTube can change their UI or block automation. Inspect the saved screenshot and failure message. Set `TV_BROWSER_HEADLESS=false` for local troubleshooting; solve login or CAPTCHA challenges yourself. The automation does not bypass challenges. Restart the backend after changing environment settings.
- Stop Windows auto-start with `Disable-ScheduledTask -TaskName AdvanceDecline-Backend`; `Stop-ScheduledTask -TaskName AdvanceDecline-Backend` stops its running process. Pausing research from the UI keeps the existing pre-open service available.

Implementation references: [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state), [GPT-4.1 model](https://developers.openai.com/api/docs/models/gpt-4.1), [Playwright downloads](https://playwright.dev/docs/downloads). Prompt constants are in `server/tv/prompts.js`.

## AI Analyst (read-only research)

Open **AI Analyst** in the navigation, or press **Ask AI** next to a stock in the Analyzer's stocks table (it opens
the tab with that stock on the exact Analyzer snapshot and settings). It explains conviction scores and filter
results, compares stocks, screens on exact numbers, lists missing or stale data and summarises recorded mornings,
with a source card for every claim. Numbers come from the app's own analysis functions; explanations come from an
allowlisted document index (hybrid keyword + vector search). It cannot place, change or cancel orders or change
settings, and its scores are rankings, not win probabilities.

- Off until configured: set `AI_PROVIDER=openai` and `AI_API_KEY` in `.env` (separate from TV research's key), or
  `AI_PROVIDER=mock` to try it offline at no cost. Restart the backend.
- "As known at the selected time" leaves out anything published after the cutoff; "Retrospective research" may show
  later outcomes, labelled as such.
- Questions pause 09:13–09:31 IST on trading days; indexing runs in a worker thread and never 08:55–09:35.
- Not available in the Android app (no provider key is ever put in the APK).

Full setup, limits, costs and the evaluation set: [docs/ai-analyst.md](docs/ai-analyst.md).

## Android app

A standalone Android version (everything except TV research runs on the phone, no PC needed) lives in
`android/`, built with Capacitor. GitHub Actions builds the APK on every push; builds from `main` are published
as the **android-latest** release. Install steps, the phone's 09:10 notification schedule and Kite setup are in
[android/README.md](android/README.md).

Shared logic (NSE parsing, price bands, signals, Kite calls, calendar) is in `src/core/` and used by both the
Node backend and the app; `src/platform/` picks the backend (browser) or on-device (Android) implementation.

## Development log (latest session)

The full, shared history is in [DEVLOG.md](DEVLOG.md); the handoff for Claude Code is [CLAUDE.md](CLAUDE.md).
Below is the Claude Code chat from the session of **18 Oct 2026** (milestones 1 and 2, then the handoff), as it
appeared on screen.

### Progress messages

- Pushing Milestone 1 to main and `android-app` (a fast-forward), and watching the Android build in the background.
- The chart, plan, score breakdown and gap report all render. Checking the trading panel on the Orders page with
  the replay ledger.
- The page kept its scroll position; the user's own scheduled order is untouched. Scrolling up to the trading
  panel.
- The panel shows both replay trades with exits, charges and net P&L. Checking the trading settings on the
  Settings page.
- The settings render, with LIVE disabled and explained. Next: round-trip a settings save through the real
  backend.
- Save, the LIVE refusal, and restoring the defaults all work. Now the README.
- Updating the collector's header comment, which still said "no decisions".
- All 167 tests pass, and the build and `cap sync` succeed. Committing Milestone 2 locally, leaving out
  `.claude/` and `docs/` as before.

### Milestone 2 report

Milestone 2 is done and committed on this machine as 9274f4d (not pushed). The app now decides BUY / SELL /
NO TRADE once at 09:20 and trades those decisions on paper only. All 167 tests pass, and `npm run build` and
`npx cap sync android` succeed. The Android build for Milestone 1 (3599186) also passed on GitHub.

**What changed**

- **Strategies:** three setups, each with thresholds you can change in Settings:
  - **A, opening-range breakout:** long or short; shorts are intraday (MIS) only.
  - **B, gap-up pullback:** gaps of 3.75% or more. It tells a real recovery from a dead-cat bounce and is
    reported on its own line under the scanner.
  - **C, opening momentum:** rejects moves that have already run too far.
- **Score:** added to `confirmation.js` rather than built as a separate score. Every factor says where its data
  comes from.
  - The weights are either "every factor counts the same" (default) or the research weights 20/20/20/15/10/10/5.
    Factors with no data are left out, not guessed.
  - Tiers are 85+ strong, 70–84 watchlist, 50–69 weak, below 50 reject. A trade needs 70 or more.
  - Stale data, no order book, a stock at its circuit limit, a late start or a 09:10 block always means
    NO TRADE, whatever the score.
- **Trade plan and risk:** each trade gets entry, stop and two targets rounded to Kite's tick size, a slippage
  cap, a size based on 0.25% risk, and Zerodha's charges. Reward/risk must be at least 1.5 after costs. Other
  limits: 1% daily loss, 2 open positions, 3 trades a day, stop after 2 losses in a row.
- **Paper broker:**
  - Fills are at the bid/ask plus slippage, never the last price, and a thin order book gives a partial fill.
  - Half the position exits at T1, then the stop moves to the entry price. A stop can fill worse than its price.
  - There is a kill switch, "square off all", and square-off at 15:10.
  - Every event is appended to a log in `.data/paper/`. After a restart the day is rebuilt from that log and
    checked against the saved state, and the same order is never placed twice.
- **Screens:**
  - A PAPER badge on every page.
  - New scanner columns: score, strategy, decision, reasons.
  - Clicking a stock shows a chart with the 1-minute candles, range, VWAP, entry, stop and targets, plus the score
    breakdown.
  - A trading panel on the Orders tab, and trading settings where LIVE is switched off with an explanation.
- **Simulated morning:** "Replay simulated morning" now trades on its own in-memory ledger, so it never mixes
  with today's. Run in the browser: ORBUP hit both targets for +₹474 net and MOMO hit its stop for −₹271. The other
  11 stocks were NO TRADE, each with a reason.

**One finding:** with the default ₹1 lakh capital and 0.25% risk, you risk about ₹250 a trade, and charges are
about ₹50 a round trip. That pushed most breakout setups below 1.5 reward/risk, so the breakout targets are set at
1.5× and 3× the risk (the distance from entry to stop). That makes the targets further away and less likely to
be hit. These defaults are untested guesses; nothing here shows the strategies make money.

**Not verified yet**

- Nothing has run in market hours. The live decision at the seal, paper fills on real ticks, keeping the
  connection open for open positions after 09:30, and the 15:10 square-off are all unverified.
- Kite's 1-minute historical data (used for the volume baseline) hasn't been tested.
- Paper fills assume you'd get the price shown in the five visible order-book levels; real queues and hidden
  orders aren't modelled.
- The backend was restarted to load the new code. It was Sunday, so no session was affected. A settings test
  saved the default values to `.data/trading-settings.json`, and the Monday 09:15 scheduled order is untouched.
- Android CI for this commit won't run until it's pushed.

Open question at the end of the milestone: push to main and android-app? Milestone 3 (backtests, replaying
recorded mornings, report-card comparisons and exports) waits for the owner's go-ahead.

Files: 22 edited (+2088 −37), including `charges.js` (+58), `risk.js` (+79 −1) and `tradePlan.js` (+75).

### Handoff request and answer

**Request:** "add all the chat response that i am able to read on the screen to read me file so that i use this
project in my other claude account to build more features so that the claude code understands what has been done
so far and how can go ahead about further"

**Answer:**
- The handoff went into a new file, [CLAUDE.md](CLAUDE.md), instead of pasting the whole chat into README.md.
  Claude Code reads `CLAUDE.md` automatically whenever it opens the project, so another account picks it up
  without being told. README.md points to it. `CLAUDE.md` covers:
  - **The app:** each tab, the tech stack, and how to run and test it.
  - **The spec and rules:** the four milestones and their status, plus the owner's constraints, such as keeping
    the Kite token in memory only, no LIVE trading without explicit go-ahead, the static-IP rule, and not
    touching TV research or the Monday 09:15 scheduled order.
  - **History:** each request and what was built, with the Milestone 1 and Milestone 2 summaries.
  - **Kite facts:** the WebSocket format, rate limits and order fields checked in the Kite documentation, so the
    next session doesn't guess them.
  - **Architecture:** a map of how data flows from the 09:10 import to the paper trades.
  - **Still unverified:** nothing in the 09:20 system has run during market hours yet, and the strategy
    thresholds are untested.
  - **How to continue:** what Milestone 3 (research) involves and the conditions before Milestone 4 (LIVE), plus
    tips for working on this Windows machine.
- The original spec was committed at `docs/prompt-920-trading-system.md` (checked first: no keys or tokens).
- Everything was committed locally (feea107 and Milestone 2's 9274f4d), but not pushed. Another account can only
  see it once it's on GitHub.

Follow-up: this session log was added here, and [DEVLOG.md](DEVLOG.md) was created so several developers can see
each other's recent and in-progress work.
