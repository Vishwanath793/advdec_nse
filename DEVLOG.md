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
