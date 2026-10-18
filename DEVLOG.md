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
