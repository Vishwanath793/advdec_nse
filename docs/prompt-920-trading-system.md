# Extend Advance / Decline into a 9:20 AM Opening-Window Trading System (Zerodha Kite Connect)

## 1. Objective

Act as a senior quantitative trading researcher and a senior JavaScript engineer (Node.js, React, Capacitor).

This is **not** a new project. Extend the existing **Advance / Decline** application in this repository so that it:

1. keeps everything it already does before the open (09:10 NSE pre-open import, gap conviction score, signals, tradeability, circuit limits);
2. collects live market data from Zerodha Kite Connect **between 09:15:00 and 09:19:59.999 IST** using the Kite WebSocket in FULL mode;
3. seals that window at **09:20:00 IST**, scores every candidate and produces an explainable BUY / SELL / NO TRADE decision immediately after 09:20;
4. paper-trades those decisions by default, and places live orders only after explicit opt-in;
5. records everything it sees so the existing report card can replay and validate the strategies.

The goal is to find stocks that show bullish or bearish conviction during the first five minutes, while avoiding false breakouts, weak momentum, poor liquidity and high-risk entries.

Do not assume any strategy is profitable. Every threshold and weight is a research hypothesis, to be tested with the app's own recorded data. This follows how the conviction score already works: unit weights, and factors turned off until the report card shows they help.

## 2. Read the existing code first

Before writing anything, read the README, `android/README.md` and the modules below. Then summarise what already exists and what you will change.

| Area | Existing module | What it already does |
|---|---|---|
| Backend | `server/index.js`, `server/orderRoutes.js` | Express on port 3001 (loopback only); cron for the 09:10 pre-open import; SSE to the browser; Kite proxy routes (`/api/kite/session`, `positions`, `account-summary`, `order`, `quote`) |
| Storage | `server/fsStore.js`, `.data/` | JSON files, gitignored. **No database.** |
| Kite calls | `src/core/kite.js` | Session (checksum), margins, positions, `/quote` in 500-instrument batches at 1 req/s, order placement. Shared by the backend and the Android app. |
| Pre-open | `src/core/preopen.js`, `src/utils/analysis.js` | NSE pre-open fetch and parsing, advance/decline, sector breadth, tick sizes, circuit limits |
| Context | `src/core/marketContext.js`, `src/utils/signals.js` | Previous high/low/close, 20-day average volume, results and ex-dates, GIFT Nifty, VIX, FII/DII, relative volume, gap vs yesterday's range |
| Conviction (09:10) | `src/utils/conviction.js` | 0–100 gap-continuation score; adjustable factors with unit weights; missing factors dropped and weights rescaled |
| Confirmation (09:15–09:20) | `src/utils/confirmation.js`, `src/ConfirmPage.jsx` | Polls `/quote` every 5 s; checks opening range, VWAP, gap fill, volume, order book, previous high/low, Nifty and sector, relative strength; safety checks (circuit room, spread, last trade, stop width, overextension); freezes the 09:20 range |
| Live price fallback | `src/core/nseLive.js` | NSE website prices in Kite's quote shape when Kite has no market-data permission |
| Tradeability | `src/utils/tradeability.js`, `src/core/priceBands.js` | Price bands, surveillance (GSM/ASM), intraday block/warn flags |
| Orders | `src/core/orderScheduler.js`, `src/OrdersPage.jsx` | Time-triggered orders: sent at most once, missed triggers never sent late, access token in memory only, 10 req/s spacing, single retry on HTTP 429 |
| Research | `src/core/recorder.js`, `src/utils/reportCard.js`, `src/ReportCardPage.jsx` | Archives each trading day's snapshot and context; replays recorded days against end-of-day outcomes with any conviction settings |
| Export | `src/utils/exportStocks.js`, `server/autoExport.js` | Excel export with factor breakdown; automatic 09:30 save |
| Calendar | `src/core/calendar.js`, `server/tv/holidays.json` | IST dates, NSE holidays; unknown years fail closed |
| Platforms | `src/platform/web.js`, `src/platform/android.js` | The same UI runs against the backend (browser) or on the phone (Capacitor) |
| TV research | `server/tv/*`, `src/TvResearchPage.jsx` | Unrelated to this task. Do not change it. |

Run `git status` first. If there are uncommitted changes, build on top of them and don't overwrite or revert them.

## 3. Technology: stay on the existing stack

Do **not** introduce Python, FastAPI, PostgreSQL, Redis, Docker, TypeScript or Tailwind. Use:

- **Backend:** Node.js 22, Express and ES modules, as in `server/`.
- **Shared logic:** plain JavaScript in `src/core/` (I/O: Kite, NSE, storage) and `src/utils/` (pure calculations). Logic that must run on both platforms belongs here, not in `server/`.
- **Frontend:** React (JSX) and Vite. Use the existing `styles.css` and page structure. Charts may use a small, well-maintained library such as `lightweight-charts`; check the bundle size, because the Android APK ships it.
- **Storage:** `fsStore` JSON files under `.data/`. Use one file per day for tick and depth recordings so files stay small. Use append-friendly formats such as NDJSON where the volume is high.
- **Live updates:** server-sent events from the backend, as the pre-open data already uses. No new WebSocket server for the UI.
- **Kite WebSocket:** the official `kiteconnect` npm package (`KiteTicker`), or a minimal client written against the documented binary protocol. Choose one and justify it.
- **Tests:** `node --test`. Add new test files to the `test` script in `package.json`. `npm test` and `npm run build` must pass at every milestone.
- **Android:** `npx cap sync android` must keep working, and the GitHub Actions APK build must stay green.

### Where each part runs

- **PC backend (primary):** WebSocket collection, the 09:20 decision, paper trading and live execution. The browser can be closed, as with the existing cron jobs.
- **Android app:** must keep working standalone with today's features. It may show the 09:20 scanner while the app is open, using a WebSocket from the WebView if that works reliably; otherwise it falls back to the existing `/quote` polling. **Live order placement from the phone is out of scope**, because Kite only accepts order requests from a whitelisted static IP and a phone's IP is not static.

## 4. Kite Connect integration

The user has a **Kite Connect** app (paid plan with live quotes, WebSockets and historical data). The redirect URL is `http://localhost:5173/kite/callback` in development; a separate Kite app is used for the phone (`https://localhost/kite/callback`).

Use only officially documented interfaces:

1. **WebSocket in FULL mode** for LTP, volume, average traded price, OHLC, open interest, total buy and sell quantity, five-level depth, last trade time and exchange timestamp.
2. **Historical candles** (`minute`, `5minute`, `day`) for ATR, historical opening-5-minute volume, and backtesting.
3. **Quote API** for circuit limits and a pre-09:15 validation snapshot. Reuse the batching in `src/core/kite.js`.
4. **Instruments dump** for instrument tokens, lot sizes, tick sizes and expiries. Download it once a day before the open and cache it in `.data/`.
5. **Orders, positions and margins** for execution and reconciliation. Extend `src/core/kite.js`; don't duplicate it.

Requirements:

- Respect the documented rate limits and the WebSocket subscription and connection limits.
- Use the WebSocket for time-critical data, not repeated REST polling. Keep `/quote` polling and `nseLive.js` as the fallback when the WebSocket isn't available.
- Never log, export or persist the API secret or access token. The scheduler already keeps the token in memory only; keep that rule. Redact tokens in error messages.
- If the access token has expired (Kite sessions reset daily around 06:00), show a clear "Connect to Kite" prompt before 09:15. Never trade without a valid session.

## 5. The opening window: 09:15:00–09:19:59.999 IST

### Before 09:15
- Load the 09:10 pre-open result and the conviction scores; they are the candidate list.
- Build the subscription universe: gapped stocks (configurable minimum gap), the configured watchlist, NIFTY 50, NIFTY BANK, sector indices matching the master list's industries, and the near-month future for each F&O stock.
- Validate previous closes, instrument tokens and circuit limits. Load ATR and historical opening volume from the historical API, cached per day.

### 09:15:00 to 09:19:59.999: record and compute per stock

**Price:** LTP, previous close, official open, day high and low, last traded quantity, last trade time, exchange timestamp, gap %, opening-range high and low, the five one-minute candles and the 5-minute candle (OHLC), 5-minute return, body and wick %, position of the final price in the range, distance from VWAP, distance from the previous day's high and low.

**Volume:** cumulative volume; incremental volume from successive cumulative readings (handle resets and gaps); volume per minute; opening-5-minute volume vs the historical average opening volume (RVOL); acceleration or deceleration; 20-day average daily volume (already in `marketContext`); estimated impact cost for the planned size.

Exclude pre-open auction quantity from the opening-window volume. Don't treat sparse ticks as every executed trade.

**VWAP and momentum:** use Kite's average traded price as the primary VWAP and label it as such. A self-computed VWAP is allowed only where the data supports it. Track above or below VWAP, VWAP reclaim or rejection, momentum per minute, change in the last two minutes, opening-range volatility, and ATR from completed prior candles only.

**Five-level depth:** best bid and ask with quantities and order counts, all five levels on each side, spread in ₹ and basis points, top-5 bid and ask liquidity, total buy and sell quantity, imbalance over time, liquidity near the price, and depth stability.

```
Order-book imbalance = (bid depth qty − ask depth qty) / (bid depth qty + ask depth qty)
```

Also compute best-level and top-3-level imbalance, a spread-adjusted liquidity score, and depth-pressure change across the window.

Pending orders are not executed trades. Don't describe them as aggressive buying or selling. Penalise disappearing liquidity and unstable spreads.

**F&O (where the stock has futures):** futures LTP, volume and OI; OI change from a valid baseline (the previous day's closing OI from historical data, or the first tick of the day, whichever is documented and available); premium or discount to spot; agreement between futures and spot direction.

| Price | OI | Possible reading |
|---|---|---|
| Up | Up | Long buildup |
| Down | Up | Short buildup |
| Up | Down | Short covering |
| Down | Down | Long unwinding |

These readings are conditional, not certain. Options analysis (near-the-money call and put OI, a PCR over an explicitly defined set of contracts) is optional. Kite has no option-chain API, so build it only from subscribed contracts. When F&O data is missing, score on cash data only; never invent OI.

**Market:** NIFTY 50 and NIFTY BANK since the open, sector index since the open, the stock vs its sector and vs Nifty. Also breadth: % of tracked stocks above the previous close and above VWAP. Label this as **tracked-universe breadth**; the existing advance/decline from NSE pre-open is exchange-wide. Keep the two separate.

## 6. Strategies

Implement each as a pure function in `src/utils/` that takes the sealed 09:20 features and returns a decision with its reasons. Every threshold must be configurable in Settings with sensible defaults.

**A. Opening-range breakout and breakdown.** Constructive first five minutes, volume above the historical opening norm, VWAP and sector aligned, acceptable spread and depth. Enter only after 09:20, on a live price beyond the range high (or below the range low for shorts). Shorts must be intraday (MIS) only, and only where allowed.

**B. Gap-up pullback recovery.** Applies to stocks that open at least **3.75%** above the previous close (configurable). Measure the gap, the maximum pullback from the high, range retracement, selling pressure, recovery from the 5-minute low, VWAP reclaim, whether recovery volume strengthens, depth improvement and futures OI. Check that the stop distance and reward/risk are acceptable. A gap alone is never a reason to buy. Separate a real recovery from a dead-cat bounce.

The existing conviction factor scores 0.75–2% gaps highest and tapers larger gaps because they tend to fade. Strategy B is the specific exception being tested, so report its results separately.

**C. Opening momentum.** Consistent direction, strong RVOL, a close near the range extreme, small rejection wicks, sector and benchmark aligned, stable depth, acceptable spread and slippage, a reasonable distance from VWAP and a clear invalidation level. Reject entries that are already overextended.

## 7. The 09:20 conviction score

Extend the existing confirmation score in `src/utils/confirmation.js`; don't build a parallel one. Use the same pattern as `conviction.js`: factors scored 0–1 in the trade direction, configurable weights, missing data dropped and weights rescaled, and each factor's contribution and explanation shown.

Starting research weights (configurable):

| Factor | Weight |
|---|---:|
| Price action and candle quality | 20 |
| Opening-range setup | 20 |
| Relative volume and volume trend | 20 |
| Market depth and spread quality | 15 |
| Futures/OI confirmation | 10 |
| Sector and benchmark alignment | 10 |
| Entry feasibility and reward/risk | 5 |

These are an alternative to the app's current unit-weight default, not a replacement for it. Make both selectable, and let the report card decide. Keep the existing labels and thresholds (`CONFIRMED_SCORE` 70, `FAILING_SCORE` 40) unless the report card supports changing them. Optional labels: 85–100 strong, 70–84 watchlist, 50–69 weak, below 50 reject. Labels are not probabilities.

A high score never overrides a hard rejection (missing or stale data, liquidity, circuit room, surveillance flags, risk limits). Those come from the existing safety checks and `tradeability.js`.

## 8. Decision schedule

- **Before 09:15:** load instruments, history, ATR, risk settings and the 09:10 candidates; connect the WebSocket.
- **09:15:00–09:19:59.999:** collect and compute.
- **09:20:00:** seal the window. Ticks with an exchange timestamp at or after 09:20:00 never change opening-window features.
- **Immediately after:** check data freshness, score, rank and decide.
- **Execution window** (configurable, e.g. 09:20–09:25): confirm a live executable price, then paper-trade or place the order. This is the existing "late" logic (`CONFIRM_LATE`).

Store both the exchange timestamp and the local receipt time, in Asia/Kolkata. Handle late or out-of-order ticks, duplicate packets, WebSocket reconnects, holidays (`calendar.js`, failing closed) and special sessions. If required data is missing or stale: **NO TRADE**. NO TRADE is the default. Don't promise execution exactly at 09:20:00.

## 9. Entry, stop and targets

For every decision, provide: side, symbol, strategy, entry trigger, expected entry, stop-loss, target 1, target 2, reward/risk, maximum slippage, position size, estimated costs, and the full reasons.

- Build these from the range high and low, live bid and ask, VWAP, ATR, the pullback low or invalidation level, spread, expected slippage and depth. Stops and targets are specific to each strategy; there is no fixed percentage for every stock.
- Estimate Zerodha intraday charges: brokerage, STT, exchange charges, SEBI fee, stamp duty and GST. Put the rates in one config object with a source note, because they change.
- Reject a trade when the reward after costs doesn't justify the risk.

## 10. Risk management

Defaults (all configurable in Settings):

- Risk per trade: 0.25% of trading capital
- Daily loss limit: 1% of trading capital
- Maximum open positions: 2; maximum trades per day: 3
- Minimum reward/risk: 1.5
- Maximum consecutive losses before stopping for the day: configurable

Reject excessive spreads, illiquid stocks, stale data, entries beyond the allowed slippage, insufficient margin (from the margins API), and anything that breaks exchange or broker rules.

Size each position from the stop distance, lot size (for F&O), available capital and margin.

Also provide:
- an emergency **kill switch** that cancels pending orders and blocks new ones;
- duplicate-order prevention, extending the scheduler's "sent at most once" state machine;
- order and position reconciliation on start-up and after reconnecting;
- handling for partial fills and rejections;
- a scheduled square-off with alerts if an exit fails;
- no repeated entries after a backend restart.

Never promise that a stop-loss will fill or that the system makes money.

## 11. Execution modes

Three modes: **BACKTEST**, **PAPER** (default) and **LIVE**.

- LIVE requires changing a Settings switch **and** a second typed confirmation, each trading day it's on. Show the mode clearly on every page.
- Kite only accepts live order calls from a **whitelisted static IP**. Before enabling LIVE, check the setup and explain it. If the PC is on home broadband without a static IP, LIVE will fail. Say so in the UI and docs; never try to work around it.
- Follow current Kite order rules (order types, market protection for market orders, freeze quantities, MIS cutoff). Check them against the latest Kite documentation; don't rely on memory.
- A successful order-placement response is not a fill. Update positions and risk from order updates (WebSocket order postbacks, or polling the order book if postbacks aren't set up) and from trades.
- Keep an append-only log in `.data/` of every decision, request, response, modification, cancellation and fill.
- Never retry an order whose outcome is unknown until you've checked whether the first request created it (use a `tag` per order, and check the order book).
- Paper trading simulates fills at the live bid or ask plus configurable slippage, never at the LTP.

## 12. UI

Add pages to the existing navigation and reuse the current components and styles. Must work in both the browser and the Android app.

**09:20 scanner** (extend `ConfirmPage`): rank, stock, gap %, 5-minute change %, opening volume, RVOL, VWAP position, imbalance, spread, F&O OI change, sector direction, score, strategy, BUY / SELL / NO TRADE, reasons. Show a data-source badge: WebSocket, `/quote` polling, or NSE fallback.

**Candidate detail:** 1-minute candles with the 09:15–09:20 range lines, VWAP and volume bars; live price; entry, stop and targets; the five-level order book; the score breakdown; reasons for rejection.

**Trading panel** (extend `OrdersPage`): capital, the PAPER/LIVE mode, open positions, pending orders, realised and unrealised P&L, today's trades, the daily-loss limit and the kill switch.

**Research** (extend `ReportCardPage`): change strategy parameters, run backtests, compare strategies, and export to Excel using the existing export helpers.

## 13. Research and backtesting

Extend `recorder.js` and `reportCard.js` rather than building a separate engine.

- **Recording:** every trading day, save the opening-window ticks and depth snapshots (09:15–09:25) for the subscribed universe, plus the sealed 09:20 features and the decisions. Depth history isn't available from Kite, so this recording is the **only** source of depth data for research. Never fabricate it.
- **Candle backtests:** use Kite historical candles (1-minute and 5-minute) for the range, volume and VWAP strategies over a long period that includes different market conditions. Use the equity OI history for futures where Kite provides it.
- **Tick replay:** depth-sensitive and tick-sensitive rules may only be tested on recorded days. State clearly that minute candles can't reproduce exact intrabar fills or order-book behaviour.
- **Avoid:** look-ahead bias, survivorship bias (use the master list as it was on that day where possible), instrument-token and corporate-action errors (`recorder.js` already flags ex-dates), fills at prices that weren't available, and ignoring costs, spread or slippage.
- **Compare:** opening-range breakout, gap-up pullback recovery, opening momentum, the combined 09:20 score, a simple opening-range baseline, and the existing 09:10 pre-open conviction alone.
- **Report:** number of trades, win rate, average win and loss, profit factor, net P&L after costs, maximum drawdown, expectancy, average reward/risk, longest losing streak, slippage sensitivity, and breakdowns by gap size, RVOL, sector and market regime.
- **Validation:** out-of-sample and walk-forward. Check how results change across parameter ranges; don't just pick the best historical setting. The app already prefers unit weights while data is scarce; keep that discipline.

## 14. Tests

Use `node --test` with fixture data. No live API calls in tests. Cover:

- the exact 09:20:00 cutoff (a tick at 09:19:59.999 counts, 09:20:00.000 doesn't);
- one-minute and 5-minute candle building from ticks;
- cumulative-to-incremental volume, including resets, gaps and duplicates;
- missing packets, reconnects and out-of-order ticks;
- expired or changed instrument tokens;
- quote and historical rate limiting;
- order rejection, partial fills, and duplicate prevention after a restart;
- reconciliation on start-up;
- circuit limits, surveillance flags, and risk-limit breaches;
- holidays and unknown years (fail closed);
- missing or invalid F&O data falling back to a cash-only score.

Include a **deterministic simulated morning** with at least ten stocks that produces valid and invalid signals for every strategy. The UI should be able to replay it in PAPER mode without a Kite login.

## 15. Deliverables, in milestones

Work incrementally. Each milestone must leave `npm test`, `npm run build` and the Android build passing, and is committed separately.

1. **Data collector:** the instrument cache, the WebSocket client in the backend, tick and depth recording to `.data/`, candle and VWAP building, the 09:20 seal, and a scanner showing live features and the data-source badge. Read-only, with no decisions yet.
2. **09:20 decision in PAPER:** the three strategies, the extended score, entry, stop, targets and costs, risk checks, paper fills and the trading panel with the kill switch.
3. **Research:** strategy backtests on historical candles, tick replay of recorded days, and report-card comparisons and exports.
4. **LIVE execution:** only after milestones 1–3 work, the data-quality checks pass, paper trading has run for a meaningful period, and **the user explicitly says to start this milestone**. Includes the static-IP check, order tagging, reconciliation and square-off.

Also update:
- `README.md`: setup, the daily pre-market routine (log in to Kite before 09:15, check the session, check the mode), troubleshooting and recovery (token expired, WebSocket down, backend restarted mid-trade);
- `android/README.md`: what the phone does and doesn't do.

For every factor, state where it comes from: **direct from Kite**, **calculated**, **needs self-recorded data**, or **not available from Kite**. Don't invent API endpoints or broker capabilities. When unsure, check the latest Kite Connect documentation and say what you checked.

Stop after each milestone, summarise what changed and what is unverified, and wait for the go-ahead before starting the next one.
