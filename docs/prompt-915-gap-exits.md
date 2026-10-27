# Prompt: 9:15 market entry with gap-based size, stop-loss and targets

Copy everything below the line into Claude Code, run from `C:\Users\Public\advdec_nse`.

---

Extend Advance / Decline with a **9:15 gap entry**: I buy (or short) a stock **at market at 09:15**, and the app
sizes the quantity from the gap, then immediately sets the stop-loss and targets from the gap and manages the
exit. Build it in two phases. **Phase 1 is PAPER only. Do not start phase 2 until I say so.**

## 0. Before you start

- Read `CLAUDE.md` and `DEVLOG.md` first. Add yourself to *Work in progress* in DEVLOG.md. Don't change files
  someone else lists there (milestone 3 part 2 is paused: `src/core/backtestData.js`, `server/researchRoutes.js`,
  `src/ResearchPanel.jsx`, ...) without asking me.
- Run `git status` first. Build on uncommitted changes; never overwrite or revert them.
- All the rules in CLAUDE.md §2 still apply. In particular:
  - no live API calls in tests
  - the Kite token stays in memory only
  - never touch TV research
  - **never touch my PERSISTENT Monday 09:15 scheduled order**
  - paper fills at the bid/ask plus slippage, never at the LTP
  - never promise that a stop fills or that this makes money
- Don't invent Kite APIs. For every input, say where its data comes from (table in §2).
- Read these before designing; reuse them, don't build parallel versions:
  - `src/utils/tradePlan.js`: reward/risk after costs, half at T1
  - `src/utils/risk.js`: `positionSize`, `cleanRiskSettings`
  - `src/utils/charges.js`: `roundTripCharges`
  - `src/utils/liveOrders.js`: `roundToTick`, order bodies, tags, `readKiteOrder`, `classifyOrderError`
  - `src/utils/paperLedger.js`: `applyEvent`, `stepTick`, `rebuildLedger`
  - `src/core/paperBroker.js` and `src/core/tradingDesk.js`
  - `src/core/openingCollector.js` (its trading hook) and `src/utils/openingWindow.js`
  - `src/utils/ticksToCandles.js`
  - `src/core/kiteHistory.js` (`atrFromDayCandles`)
  - `src/core/orderScheduler.js`
  - `src/utils/simulatedMorning.js`

## 1. The rule: always enter, and let the gap change the quantity

There is **no skip rule**. A 9:15 gap entry is never refused because of the gap size, the score or the
reward/risk. The gap and the plan only make the quantity smaller. The only refusals are cases where a sensible
order is impossible:
- no valid Kite session (live)
- the stock is locked at its circuit with no opposite side
- no price at all for the stock

## 2. Inputs and where each comes from

| Input | Meaning | Source |
|---|---|---|
| `PC` | Previous close | Kite `/quote` `ohlc.close`, else the 09:10 pre-open import |
| `O` | Opening / equilibrium price | 09:10 pre-open import (final IEP). Kite `/quote` `ohlc.open` in 09:00–09:08 is unverified (CLAUDE.md §4); use it only as a fallback and label it |
| `E` | Entry price | Live: Kite order `average_price` (`readKiteOrder`). Paper: the simulated fill. Before the fill: `O` ± slippage as an estimate |
| `ATR` | ATR(14) | `atrFromDayCandles` in `src/core/kiteHistory.js`. If missing: 2% of `PC`, labelled *estimate*, and the size factor × 0.5 |
| `tick` | Tick size | Kite instruments (not the app's table; INFY is ₹0.05) |
| `upper`, `lower` | Circuit limits | Kite `/quote` `upper_circuit_limit` / `lower_circuit_limit`, else `src/core/priceBands.js` |
| `PDH`, `PDL` | Previous day high / low | The previous completed daily candle from Kite historical |
| Opening range, VWAP | Values at 09:20 | The sealed opening window (`openingWindow.js`): Kite day high/low at the seal, and Kite's average traded price as VWAP |
| 5-minute candles | Used for the trail | Ticks through `ticksToCandles.js` (approximate, labelled) |

Gap: `G = O − PC` and `g = |G| / ATR`. The **gap direction** is up if G > 0. The **trade side** is my choice:
BUY, or SELL (MIS only). The formulas below are written for a **long**; mirror every one of them for a short
(swap high/low, upper/lower, + and −).

## 3. Settings (new, configurable, clamped like `cleanRiskSettings`)

Add `DEFAULT_GAP_EXIT_SETTINGS` in a new pure module `src/utils/gapExits.js`. Save it with the trading settings
and show it in Settings under **"9:15 gap entry"**. These are untested starting values; say so in the UI.

```js
{
  bands: { flat: 0.2, normal: 0.8, large: 1.5 },          // g thresholds (gap in ATR)
  sizeFactor: { flat: 1, normal: 1, large: 0.5, extreme: 0.25 },
  nearCircuitPct: 2, nearCircuitFactor: 0.5,               // within 2% of the circuit on the trade's side
  weakRrFactor: 0.5,                                        // fixed-target plan below risk.minRewardRisk
  minFactor: 0.25,                                          // the combined factor never goes below this
  noiseAtr: 0.35, gapLineBufferAtr: 0.1, wideStopAtr: 0.5, maxStopAtr: 0.6,
  t1R: 1.0, t2R: 2.5, rangeAtr: 1.3, circuitTicks: 3,
  tightenBufferAtr: 0.05, timeStopAt: '09:45', timeStopR: 0.5,
  trail: '5min',                                            // '5min' (last completed 5-minute low − 1 tick) or 'atr' (best price − trailAtr × ATR)
  trailAtr: 0.5,
}
```

## 4. The formulas (pure functions in `src/utils/gapExits.js`)

### Gap type
- **flat**: g < 0.2
- **normal**: 0.2 ≤ g < 0.8
- **large**: 0.8 ≤ g < 1.5
- **extreme**: g ≥ 1.5

### Stop distance `S`
- **flat / normal:**
  - `gapLine = PC + 0.5·G − 0.1·ATR`
  - `S = max(0.35·ATR, E − gapLine)`
- **large / extreme:** `S = 0.5·ATR`
- **All types:**
  - `S = min(S, 0.6·ATR)`
  - `SL = roundToTick(E − S)`, rounded away from the entry
  - `SL` must stay at least one tick inside `lower`; clamp it and add a note if it doesn't

### Targets
- **T1** = `E + 1.0·S`, capped at `upper − 3 ticks`. If the cap puts T1 below `E + 0.25·S`, add the note
  "upside capped by the circuit".
- **Flat / normal: fixed T2.**
  - `room = 1.3·ATR − |G|`
  - Candidates: `2.5·S`, `room`, and `PDH − E` if `O < PDH` and `PDH > E`
  - `T2 = E + min(candidates)`, capped at `upper − 3 ticks`
  - If T2 ≤ T1 + 1 tick, drop T2 and trail the second half instead
- **Large / extreme: no T2.** The second half trails (§5).
- Round all levels to the tick, rounding against yourself.

### Quantity (decided before the entry)
- `factor = sizeFactor[type]`
- × `nearCircuitFactor` if `(upper − O)/O` < `nearCircuitPct`%
- × `weakRrFactor` **only for fixed-T2 plans** whose reward/risk after costs (computed the same way
  `buildTradePlan` does: half at T1, half at T2, `roundTripCharges`) is below `risk.minRewardRisk`. Trailing plans
  already carry their gap factor.
- × 0.5 if ATR is an estimate
- `factor = max(factor, minFactor)`
- `qty`: use `positionSize` with the risk budget × factor, the stop distance `S` + slippage, the notional and
  margin caps, and whole lots. **Minimum 1 share (or 1 lot).**

### Return value
`gapExitPlan(...)` returns:

```js
{ side, gapPct, g, type, factor, factorReasons[], S, sl, t1, t2|null, trailSecondHalf,
  qty, riskRs, rewardRisk|null, notes[], sources{} }
```

Each factor reason must say why it applied (for example "large gap 1.1 ATR: ×0.5", "within 1.4% of the upper
circuit: ×0.5").

### Re-plan after the fill
`replanAfterFill(plan, fillPrice)` recomputes S, SL, T1 and T2 from the **actual** average price. The quantity
is already fixed. Report the actual risk in ₹. If it is more than 1.5× the planned risk, flag it (don't act on
it).

## 5. Managing the trade after the entry

Pure functions, each tested.

- **The stop never widens.** Every update is `stop = max(stop, candidate)` for a long.
- **T1 hit:**
  - exit half (round down to a lot; with 1 share there is no half, so it all exits at T1)
  - move the stop to breakeven plus the per-share round-trip costs (`roundTripCharges` ÷ remaining qty, rounded
    up to a tick)
- **09:20 check** (after the seal, using the sealed opening range and VWAP):
  - `stop = max(stop, OR low − 0.05·ATR)`
  - if `LTP < VWAP` **and** `LTP < O`, exit everything (reason: "gap failed at 09:20")
- **Time stop:** at `timeStopAt`, if T1 hasn't been hit and the open profit is below `0.5·S`, exit everything.
- **Trail** (second half, after T1, when there's no T2):
  - `'5min'`: the stop is the low of the last completed 5-minute candle − 1 tick
  - `'atr'`: the stop is the best price since the entry − 0.5·ATR
  - ratchet only; never above the market
- **Square-off:** the existing `risk.squareOffAt` (15:10).
- Every exit gets a reason: `stop`, `t1`, `t2`, `trail`, `gap-failed-0920`, `time-stop`, `square-off`, `kill`.

## 6. Phase 1: PAPER (build now)

1. **Pure module** `src/utils/gapExits.js` with everything in §3–§5. No I/O.
2. **Paper entries at 09:15.**
   - Add the strategy `gap915` to the paper system. It is a separate source from the 09:20 strategies and does
     not go through `decideOpening`'s score/strategy filters.
   - Entry: a MARKET order at 09:15:00. Fill at the opposite side of the first book after 09:15:00, plus
     slippage, walking the depth levels as the existing paper fill rule does. **Never at the LTP.**
   - Order id `date-symbol-gap915`; tag prefix `P915` (Kite-valid, at most 20 characters). The same no-duplicates
     rule on restart.
   - The exit logic from §5 runs in `stepTick` (or a gap915 branch of it), event-sourced, so `rebuildLedger`
     reproduces it.
   - **Which stocks:** a **"9:15 gap list"** I edit on the Orders page (symbol + BUY/SELL, saved under `.data/`).
     Optionally, a read-only **paper shadow** of each of my scheduled MARKET orders timed 09:15:00–09:15:59. A
     shadow only copies the symbol, side and time; it never changes or delays the real order, and the
     persistent Monday order is shadowed at most, never edited.
3. **Collector / desk.**
   - Today the trading desk only gets ticks after the 09:20 seal. Give it ticks from 09:15:00 for gap915
     symbols only, without changing the opening-window or seal logic.
   - Make sure the gap list's symbols are subscribed even when they aren't in the 09:10 candidate universe.
   - After 09:30, keep following open gap915 positions, as the desk already does for 09:20 positions.
4. **Server.** Extend `server/tradingRoutes.js` (same-origin only): get/put the gap list, get the gap plan per
   symbol (live from the 09:10 data). The SSE payload carries the gap915 positions.
5. **UI** (plain, concise text; PAPER badge; no chart libraries).
   - **Orders page, "9:15 gap entry" card**, one row per stock:
     - gap %, g, type, factor with its reasons, qty, risk ₹
     - SL, T1, T2 (or "trail"), reward/risk
     - the data source of each input (hover)
     - once filled: the fill, the re-planned levels, the current stop, status, and the exit reason
   - **When I create a scheduled 09:15 MARKET order**, show the gap plan's suggested quantity next to the
     quantity field. Show it only; never change my input.
   - Draw the levels on `OpeningChart.jsx` for gap915 positions.
   - **Settings:** the §3 numbers, with a line saying they are untested.
6. **Report card and export.**
   - Record each gap915 trade: plan, fill, exits, reasons, net P&L after charges, R multiple, gap type.
   - Add a summary by gap type: trades, win rate, average R, average adverse and favourable excursion in ATR.
     I will use this to tune the factors.
   - Add the same rows to the CSV/Excel export.
7. **Tests** (`node --test`, no live calls). **Add every new test file to the `test` script in package.json.**
   - Worked examples. PC 1000, ATR 30, tick 0.05:
     - open 1012, fill 1012.50, capital ₹1L, risk 0.25%:
       - expect S 10.50 and SL 1002
       - qty: ₹250 ÷ (10.50 + about 0.51 slippage) gives 22 shares at factor 1
       - expect T1 1023 and T2 1038.75
       - reward/risk after costs is close to 1.5, so assert the factor the `buildTradePlan` method gives, and
         write down which way it went
     - open 1020, fill 1021:
       - expect S 14 and SL 1007, T1 1035, T2 1040
       - reward/risk below 1.5, so the factor is 0.5
     - open 1060 (extreme), fill 1061, upper 1100:
       - expect S 15 and SL 1046
       - factor 0.25, so ₹62.50 risk and 4 shares
       - T1 1076, then trail
   - The short-side mirror of each example.
   - Invariants:
     - the stop never widens
     - levels on the tick
     - T1/T2 never beyond the circuit
     - the factor floor
     - at least 1 share
     - ATR missing gives an estimate label and × 0.5
   - Paper ledger sequences on a simulated morning:
     - T1 then trail
     - stop hit, with a fill at the bid minus slippage, worse than the stop
     - gap failed at 09:20
     - time stop
     - square-off
     - restart in the middle of the trade, rebuilt from the log
8. **Validate:** `npm test`, `npm run build`, `npx cap sync android` (Android shows nothing new; `api.trading`
   stays null there). Restart the backend and check the replay in the browser.
9. **Stop.** Add a DEVLOG entry (template). Commit with a `Co-Authored-By` line. Don't push unless I ask.
   Summarise what changed and what is unverified (nothing has run in market hours), then **wait for my go-ahead**.

## 7. Phase 2: LIVE exits for my own scheduled 09:15 order (only when I say so, after a paper period)

This places real orders, so the milestone 4 rules apply in full:
- **Static IP:** never work around it.
- **Session:** a valid Kite session is required.
- **Arming:** a Settings switch plus the typed daily confirmation `liveConfirmText(date)`.
- **Phone:** nothing from the phone.
- **Unknown outcomes:** never retry until you have checked `GET /orders` / `GET /trades` by tag.

Steps:
1. **Opt-in per scheduled order:** a new field `exits: 'gap'`. Off by default, never applied to existing orders,
   **never to the persistent Monday order**.
2. **Optional auto-size:** at 09:14:00, recompute the quantity from the final pre-open price. The quantity sent is
   `min(the quantity I entered, the gap-plan quantity)`, so it never exceeds what I approved. Show what was sent
   and why.
3. **After the entry.**
   - Poll the order book (`readKiteOrder`) until the entry is COMPLETE, or partly filled.
   - Run `replanAfterFill` on the `average_price`.
   - Place the stop as **SL-M** (`stopOrderBody`, `market_protection: -1`) for the filled quantity, so the
     position is protected even if the app stops.
   - On partial fills, modify the stop's quantity as more fills come in.
4. **Targets are not resting orders.** When the touch reaches T1/T2, the app sends a **LIMIT IOC**
   (`targetOrderBody`). Then it modifies the SL-M's quantity and trigger (breakeven, the 09:20 tightening, the
   trail).
   - This way two resting exit orders can never both fill and leave a reverse position.
   - If the IOC doesn't fill, try again on the next touch.
5. **Other exits** (09:20 failure, time stop, square-off 15:10, kill):
   - first cancel the SL-M
   - confirm the cancellation in the order book
   - then send `exitOrderBody`
   - if the SL-M fills in the meantime, don't exit again
6. **Restart / reconcile:**
   - rebuild from the event log, then reconcile with Kite's order book and positions by tag
   - Kite wins
   - flag any mismatch in the UI
7. **Tests:** a mocked Kite only, covering:
   - partial fills
   - rejections
   - unknown outcomes (check, then retry)
   - a stop filling while a target is being sent
   - restart reconciliation
   - session expiry
   - a static-IP rejection
8. **Stop again** for review, as in phase 1.

## 8. Say plainly in the UI and the summary

- The thresholds and factors are untested starting points, and the report card by gap type is how to tune them.
- A market entry at 09:15:00 can fill well away from the pre-open price, which makes the stop and the risk
  bigger than planned.
- An SL-M can fill below its trigger, or not at all if the stock locks at its circuit.
