# CLAUDE.md: project handoff for Claude Code

Read this first. It records what has been built so far (the requests, the decisions and the results reported in
the chat sessions), the rules the owner set, how the code is organised, what is still unverified, and how to
continue. User-facing documentation is in [README.md](README.md) and [android/README.md](android/README.md).

**Several people work on this repo. Before starting any task, read [DEVLOG.md](DEVLOG.md)** (*Work in progress*
and the latest entries), add yourself to *Work in progress*, and don't change code someone else lists there
without asking the owner. When you finish, add a DEVLOG entry using its template (what changed, files, tests,
what is not verified, next steps) and commit it with the work. Pull before editing DEVLOG.md; keep both sides
of a conflict.

Owner's git identity: Vishwanath793 / vishwanath793@gmail.com. Branches `main` and `android-app` are kept
identical (fast-forward). Pushing to `main` also builds and publishes the Android APK (GitHub Actions, release
`android-latest`).

---

## 1. What the app is

**Advance / Decline**: a personal NSE (India) pre-market and opening trading assistant.

- **Analyzer**: NSE pre-open data (imported by the backend at 09:10 IST, or an uploaded `pm.csv`). It shows the
  advance/decline split, sector breadth, market cap, circuit limits and a 09:08 **conviction score**, plus
  tradeability flags (T2T, surveillance, circuit, data checks).
- **9:15 Confirm**: the opening-window scanner (Kite WebSocket, milestone 1) and the 09:20 decisions (milestone 2).
  Below them are the older 9:15–9:20 confirmation checks, which use Kite `/quote` polling with an NSE-website
  fallback.
- **Orders**: the 09:20 paper-trading panel (milestone 2) and **scheduled orders**. A scheduled order is sent to
  Kite by the backend at an exact second; the user's own real orders are placed only this way.
- **Positions**: Kite positions, square-off, max-loss auto square-off.
- **Report card**: the daily recorder and how the picks did.
- **TV research**: Zee Business and CNBC Awaaz transcripts, analysed with the OpenAI API every evening at 19:00.
  **Do not change it** (the owner's rule).
- **Settings**: Kite login, the NSE schedule, order parameters, and 09:20 trading settings (paper).
- **Android app** (`android/`, Capacitor): everything except TV research and the PC-only Kite WebSocket
  collector / paper trading. It never places live 09:20 orders.

Stack:
- Node 22, Express and ES modules.
- `src/core` holds shared code with I/O; `src/utils` holds pure functions; both are used by the server and the app.
- React + Vite for the UI.
- `fsStore` JSON files under `.data/` (gitignored), and NDJSON for high-volume data.
- SSE pushes data to the UI (no WebSocket server for the UI).
- Tests use `node --test`.

Run it:
- Development: `npm install`, then `npm run server` (port 3001) and `npm run dev` (5173) in two terminals.
  `.claude/launch.json` has both.
- Validation: `npm test`, then `npm run build`, then `npx cap sync android`. All three must pass before a commit.
- **Every new test file must be added to the `test` script in package.json.**

---

## 2. The governing spec: the 09:20 opening-window trading system

The full prompt the owner pasted is saved at `docs/prompt-920-trading-system.md`. That file is untracked; commit
it if this repo is cloned elsewhere. Summary:

Extend the app into a 09:20 Opening-Window Trading System on Zerodha Kite Connect. Keep everything that already
happens before the open. Collect Kite WebSocket FULL-mode data from 09:15:00 to 09:19:59.999 IST, seal at
09:20:00, score the candidates, and decide BUY / SELL / NO TRADE. Trade on PAPER by default; LIVE only after an
explicit opt-in. Record everything for the report card.

**Milestones.** Each is committed separately. After each one, **stop, summarise what changed and what is
unverified, and wait for the go-ahead.**

| # | Milestone | Status |
|---|---|---|
| 1 | Data collector (Kite WebSocket, seal at 09:20, recordings, scanner) | **Done**, commit 3599186 (pushed; Android CI green) |
| 2 | 09:20 decision in PAPER (strategies, score, risk, paper broker, UI) | **Done**, commit 9274f4d (local; **not pushed yet**) |
| 3 | Research: candle backtests, tick replay, report-card comparisons, exports | **Not started**: wait for the owner's go-ahead |
| 4 | LIVE execution | **Not started**. Only after milestones 1–3 work, the data-quality checks pass, paper trading has run for a meaningful period, **and the owner explicitly says to start it** |

**Rules from the spec. They still apply.**
- Never log, export or persist the Kite API secret or access token. The backend holds the token **in memory
  only**, and tokens are redacted in error messages (`redactSecrets` in `src/core/kite.js`).
- If the Kite session has expired, show a clear "Connect to Kite" prompt before 09:15. Never trade without a valid
  session.
- LIVE needs a Settings switch **and** a second typed confirmation, every trading day it is on.
- Kite accepts live orders only from a whitelisted **static IP**. Never try to work around that.
- Never retry an order whose outcome is unknown until you have checked whether the first request created it.
- Paper fills are at the live bid or ask plus configurable slippage, **never at the LTP**.
- No live API calls in tests.
- Don't touch TV research.
- Run `git status` first. Build on top of uncommitted changes; don't overwrite or revert them.
- Don't invent APIs; check the Kite Connect documentation. For every factor, state where its data comes from.
- Never promise that a stop-loss will fill or that the system makes money.
- Live order placement from the phone is out of scope.
- The owner has a real **PERSISTENT scheduled order (Monday 09:15)** in the order scheduler. Never touch it.

---

## 3. History: what was built, request by request

Earlier commits (before the 09:20 system):
- `acd031b` to `a76818f`: pre-open analyzer, market cap, circuit limits, conviction score, tradeability checks,
  decision signals, adjustable conviction factors, manual NSE fetch.
- `338a7dd` to `1626963`: the Android app (Capacitor) and the CI that builds the APK.
- `952e9e2`: conviction improvements: the gap sweet spot, a cap for untradeable stocks, data checks, unit weights,
  full-width layout.
- `ec46497`: daily recorder, report card, market signals, the 9:15 confirmation step (Kite live prices and F&O OI
  change, customisable conviction and check weights), and scheduled orders.

Requests in the sessions that produced milestones 1 and 2, and what was done:
- "/api/orders/session api is getting called again and again". The session hand-off was de-duplicated, and only
  successful hand-offs count, so the backend never loses the session after a restart (`shareKiteSession` in
  `src/App.jsx`).
- "/api/kite/quote Kite: Insufficient permission for that call". The Kite app had no market-data subscription.
  The fix: subscribe the Kite Connect app to market data. Meanwhile an **NSE live-price fallback** was built:
  `src/core/nseLive.js` and `POST /api/nse/live`. It returns Kite's quote shape, uses a cookie handshake, retries
  on a hang, caches for 3 s and times out after 8 s. The Confirm page offers *Auto (Kite, else NSE)*, Kite only or
  NSE only.
- "Extend Advance / Decline into a 9:20 AM Opening-Window Trading System" (the spec above). Milestone 1 was built.
- "push milestone 1 and start milestone 2". Milestone 1 was pushed to main and android-app, and milestone 2 was
  built and committed locally.

### Milestone 1: summary as reported (commit 3599186)

Read-only data collection; no orders.
- `src/core/kite.js`: instruments dump (gzipped CSV), historical candles (with OI), redacted errors.
- `src/core/kiteTicks.js`: binary WebSocket packet parser (LTP 8, index 28/32, quote 44, full 184 bytes; depth at
  byte 64; prices in paise).
- `src/core/kiteTicker.js`: connection, subscribe in full mode, reconnects at 1/2/5/10 s, a 10-second silence
  watchdog, and a stop after 6 failed opens ("log in again").
- `src/core/instruments.js`: compact daily instruments. Gives tokens, tick and lot sizes, the nearest-expiry
  future, and the index tokens.
- `src/core/kiteHistory.js`: ATR(14) from completed daily candles, the average 09:15–09:20 volume over 10 days
  from 1-minute candles, the futures' previous OI, and a rate limiter (3 requests a second).
- `src/utils/openingWindow.js`: the pure window. Rules:
  - Ticks count only when stamped in [09:15:00, 09:20:00).
  - The pre-open auction volume is excluded.
  - Duplicates, out-of-order ticks and volume resets are handled.
  - The opening range is Kite's day high/low at the seal.
  - VWAP is Kite's average traded price, labelled as such.
  - 1-minute candles are approximate.

  Features it computes:
  - depth: imbalance, spread, stability, liquidity drop, impact cost
  - F&O OI build-up
  - Nifty, Bank Nifty and sector index moves
  - breadth over the tracked universe, labelled as such
  - data-quality counters
- `src/core/openingCollector.js`: the daily timeline:
  - prepare after the 09:10 import: universe, tokens, `/quote` check of circuit limits and previous close, history
  - connect at 09:14
  - seal at 09:20:00 + 1.5 s
  - record ticks until 09:25
  - stop at 09:30

  On a restart:
  - after the seal, the day is loaded from disk and never collected again
  - a late start is flagged *partial*
  - after 09:20 with nothing saved, the day is marked *missed*
  - holidays and unknown calendar years fail closed

  Also: a read-only Kite self-check, and a replay mode.
- `server/tickLog.js`: daily NDJSON tick recording, gzipped at close (`.data/ticks/`).
- `server/openingRoutes.js`: `/api/opening/*` (status, SSE events, stock detail, sealed day, prepare, selftest,
  replay).
- `src/utils/simulatedMorning.js`: a deterministic 13-stock morning: ORBUP, ORBDN, FAKEOUT, GAPPULL, DEADCAT, MOMO,
  OVEREXT, ILLIQ, STALE, LOCKED, FNOSHORT, NOFUT and FLAT. It also includes a duplicate tick, an out-of-order tick
  and ticks stamped exactly 09:20:00.
- `src/OpeningScanner.jsx`: the scanner table and detail view on the 9:15 Confirm tab.
- Verified with the owner's real Kite session on a Sunday:
  - the instruments, historical, quote and WebSocket calls worked (INFY token 408065, NIFTY 50 256265)
  - on Sundays Kite sends volume, average price and depth as 0
  - INFY's tick size is ₹0.05 in Kite, while the app's table said ₹0.10, so **use Kite's tick size**

### Milestone 2: summary as reported (commit 9274f4d)

Paper trading only. Every threshold is a hypothesis, not a known edge.
- **Strategies** (`src/utils/strategies.js`, pure, thresholds in `DEFAULT_STRATEGY_SETTINGS`):
  - **A, opening-range breakout / breakdown.**
    - Conditions: close in the top 30% of the range (bottom 30% for shorts), RVOL at least 1.2, on the right side
      of VWAP, sector not against it, range 0.15–1.2× ATR.
    - Entry one tick beyond the range. Stop at the other side, or the midpoint for a wide range.
    - Targets 1.5R and 3R. Shorts are MIS only.
  - **B, gap-up pullback recovery** (gap of 3.75% or more).
    - Shape: a high, a real pullback that doesn't fill the gap, then a recovery back above VWAP.
    - The recovery's volume per minute must be at least 1.2× the pullback's; otherwise it reads as a dead-cat
      bounce.
    - Entry on a break of the recovery candle's high; stop below the pullback low.
    - Reported separately through `gapReport` (real recovery / dead-cat bounce / gap filled / no pullback yet).
  - **C, opening momentum.**
    - Conditions: at least 4 of 5 minutes moving the same way, RVOL at least 1.5, close near the extreme, a small
      rejection wick, Nifty and sector aligned, a stable book.
    - Rejected when overextended: more than 1.5% from VWAP, more than 3% since the open, or a range above 1.2× ATR.
    - Immediate entry at the ask (the bid for shorts). Targets 1.5R and 3R.
- **Score**: `scoreOpening` / `openingFactors` / `openingRejections` in `src/utils/confirmation.js`. It extends
  the existing confirmation score rather than adding a parallel one.
  - Groups: price, range, volume, depth, F&O, market, feasibility. Every factor has a `source`.
  - Presets: `unit` (default; every factor counts the same) or `research` (20/20/20/15/10/10/5).
  - Missing data is excluded and the rest rescaled; `coverage` shows how much was scored.
  - Tiers: 85+ strong, 70–84 watchlist, 50–69 weak, below 50 reject. `CONFIRMED_SCORE` 70 and `FAILING_SCORE`
    40 are kept.
  - **Hard rejections always win**: stale data, fewer than 5 ticks, no two-sided book, at a circuit limit, a
    partial window, and a 09:10 `block` flag.
- **Trade plan** (`src/utils/tradePlan.js`):
  - Levels rounded to Kite's tick size. Expected entry = trigger ± slippage; the maximum entry comes from
    `maxSlippageBps`.
  - Size from `positionSize` (risk ÷ stop distance, capped by capital × MIS leverage, whole lots).
  - Half exits at T1. Reward/risk is computed **after costs**.
  - Rejected if there is no book, the spread is too wide, T1 is beyond the circuit, the size is zero, or
    reward/risk is below the minimum.
- **Charges** (`src/utils/charges.js`): Zerodha intraday equity rates, checked 18 Oct 2026.
  - Brokerage 0.03% or ₹20 per executed order, whichever is lower.
  - STT 0.025% on the sell side; NSE transaction charges 0.00307%; SEBI ₹10 per crore.
  - Stamp duty 0.003% on the buy side; GST 18% on brokerage + transaction + SEBI.
- **Risk** (`src/utils/risk.js`) defaults:
  - capital ₹1,00,000, 0.25% risk per trade, 1% daily loss, 2 open positions, 3 trades a day
  - minimum reward/risk 1.5, stop after 2 losses in a row, MIS leverage 5
  - slippage 5 bps, maximum entry slippage 15 bps, maximum spread 25 bps
  - entries cancelled at 09:30, square-off at 15:10
- **Decision** (`src/utils/decision.js`, `decideOpening`):
  - NO TRADE by default, and every stock gets its reasons.
  - Among the passing strategies, the best plan wins (a valid plan first, then score, then reward/risk).
  - Eligible stocks are ranked by score and fill the free slots under the limits; the rest are NO TRADE with the
    reason.
- **Paper ledger** (`src/utils/paperLedger.js`): event-sourced and pure (`applyEvent`, `stepTick`,
  `rebuildLedger`).
  - **Entries:** trigger when the LTP crosses the trigger, then fill against the opposite side of the book plus
    slippage, level by level, within `maxEntry`. A thin book gives a partial fill. Beyond the limit the order
    waits like a stop-loss limit order. Unfilled entries expire at `entryUntil`. The daily-loss and losing-streak
    limits are checked again at the trigger, and the entry is rejected if either is hit.
  - **Exits:** half at T1 (limit), then the stop moves to breakeven, then the rest at T2. A stop exits at the bid
    minus slippage, which can be worse than the stop. Square-off, kill switch and close-all exit at the touch.
- **Paper broker** (`src/core/paperBroker.js`):
  - Writes `.data/paper/YYYY-MM-DD.ndjson` (an append-only log, `server/eventLog.js`) and a `.json` snapshot.
  - On load it rebuilds from the log and reconciles against the snapshot; the log wins.
  - Order id = `date-symbol-strategy`, and a day is decided once, so a restart never places a duplicate.
  - Kite-compatible tags (alphanumeric, at most 20 characters).
- **Trading desk** (`src/core/tradingDesk.js`):
  - Two ledgers: `day` (saved to disk) and `replay` (in memory).
  - Gets `onSeal` and `onTicks` from the collector, and arms the square-off timer.
  - `wake()` after a restart: rebuilds the day and keeps following open positions. It decides late only if
    before `entryUntil`.
  - `cleanTradingSettings` always forces `mode: 'PAPER'`.
- **Collector changes:** a `trading` hook. Ticks after the seal go to the desk. After 09:30 a new connection
  `follow`s the stocks with open paper positions until square-off. In a replay, ticks keep flowing after the seal
  and `onReplayEnd` closes what is left.
- **Server:**
  - `server/tradingRoutes.js` (same-origin only):
    - `GET /api/trading/state?ledger=`
    - `GET /api/trading/decision/:symbol`
    - `PUT /api/trading/settings` (returns **409 for LIVE**)
    - `POST /api/trading/kill`
    - `POST /api/trading/close-all`
    - `GET /api/trading/log/:date`
  - Settings are saved to `.data/trading-settings.json`.
  - The opening SSE payload carries `trading` (the replay ledger during a replay).
- **UI:**
  - `ModeBadge` (PAPER) in the nav on every page.
  - Scanner columns: Score, Strategy, Decision, Reasons.
  - Gap-up report line under the scanner.
  - Candidate detail: `src/OpeningChart.jsx` (custom SVG with candles, range lines, VWAP, volume bars,
    entry/stop/T1/T2), the plan, the score groups, every factor with its source, and the strategy checks.
  - `TradingPanel` on Orders: capital, P&L, a daily-loss bar, open positions and pending entries, the day's
    orders and exits with charges, the kill switch, square off all, and an event-log download.
  - `TradingSettings` in Settings, with LIVE disabled and explained.
- **Simulated replay result** (verified in the browser and in tests): ORBUP and MOMO are bought. ORBUP exits half
  at T1 and the rest at T2 (+₹474 net); MOMO stops out at the bid minus slippage (−₹271 net). The other 11 are NO
  TRADE, each with a reason.
- **Finding:** with ₹1 lakh capital and 0.25% risk, R is about ₹250 and costs are about ₹50 a round trip, so many
  setups fail reward/risk ≥ 1.5 after costs. That is why breakout targets are 1.5R/3R. These are untested
  defaults.
- Tests: `server/trading.test.js` (16 tests) and 2 more in `server/openingCollector.test.js`. The suite has **167
  tests, all passing**.

---

## 4. Verified Kite Connect facts (from the docs; don't re-guess)

- **WebSocket:**
  - URL `wss://ws.kite.trade?api_key=…&access_token=…`.
  - Limits: 3000 instruments per connection, 3 connections per API key.
  - Messages: `{"a":"subscribe","v":[…]}` and `{"a":"mode","v":["full",[…]]}`.
  - Binary frames: an int16 packet count, then int16 length + packet. Prices in paise.
  - Exchange timestamps are in seconds. A 1-byte message is a heartbeat.
- **Instruments:** `/instruments/:exchange`, a gzipped CSV regenerated daily (fetch around 08:30). Tokens can be
  reused after expiry.
- **Historical:** `/instruments/historical/:token/:interval?from&to(&oi=1)`, candles `[ts,o,h,l,c,v(,oi)]`.
- **Rate limits:** quote 1/s, historical 3/s, orders 10/s, 400/min, 5000/day. `/quote` takes 500 instruments a
  request; ohlc and ltp take 1000.
- **Orders:**
  - `market_protection` is −1 or 0–100, for MARKET and SL-M only. `tag` is alphanumeric, at most 20 characters.
  - Statuses: COMPLETE, REJECTED, CANCELLED, OPEN, TRIGGER PENDING.
  - Fields `filled_quantity`, `pending_quantity`, `average_price`; `GET /trades` returns executions.
  - Autoslice makes at most 10 slices. A successful placement is **not** an execution.
- `TokenException` is a 403 and means log in again. "Insufficient permission" means the Kite app has no
  market-data subscription.

---

## 5. Architecture map (09:20 system)

```
09:10 pre-open import (server/preopen.js) ──► getCandidates (server/index.js: analyze + conviction + flags)
        │
        ▼
src/core/openingCollector.js ── kiteTicker ── Kite WebSocket (full)
   │ ingest                         │ tickLog (.data/ticks)
   ▼                                ▼
src/utils/openingWindow.js ──seal 09:20──► .data/opening/DATE.json
   │ onSeal / onTicks (trading hook)
   ▼
src/core/tradingDesk.js ── decideOpening (utils/decision.js)
   │                         ├─ runStrategies (utils/strategies.js)
   │                         ├─ buildTradePlan (utils/tradePlan.js, risk.js, charges.js)
   │                         └─ scoreOpening / openingRejections (utils/confirmation.js)
   ▼
src/core/paperBroker.js ── utils/paperLedger.js ── .data/paper/DATE.ndjson (+ .json, -decision.json)
   │
server/tradingRoutes.js, server/openingRoutes.js (SSE) ──► OpeningScanner.jsx, OpeningChart.jsx, TradingPanel.jsx
```

Other modules:
- `src/core/orderScheduler.js` + `server/orderRoutes.js`: the user's own scheduled real orders. The Kite session
  is handed over through `PUT /api/orders/session`, which also feeds `openingCollector.setSession`.
- `sameOriginOnly` (in `server/orderRoutes.js`) guards `/api/orders`, `/api/kite`, `/api/opening` and
  `/api/trading`. The Vite proxy is `{ target, changeOrigin: true, xfwd: true }`.
- `src/platform/web.js` (browser → backend) and `src/platform/android.js` (on the device). On Android,
  `api.opening` and `api.trading` are `null`.

---

## 6. Unverified, and known limitations

- Nothing from the 09:20 system has run during **market hours** yet:
  - the live seal → decision
  - paper fills on real ticks
  - following open positions after 09:30
  - the 15:10 square-off
- Kite's 1-minute historical request (used for the RVOL baseline) hasn't been tested live.
- Paper fills assume the visible five depth levels are available. Queue position, hidden liquidity and latency
  are not modelled.
- The strategy thresholds and the R-multiple targets are untested hypotheses.
- Commit 9274f4d has **not been pushed**, so its Android CI hasn't run.
- The bundle is about 551 kB minified (177 kB gzipped). Avoid chart libraries; the chart is custom SVG.

---

## 7. How to continue

### Milestone 3: research (start only when the owner says so)

From the spec:
- **Candle backtests:** Kite historical 1-minute candles through the same strategies, using a candle-based window.
  Depth isn't available historically, so label the depth factors as unavailable.
- **Tick replay:** recorded mornings from `.data/ticks/*.ndjson.gz`. The collector's `replay` with
  `source: 'recorded'` already feeds the window and the replay ledger; add batch runs over many days.
- **Report-card comparisons:** paper results vs the 09:08 conviction picks vs the 9:15 confirmation.
- **Exports:** decisions, trades and the per-factor results to Excel/CSV.
- Show the **BACKTEST** mode badge on research screens.

Reuse what exists: `decideOpening`, `stepTick` / `rebuildLedger`, `simulatedMorning`, `server/tickLog.js`
(`read`), `src/utils/reportCard.js` and `src/utils/exportStocks.js`.

### Milestone 4: LIVE (only on the owner's explicit instruction, after a meaningful paper period)

- A static-IP check: Kite whitelists one IP; never work around it.
- A Settings switch **plus** a typed confirmation each day.
- Order tags. Before any retry, check `GET /orders` / `GET /trades` for whether the first request created the
  order. Reconcile against Kite.
- Partial fills and rejections from Kite's order updates (the WebSocket text messages of type `order`).
- Square-off.
- Never from the phone.

### Working conventions that matter on this machine (Windows)

- The Bash tool is Git Bash. Heredocs and `node -e` with template literals (`${…}`), backslashes or apostrophes
  have broken several times. **Use the Edit/Write tools** for code containing those characters. Python is not
  installed.
- LF→CRLF warnings on commit are normal.
- Restart the backend (`preview_stop` / `preview_start` "backend") after server-side changes. `npm run server` has
  no watch mode. Restarting clears the in-memory Kite token; the app re-shares it when the page reloads.
- After UI edits, hot reload can leave a stale error in the console (for example "ModeBadge is not defined");
  reload the page before concluding anything.
- Write concise, plain-English UI text and comments that match the surrounding code. Don't add chart libraries.
- Commit each milestone separately, end commit messages with a `Co-Authored-By` line, push only when asked, and
  keep `main` and `android-app` identical.
