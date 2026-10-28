# 09:20 volume and candle breakout confirmation: implementation brief

Prepared: 2026-10-28. Project: `C:\Users\Public\advdec_nse`. All trading times are Asia/Kolkata (IST).

This file is the requested design artifact. No application implementation was performed when preparing it. The owner may hand this file to another agent to implement. Read the repository's current instructions, status, and development log before implementation; this document is a design specification, not permission to deploy or enable live trading.

## 1. Recommended starting decision

Start with **a breakout of the first three-minute range, backed by time-matched volume, followed by one completed hold candle**. Evaluate the completed sequence at 09:20 and permit a paper entry only at a subsequent executable quote.

The primary sequence is deliberately simple:

1. C1-C3, 09:15-09:18: establish and freeze the reference range.
2. C4, 09:18-09:19: break that range with a directional body, a close near the breakout extreme, and at least 1.5x same-minute relative volume.
3. C5, 09:19-09:20: close beyond the buffered level again, with only a limited wick excursion back through the level.
4. At 09:20, require at least 1.5x opening-five-minute relative volume, the appropriate VWAP relationship, acceptable data, and a feasible entry/stop/reward plan.
5. After the actual decision timestamp, enter on paper only if fresh prices still satisfy the conditions and risk limits.

This is the recommended **engineering and research starting point**, not an empirically proven best strategy. It provides a complete causal sequence by 09:20, avoids selecting the easiest candle after seeing the outcome, and keeps the initial number of parameters manageable. It will miss some earlier moves and some moves that start after 09:20; measure that cost explicitly.

Keep a separate **full five-minute opening-range breakout** variant for subsequent evaluation. Its earliest close-and-hold confirmation is normally 09:22: a 09:20-09:21 breakout candle followed by a 09:21-09:22 hold candle. At 09:20 that strategy is only a setup.

Do not make highest-volume-candle breaks, retests, order-book pressure, futures OI, or multiple score weights compulsory in the first release. Record these as evidence or separate experimental variants. More conditions do not automatically produce better trades.

## 2. Existing app: inspected behavior and integration implications

Paths below are relative to the repository root for portability to the implementing agent.

| Area | Current behavior observed | Required design change |
|---|---|---|
| `src/utils/confirmation.js` | Legacy quote confirmation uses daily-volume share; opening scoring uses RVOL and last-two/first-three volume acceleration | Keep legacy output distinct; add explicit volume-baseline provenance and breakout/hold explanations |
| `src/utils/openingWindow.js` | Freezes 09:15-09:20; minute OHLC comes from sampled LTP; volume increments come from cumulative readings; `approximate: true` on minute candles | Add quality-aware sequence features; never describe sampled bars as exact exchange bars |
| `src/core/kiteHistory.js` | Current code uses 20 prior sessions for opening averages, cache version 3; daily ATR is a simple average of true ranges | Add per-clock-minute volume baselines and sample counts; retain existing average fields for compatibility |
| `src/core/openingCollector.js` | Seal grace is 1,500 ms; stops at 09:30; current tick recording ends at 09:25 | Reuse seal boundary; extend recording if post-09:20 confirmation and outcome replay need later data |
| `src/utils/strategies.js` | Existing ORB prepares a trigger one tick outside the five-minute range; default minimum RVOL 1.2; momentum uses 1.5 | Add a distinctly named three-minute break-and-hold strategy; preserve old strategy identity for comparison |
| `src/utils/decision.js` | Evaluates and ranks at the seal, then assigns BUY/SELL/NO TRADE | Represent setup state separately from actionable decision; apply new hard conditions explicitly |
| `src/core/tradingDesk.js` | Seal causes a decision and paper orders; later ticks principally feed the broker | First release can use seal evaluation; a later full-range/retest release requires a persisted confirmation state machine |
| `src/utils/tradePlan.js` | Estimates entry, size, stop and split-target net R:R; current target blend can look better than reward to the first obstacle | Add a new-strategy feasibility check to the first obstacle/target, without changing unrelated strategies silently |
| `src/utils/risk.js` | Defaults include 0.25% risk/trade, 1% daily loss, 2 positions, 3 trades/day, 1.5 net R:R; entry cutoff currently 09:30 | Retain global limits; use a tighter strategy-specific entry deadline |
| `src/utils/candleWindow.js`, `backtestRunner.js`, `tickReplay.js`, `candleFills.js` | Existing historical/replay infrastructure | Route new rules through shared pure calculations; preserve data-mode limitations |
| `src/ConfirmPage.jsx`, `TradingPanel.jsx`, `SettingsPage.jsx` | Existing scanner, trading panel, settings | Add source-aware evidence and WAIT states in existing surfaces |

Verify these observations against the checkout before editing. Some old comments mention fewer historical days than the current `OPENING_VOLUME_DAYS = 20`; actual code and stored baseline metadata take precedence over stale descriptions.

Keep the existing Node/Express/plain-JavaScript/React/Vite/Capacitor stack and JSON/NDJSON storage. No new database or external trading service is needed. Preserve the 09:15 gap-entry/exit flow, scheduled real orders, TV research, and AI Analyst restrictions.

## 3. Time, candle boundaries, and information availability

| Candle | Interval, end exclusive | Completed at |
|---|---|---|
| C1 | [09:15:00, 09:16:00) | 09:16 |
| C2 | [09:16:00, 09:17:00) | 09:17 |
| C3 | [09:17:00, 09:18:00) | 09:18 |
| C4 | [09:18:00, 09:19:00) | 09:19 |
| C5 | [09:19:00, 09:20:00) | 09:20 |

Use exchange timestamps for interval membership and receipt timestamps for what the engine actually knew. Store both. `decisionAt` is the actual calculation/publication time after required data becomes available, not an invented 09:20:00 fill time.

The current seal grace may produce a decision around 09:20:01.500 or later. Admit only eligible pre-09:20 exchange-time observations received before finalization. Never include a 09:20-or-later exchange-time observation in C5 or the sealed five-minute range.

For minute finalization, use the same bounded late-arrival convention. Evaluate earlier states from observations available by each state's decision time. Later historical corrections may produce a separate revised research result but must not rewrite the as-traded record.

For primary-strategy reconstruction at the seal, freeze C1-C3 levels and pre-C4 inputs using their respective as-of cutoffs. It is insufficient merely to filter by exchange timestamp if an important older observation arrived too late to have been usable.

No primary entries before the 09:20 checkpoint. The mathematical pattern can be evaluated retrospectively at that checkpoint, but entries never precede `decisionAt`.

## 4. Starting parameters

All numeric choices below are unvalidated defaults for research and paper evaluation. Existing stricter global limits remain effective. Store settings and a strategy-version identifier with every result.

| Setting | Start with | Role |
|---|---|---|
| Primary reference | C1-C3 combined range | Fixed, not selected after the break |
| Primary breakout/hold | C4 breakout, C5 hold | Complete evidence at 09:20 |
| History window | Most recent 20 valid sessions within preceding 40 scheduled sessions | Reject insufficient coverage; record exclusions |
| Minimum historical sessions | 15 for each required baseline | Hard data gate |
| Baseline statistic | Median | Robust starting baseline; keep mean for comparison |
| Opening-five-minute RVOL | >= 1.50 | Hard participation gate at 09:20 |
| Breakout-minute RVOL | >= 1.50 | Hard breakout participation gate |
| Breakout directional body/range | >= 0.60 | Hard candle-quality gate |
| Directional close location | >= 0.75 | Hard candle-quality gate |
| Breakout rejection wick/range | <= 0.25 | Explanatory companion to close location, not extra score credit |
| Hold requirement | One subsequent completed candle | Hard acceptance gate |
| Hold volume floor | None beyond valid, nonzero observed volume | Avoid rejecting a sound quiet hold |
| Permitted hold wick penetration | No more than one frozen buffer inside reference | Hard primary hold gate |
| VWAP relationship | Breakout close, hold close, and pre-entry price on correct side | Hard directional gate |
| Strategy spread cap | 15 bps, also satisfy stricter global cap | Hard executable-price gate |
| Primary entry deadline | Earlier of 09:21 and global entry cutoff | No late chase of an old checkpoint |
| Full-range experimental deadline | Earlier of 09:25 and global cutoff | Separate strategy |
| Max chase from buffered level | 0.50 x structural risk measured from that level | Additional to global slippage cap |
| Net R:R to first planned target/obstacle | >= 1.50 | Do not rely solely on blended distant targets |
| Retry/re-entry | None for primary symbol/side/day | Limit repeated attempts and ambiguous state |
| Execution | Shadow first; opt-in PAPER after quality validation | This work does not enable LIVE |

Keep hard gates limited to this stated set plus existing risk/tradeability requirements. Nifty, sector, futures OI, volume acceleration, and volume concentration start as context, not additional mandatory gates.

## 5. Volume calculations and data contract

### 5.1 Baselines

For each valid prior day `d`, obtain deduplicated, completed one-minute bars identified by instrument, session date and exact minute start. Require all five unique opening minutes for the opening baseline; a raw count of five rows is insufficient when duplicates or missing timestamps exist.

Define, using only sessions before the decision day:

```text
openingVolume[d] = sum(volume[d, 09:15 .. 09:19])
openingMedian = median(openingVolume[d])
minuteMedian[t] = median(volume[d, clockMinute=t])

openingRvol = todayOpeningVolume / openingMedian
minuteRvol[t] = todayVolume[t] / minuteMedian[t]
breakoutRvol = minuteRvol[breakoutMinute]
```

The median of session totals is not necessarily the sum of minute medians. Calculate each baseline directly. Require positive finite denominators. Missing is not zero, and division by zero must not produce an eligible signal.

For the later full-range strategy, fetch same-clock baselines through 09:24. For research outcomes, obtain later bars separately. Never use the entire day's volume to retrospectively qualify an opening decision.

Retain `openVol5Avg` and the current `rvol` meaning for legacy strategies. Add versioned fields such as `openVol5Median`, `minuteVolumeBaselines`, and `volumeEvidence.openingRvolMedian`; do not silently change the denominator of historical reports.

Record session dates, sample count, exclusions, baseline statistic, instrument identity, source, auction policy, and calculation version. Exclude corrupt/incomplete/special sessions under deterministic rules. Do not remove a valid large-volume session merely because it worsens the desired result. Median baselines reduce isolated outlier influence. Handle splits and material volume-regime changes explicitly; if comparable history cannot be established, report insufficient data.

### 5.2 Auction and cumulative-feed reconciliation: release prerequisite

The current collector subtracts an auction baseline from cumulative day volume. Historical minute-bar auction inclusion must be checked empirically and against provider clarification; the generic API documentation does not settle that equivalence.

Before enabling this strategy for paper orders, compare recorded opening cumulative differences, auction quantities, and later authoritative minute bars for multiple instruments and sessions. Establish one documented matching volume convention for live and historical numerator/denominator. Do not substitute day cumulative volume for continuous-session volume.

If equivalence is unresolved, calculate provisional research values but return `DATA_INSUFFICIENT` for actionable decisions. If matching historical continuous-session history is unavailable, accumulate comparable recorded history; do not invent a correction.

### 5.3 Sampled bars and uncertainty

Kite streaming quotes are not treated as a complete tape of individual executions. The existing app correctly labels sampled minute OHLC as approximate. A cumulative-volume increment tells us total shares since a prior reading, not the exact trade prices or aggressor sides of those shares.

Required quality metadata per bar:

- Source and `approximate` flag; complete interval flag; sample count.
- First/last observation times and last trade time.
- Maximum observation gap, known disconnects, delayed/out-of-order samples, cumulative resets.
- Whether a volume increment straddles a minute boundary and the size of that uncertain increment.
- Timestamp and evidence source used to finalize the bar.

Suggested starting quality gates for the liquid-stock PAPER cohort: current quote receipt and last-trade ages <= 5 seconds; last price observation within 5 seconds of each required bar end; no known disconnect/reset in C1-C5; no observation gap > 10 seconds within required bars. These are operational hypotheses, not proof of complete trade coverage.

For boundary-straddling volume, maintain conservative lower/upper bounds where possible. A breakout-volume gate may pass only if its conservative lower bound still exceeds the threshold; otherwise wait for compatible authoritative data or mark volume ambiguous. Do not attribute a reconnect burst entirely to the minute in which it was received and call it a volume spike.

A first-window-tick estimated baseline can undercount opening activity. Record it as incomplete; it does not pass the primary full-window quality gate without reconciliation.

Shadow mode may evaluate approximate data visibly. After reconciliation and a documented quality review, sampled candles may be used for PAPER with an explicit `sampled-price` qualifier. Results remain distinct from historical OHLC tests. Unavailable exact highs/lows cannot be fixed by merely taking more decimal places.

### 5.4 Context-only volume metrics

Retain these for diagnostics and research, without hard entry gates initially:

```text
normalizedAcceleration = mean(RVOL_C4, RVOL_C5) / mean(RVOL_C1, RVOL_C2, RVOL_C3)
openingConcentration = max(V_C1 .. V_C5) / sum(V_C1 .. V_C5)
```

Normalize time of day before comparing early and late minute activity. The current raw last-two/first-three ratio can be retained as a labeled legacy metric. A declining raw ratio is not automatically a failed breakout.

Volume >= 4x its baseline is an attention flag, not an automatic rejection or bonus. Investigate whether price actually advances, wicks reject the move, or the executable spread widens.

Do not label candle-color volume as actual buy/sell volume. Do not infer volume-at-price, POC, institutional participation, or aggressor delta from sampled quotes and cumulative increments.

## 6. Exact primary breakout and hold rules

### 6.1 Frozen reference and buffer

At the reference cutoff after C3:

```text
H3 = max(high_C1, high_C2, high_C3)
L3 = min(low_C1, low_C2, low_C3)
W3 = H3 - L3
spreadRef = median(valid ask-bid observations in final 30 seconds before 09:18)
b = roundUpToTick(max(2*tickSize, spreadRef, 0.05*W3))
longThreshold = roundUpToTick(H3 + b)
shortThreshold = roundDownToTick(L3 - b)
```

Require positive range, valid instrument tick, and valid two-sided reference quotes. All terms are in rupees. Require at least three valid spread observations in that reference interval; otherwise PAPER qualification waits/fails data quality. A widening current spread remains a separate pre-entry rejection; do not enlarge the frozen buffer later.

For OHLC-only research, run a separately labeled proxy-buffer variant using `max(2*tick, 0.05*W3)`; mark reference spread and execution-book checks untested. Never present it as identical to live-mode validation.

### 6.2 Long at the 09:20 checkpoint

All conditions must hold:

1. C4 opens at or below `longThreshold` and closes at or above it. This is a breakout candle, not an already-gapped-above continuation candle.
2. C4 closes above its open; `(C4.close-C4.open)/(C4.high-C4.low) >= 0.60`.
3. `(C4.close-C4.low)/(C4.high-C4.low) >= 0.75`.
4. C4 same-minute RVOL >= 1.50, using valid comparable volume.
5. C5 closes at or above `longThreshold`.
6. C5 low >= `H3-b`; a limited wick retest is permitted, a deeper excursion fails this conservative primary variant.
7. C4 and C5 closes exceed their respective as-of broker-reported day average traded prices, with the source labeled. Current executable decision data also remains on that side.
8. Opening-five-minute RVOL >= 1.50 at the seal.
9. All source-quality, tradeability, risk, entry and first-obstacle checks pass.

C5 can be red or have lower volume than C4. Holding location matters more than candle color or continually increasing volume.

### 6.3 Short: exact mirror

1. C4 opens at or above `shortThreshold` and closes at or below it.
2. C4 closes below its open; `(C4.open-C4.close)/(C4.high-C4.low) >= 0.60`.
3. `(C4.high-C4.close)/(C4.high-C4.low) >= 0.75`.
4. C4 same-minute RVOL >= 1.50.
5. C5 closes at or below `shortThreshold`.
6. C5 high <= `L3+b`.
7. C4/C5 closes and pre-entry price are below their corresponding VWAP/average-price observations.
8. Opening RVOL >= 1.50 and all remaining eligibility checks pass; short eligibility must satisfy the app's intraday restrictions.

Zero-range bars fail candle-quality calculations. Equality at the buffered threshold passes; equality at VWAP does not. Use tick-aware numerical comparisons rather than arbitrary decimal rounding.

### 6.4 What does not qualify

- C4 only wicks across the level but closes inside: `NO_BREAKOUT_CLOSE`.
- C4 participation below 1.5: `WEAK_BREAKOUT_VOLUME`, even with strong total opening volume.
- C4 weak body/close: `WEAK_BREAKOUT_CANDLE`.
- C5 closes inside the buffered threshold: `HOLD_NOT_CONFIRMED`.
- C5 penetrates deeper than permitted: `HOLD_TOO_DEEP`.
- Missing matching history: `INSUFFICIENT_VOLUME_HISTORY`.
- Sequence first starts in C5: `WAIT`; no primary 09:20 confirmation.
- Already above/below the threshold at C4 open: outside this primary variant; do not force-fit it.

These exclusions are choices for a clean starting strategy. Record otherwise interesting patterns for later research instead of changing the definition ad hoc.

## 7. Which high-volume candle was broken?

Show this evidence even though it does not choose the primary reference:

- Largest raw-volume candle among C1-C3; ties select the earliest.
- Largest same-minute-RVOL candle among C1-C3; ties select the earliest.
- Their high, low, body, volume share and RVOL.
- Whether C4 crossed each candle's high/low from the appropriate side.
- Whether C5 held outside each of those candle levels.

A first-three-minute range break necessarily clears all the first three highs/lows in that direction. The high-volume candle identifies context; clearing its high is not a second independent signal to score again.

If the highest-volume candle is C4 or C5, identify it as a later observation. Do not retroactively select it as C4's reference. A standalone high-volume-candle strategy must freeze its own earlier reference and use a separate strategy ID and evaluation cohort.

Breaking a smaller high-volume candle while still inside H3/L3 is `INTERNAL_LEVEL_BROKEN`, not the primary breakout. Do not market it as confirmed range escape.

## 8. Entry, stop, risk and targets

`CONFIRMED` describes observed pattern evidence. It does not mean an order filled or guarantee continuation.

For the primary long, set the structural stop to `min(C4.low, C5.low)-b`, rounded down to tick. For a short use `max(C4.high, C5.high)+b`, rounded up. Do not move it to the reference midpoint merely to fit the budget. Reject unsuitable risk width under existing limits.

Let `T` be the directional buffered threshold and `S` the structural stop:

```text
structuralRiskAtThreshold = direction * (T-S)   // direction +1 long, -1 short
maxChaseDistance = 0.50 * structuralRiskAtThreshold
direction * (expectedEntry-T) <= maxChaseDistance
```

Require positive structural risk. Also respect the existing slippage limit against a separately frozen quote-based entry anchor at `decisionAt`. Do not reset that anchor on every tick, which would allow unlimited chasing. Store reference threshold, confirmation close, entry anchor, expected fill, and actual fill as different fields.

Use ask plus estimated slippage for a long, bid minus slippage for a short. Recheck current price beyond T, current VWAP side, quote freshness, spread, circuit room, margin/risk availability, and pending/open exposure before submitting a paper order and before filling it.

Candidate first target is 2R from expected entry, capped conservatively before the nearest known obstacle in the trade direction. The risk unit here is expected entry to structural stop. Obstacles initially include previous-day high/low and applicable circuit room; additional levels must be specified in advance, never selected using later price action. Deduct a price buffer from a long obstacle or add it to a short obstacle. Reject obstacles already inside the entry area.

Require **net reward to this first target / net stop risk >= 1.5**, in addition to the current plan's net blended-target test. An unconstrained 2R target is a hypothesis, not evidence that price will reach it. Do not enlarge targets until the trade passes. Secondary-target behavior can retain the app's split-exit convention if consistent with intervening obstacles and circuit limits.

Retain current risk budgets and global maximum positions/trades. Size conservatively including estimated stop-side costs; if adjusting the shared sizing function would affect other strategies, scope the additional cost-aware cap to this strategy first.

Reject a too-distant entry with `EXTENDED_ENTRY`. No entry at or after 09:21 for the primary variant. Once entered, existing position management remains responsible for exits; a diagnostic failed pattern is not permission to bypass the broker/ledger's exit handling.

One primary attempt per symbol/side/session. Deduplicate against positions and pending orders from other strategies, including the separate gap flow. Never flatten an unrelated existing position merely because this new setup fails.

## 9. Later variants: separate experiments

### 9.1 Full five-minute range, close-and-hold

Freeze H5/L5 after C5 and a new buffer using the same dimensional formula with W5 and the last 30 seconds of pre-09:20 spreads. Opening RVOL must already pass. Evaluate completed post-09:20 bars against this fixed reference.

Require the same breakout body, close location, same-minute RVOL, VWAP and one-following-candle hold criteria. Earliest normal confirmation is 09:22. Expire before 09:25, or earlier if the global window closes. A finalization delay that takes confirmation past expiry means no entry.

Do not place the old one-tick trigger order at 09:20 while claiming this stricter strategy waits for a hold. The candidate is not an executable order until confirmation and revalidation pass.

### 9.2 Retest variant

Shadow-only initially; separate strategy identity. After a valid breakout candle, allow up to two completed pullback candles and one completed recovery candle, all before the variant deadline.

For a long: retest zone is `[referenceHigh-b, referenceHigh+b]`; a pullback candle must intersect it, no pullback low may fall below its lower edge, and no pullback close may fall below the unbuffered reference high. Mirror for shorts.

Define `pullbackParticipationRatio = mean(same-minute RVOL of pullback candles) / breakoutMinuteRVOL`. Start with <= 0.70. This compares equal-duration normalized bars; do not compare total volume from two pullback minutes directly with one breakout minute.

Recovery long: closes above the upper retest-zone edge and above the prior pullback candle's high, has a positive directional body >= 0.50 of range, and minute RVOL >= 1.20 and greater than mean pullback RVOL. Mirror for shorts. Keep all data and feasibility checks. Retest stop sits beyond the observed retest extreme plus buffer.

A return deep into the original range is a failed attempt, not a retest. Never silently switch a failed primary hold into a successful primary trade because the retest experiment later works.

### 9.3 Other references

C1-only and largest-RVOL-candle references are shadow comparisons after the primary implementation works. Do not combine multiple reference choices into an OR condition that selects whichever happened to succeed.

## 10. Worked examples: hypothetical, not recommendations for real symbols

All examples use valid comparable data and hypothetical instruments. Confirmation examples establish pattern eligibility only; actual orders still depend on costs, depth, risk and available slots.

### A. Long confirmed at the 09:20 checkpoint

Assume tick INR 0.05, reference median spread INR 0.10, prior-session opening median 160,000 shares. Minute baselines below are their separate medians.

| Bar | Open | High | Low | Close | Volume | Same-minute baseline | RVOL |
|---|---:|---:|---:|---:|---:|---:|---:|
| C1 09:15 | 100.00 | 101.00 | 99.80 | 100.50 | 100,000 | 60,000 | 1.67 |
| C2 09:16 | 100.50 | 101.20 | 100.30 | 100.90 | 55,000 | 35,000 | 1.57 |
| C3 09:17 | 100.90 | 101.10 | 100.50 | 100.80 | 45,000 | 25,000 | 1.80 |
| C4 09:18 | 100.80 | 101.85 | 100.75 | 101.75 | 50,000 | 25,000 | 2.00 |
| C5 09:19 | 101.75 | 101.90 | 101.35 | 101.60 | 35,000 | 20,000 | 1.75 |

- H3=101.20, L3=99.80, W3=1.40.
- Buffer: tick-round-up of max(0.10, 0.10, 0.07) = 0.10. Long threshold=101.30.
- C4 body/range=(101.75-100.80)/(101.85-100.75)=86.4%.
- C4 close location=(101.75-100.75)/1.10=90.9%; RVOL=2.00.
- C5 close 101.60 >=101.30; low 101.35 >=101.10. Red C5 still passes the hold.
- Opening volume=285,000; opening RVOL=285,000/160,000=1.78125.
- Assume C4 and C5 reported average prices are 100.85 and 100.95; both closes are above their own contemporaneous values.
- Structural stop=min(100.75,101.35)-0.10=100.65.
- Threshold-based risk=0.65; max chase=0.325, so expected entry must be <=101.625 (effectively <=101.60 on a 0.05 grid).
- An expected paper fill of 101.60 can qualify if the separate entry-anchor slippage and costs pass. Risk/share=0.95; gross 2R target=103.50. A known obstacle at 102.50 could make first-target net R:R inadequate and block the trade.

Raw-volume leader is C1, but same-minute-RVOL leader among C1-C3 is C3. C4 breaks the full first-three-minute high, so these are context rather than extra confirmations.

### B. Full five-minute range is still WAIT at 09:20

Assume H5=202.00, L5=200.00, buffer=0.10 and opening RVOL=1.80. At 09:20 the full-range long threshold becomes 202.10. It has not been broken and held after formation.

- 09:20-09:21 bar: O=201.90, H=202.55, L=201.85, C=202.50; RVOL=1.80. Body=85.7%, close location=92.9%: breakout passes.
- 09:21-09:22 bar: O=202.50, H=202.60, L=202.15, C=202.35; closes above 202.10 and holds above 201.90.
- With matching VWAP, data and risk checks, earliest confirmation is after the 09:22 bar finalizes. No 09:20 entry is attributed to this strategy.

### C. High opening volume, weak breakout volume

Opening RVOL=2.10, but C4 volume=20,000 against its same-minute median 25,000: C4 RVOL=0.80. Even if C4 and C5 close beyond the level, primary result is `WEAK_BREAKOUT_VOLUME`. Heavy C1 activity cannot substitute for C4 participation.

### D. High breakout volume followed by rejection

Reference high=101.20, buffer=0.10. C4 has RVOL=3.00 and otherwise passes. C5 closes at 101.05, below both 101.30 threshold and 101.20 reference. Result: `HOLD_NOT_CONFIRMED`; no trade. If C5's own RVOL is 2.50, show strong contrary participation, not an assertion about institutional selling.

### E. A quiet retest succeeds in the separate experiment

Reference high=300.00, buffer=0.15, zone=[299.85,300.15]. A valid breakout minute has RVOL=2.00.

- Next pullback: O=300.50, H=300.55, L=300.05, C=300.20; RVOL=0.90. The zone is touched, the reference holds, and participation ratio=0.90/2.00=0.45.
- Recovery: O=300.20, H=300.80, L=300.15, C=300.70; RVOL=1.40. Close exceeds 300.15 and prior pullback high 300.55; body/range=76.9%.
- Retest experiment can confirm after recovery completion if still before expiry and other conditions pass. Label this `RETEST`, not primary close-and-hold.

### F. Pattern passes, entry has become too expensive

Use Example A: threshold=101.30, stop=100.65, max chase distance=0.325. At actual order evaluation, ask plus slippage implies entry=102.00. Distance from threshold=0.70, so result is `EXTENDED_ENTRY`; no order, even if the chart still looks strong.

### G. Short confirmed at the 09:20 checkpoint

Assume first-three-minute H3=502.00, L3=500.00; tick=0.05 and median spread=0.10. Buffer=0.10; short threshold=499.90.

- C4: O=500.30, H=500.40, L=499.40, C=499.50; volume=75,000, same-minute baseline=40,000, RVOL=1.875. Directional body=80%; short close location=90%.
- C5: O=499.50, H=499.85, L=499.30, C=499.60. Close <=499.90; high <=500.10. A green hold candle can pass.
- C1-C3 total volume=240,000 and C5 volume=45,000: opening total=360,000. Against median 220,000, opening RVOL=1.636.
- Assume contemporaneous VWAP values 500.40 and 500.20: C4/C5 are below them.
- Stop=max(500.40,499.85)+0.10=500.50. Threshold risk=0.60; max chase=0.30. Expected entry=499.65 is 0.25 below threshold and passes this limit.
- Risk/share=0.85; gross 2R target=497.95. Apply actual costs, lower obstacles, circuit and short-eligibility checks before any paper fill.

### H. C5 is the first breakout

C4 does not break H3; C5 closes beyond it on 2.0 RVOL. At 09:20 there is no subsequent completed hold candle. State is `WAIT`, with next event explicitly shown. Do not enter under the primary C4/C5 strategy. A later strategy may qualify under its own frozen reference and identity.

## 11. States, UI, ranking and reason codes

Keep three distinct dimensions:

1. Pattern state: `BUILDING`, `SETUP_READY`, `BREAK_OBSERVED`, `WAITING_HOLD`, `CONFIRMED`, `INVALIDATED`, `EXPIRED`, `DATA_INSUFFICIENT`.
2. Execution decision: `WAIT`, `BUY`, `SELL`, `NO_TRADE`, with explicit blockers.
3. Order lifecycle: `NONE`, `PENDING`, `FILLED`, `CANCELLED`, etc., owned by the existing ledger.

| Event | Pattern state/action |
|---|---|
| Required reference bars incomplete | BUILDING |
| C1-C3 valid and reference frozen | SETUP_READY |
| C4 qualifies | WAITING_HOLD, executable decision WAIT |
| C4 fails primary definition | INVALIDATED for this attempt; retain failure evidence |
| C5 qualifies but opening RVOL/history fails | Pattern evidence retained, no executable order |
| C4/C5 and required data pass | CONFIRMED; still evaluate execution blockers |
| Confirmed but no free slot, poor R:R, spread or chase | NO_TRADE with blocker; confirmation is not erased |
| Pending entry gets a fresh price back inside buffered threshold | Cancel/invalidate pending attempt |
| Deadline reached | EXPIRED if not filled; existing positions continue normal management |
| Unreconciled reconnect or restart gap | DATA_INSUFFICIENT; do not fabricate the missing hold |

The existing confirmation score can remain visible as legacy context. For the new strategy, start with explicit gates and deterministic ranking rather than another weighted score. Do not require its legacy `minScore=70` automatically: that would reintroduce unrelated correlated conditions. Keep the old threshold behavior unchanged for old strategies.

Rank new eligible candidates by: higher first-target net R:R; then higher breakout RVOL capped at 3.0 for ranking; then lower spread; then symbol for deterministic ties. Show that this is a selection rule, not a success probability. Compare with legacy ranking during research. Do not pool unrelated score scales silently.

First release evaluates the new strategy in shadow alongside the current selected strategy portfolio. Opt-in PAPER selection should explicitly select the new primary strategy for the same candidate cohort; do not automatically run both against the same symbol. Apply shared capital and risk limits whenever strategies coexist.

Suggested scanner columns: state, strategy, direction, reference interval/level, breakout minute/RVOL, opening RVOL, hold result, VWAP side, source quality, executable decision and main blocker. Detail view shows the five candles with volume, the frozen level and buffer band, and the exact next event required.

Example row: `WAIT | 3-minute break | LONG | 101.30 | C4 RVOL 2.00 | needs C5 close >=101.30; low >=101.10`.

Use “pattern confirmed on sampled prices” where applicable, rather than “guaranteed sustained” or “institutional buying confirmed.” Never turn missing data into a green check.

## 12. Suggested result and audit contract

This is a conceptual schema, not generated implementation code:

```text
strategyId, strategyVersion, settingsHash, sessionDate, symbol, direction
patternState, executionDecision, reasonCodes[], eligible, rank
reference: type, startAt, endAt, frozenAt, high, low, buffer, threshold
breakout: candleStartAt, availableAt, OHLCV, bodyRatio, closeLocation, minuteRvol
hold: candleStartAt, availableAt, OHLCV, closeBeyond, wickDepth, accepted
volume: openingActual, openingBaseline, openingRvol, statistic, historyDays,
        minuteBaseline, auctionPolicy, source, lowerBound, upperBound
vwap: source, auctionPolicy, breakoutValue, holdValue, currentValue
quality: approximate, complete, lastQuoteAge, lastTradeAge, gap/reset flags
highVolumeReference: rawLeader, normalizedLeader, frozenCandidateSet
decisionAt, expiresAt, entryAnchorAt, entryAnchor, maxEntry, invalidation
plan: entryEstimate, stop, target1, target2, firstTargetNetRR, blendedNetRR, qty
audit: observedAt, receivedAt, revision, dataMode, exclusions, untestedChecks
```

Persist the actual source inputs necessary to replay each decision. Stable attempt/order identity must include date, symbol, side, strategy version and reference cutoff. Repeated ticks, duplicate seal callbacks, retries and reloads must not create duplicate orders.

Persist confirmation events separately from the immutable 09:20 sealed snapshot. For later variants, restart restoration must load the last state and replay available events in original receipt order. If there is an unrecoverable missing interval, block that attempt. Never backfill an order at a historical timestamp.

## 13. Implementation sequence for the receiving agent

This document specifies future work only. Before modifying code, inspect `git status`, `CLAUDE.md`, `DEVLOG.md`, and current repository instructions. Coordinate around the logged work in progress. Follow the repository's milestone/checkpoint procedure. Do not overwrite user changes or start/stop the user's backend merely to inspect this plan.

### Milestone A: data contract and shadow primary

- Extend historical cache/schema with versioned median opening and per-minute baselines, valid-day counts, provenance and policy.
- Add pure candle/reference/volume/quality calculations, preferably in a focused utility such as `src/utils/breakoutConfirmation.js`; reuse existing calculations instead of duplicating them.
- Integrate primary C4/C5 evaluation at the existing seal, returning shadow decisions only.
- Add evidence display and reason codes; no change to existing order placement.
- Add fixtures for boundaries, uncertain volume and all primary examples.

### Milestone B: opt-in PAPER primary

- Complete volume-source reconciliation and document remaining sampled-price limitations.
- Add settings validation and explicit selection of this strategy for paper execution.
- Adapt decision/planning integration so only confirmed, executable results can reach paperBroker.
- Add fresh-quote revalidation, deadline, risk-slot reservation, deduplication and persistence.
- Preserve 09:15 gap checks and unrelated live scheduled-order paths.
- Keep legacy and new outputs distinguishable in exports and report cards.

### Milestone C: post-09:20 stateful variants

- Add a rolling minute stream separate from the immutable opening-window object.
- Keep receiving/recording candidates needed for confirmation, even with no open position yet.
- Serialize bar finalization, state updates, risk reservation and order submission to avoid async races.
- Extend recording beyond entry expiry far enough to replay exits/outcomes; record through at least 09:40 for the initial 15-minute outcome study, or use explicitly labeled later candle outcomes if tick recording is unavailable. The current 09:25 record cutoff is not enough for this evaluation.
- Add full-five-minute and retest shadow variants with independent identities and expiry.
- Restore unresolved candidates safely after restart; update collector subscriptions and `keepTokens` behavior if necessary.

### Milestone D: research and promotion

- Reuse the shared decision functions in replay/backtests; do not hand-code a more permissive historical version.
- Produce chronological comparisons, costs, uncertainty and parameter sensitivity.
- Recommend whether to retain, adjust or reject the defaults based on out-of-sample results.
- Leave live execution unavailable for this feature unless a separate explicit scope authorizes it.

## 14. Meaningful acceptance tests

At implementation time, add focused tests to the current Node test suite and include any new test file in `package.json`.

1. C1-C3 reference is frozen before C4; C4/C5 cannot change it.
2. 09:20 exchange-time observations never enter C5; receipt-time availability is enforced.
3. Full-range post-break confirmation cannot exist at 09:20.
4. Example A passes pattern gates; lower-volume red C5 is accepted.
5. Example G mirrors long arithmetic and passes short pattern gates.
6. Opening RVOL passes but breakout RVOL fails: no order.
7. Wick-only break, deep hold wick and close-back-inside each produce correct reasons.
8. C5 first breakout remains WAIT, never primary CONFIRMED.
9. Exactly-on-threshold prices use documented inclusive comparison; VWAP equality fails.
10. Zero-range bars, nonfinite values, zero baselines, and fewer than 15 historical days fail safely.
11. Duplicate historical minute rows do not masquerade as five complete unique bars.
12. Missing auction reconciliation, first-tick baseline, resets and boundary-ambiguous increments cannot falsely qualify volume.
13. Approximate bars retain their qualifier through UI, storage, replay and export.
14. Future/current-day history is excluded; means and medians remain distinguishable.
15. Stale/wide/crossed/missing quotes prevent entry; shrinking risk slots are rechecked at submission.
16. Chasing cannot be hidden by updating the frozen entry anchor; Example F is rejected.
17. First-obstacle R:R can reject a plan even if blended distant targets pass.
18. Duplicate ticks/seal callbacks and restart restoration generate at most one attempt/order.
19. Waiting post-09:20 candidates remain subscribed without already having an order.
20. No fills before actual confirmation availability; same-bar stop/target ambiguity is disclosed.
21. Deadline equality expires; a late finalization cannot create a backdated fill.
22. Legacy decisions/settings/caches load compatibly and existing gap/scheduler behavior is unchanged.

Run targeted tests, then the repository-required test/build/platform checks for the actual implementation. Do not claim market-hour validation from synthetic tests.

## 15. Research design: deciding whether this improves the app

First verify that signals and sources are reproducible. Then compare the existing ORB, the new three-minute primary, a volume-only version, the hold addition, and later full-range/retest variants. Hold the candidate universe and fill assumptions constant where possible; record when entry time itself changes the comparison.

Predefine two outcome views:

- Pattern study: from the first executable post-confirmation quote, does +1R occur before -1R within 15 minutes? Count horizon expiry separately. If both are reached in one OHLC bar with unknown order, report ambiguous or use a declared conservative loss assumption.
- Trading study: actual specified stop/targets, charges, estimated spread/slippage, sizing, time stop and portfolio constraints. Report net expectancy, drawdown and trade count.

Also report return-to-range frequency within five minutes, maximum favorable/adverse excursion, confirmation-to-fill delay, missed earlier moves, stale/ambiguous-data exclusions, unfilled candidates, and exposure concentration. Net R:R is a plan metric, not realized expectancy.

Use chronological walk-forward splits. A reasonable starting research schedule is 60 sessions for development/calibration followed by 20 untouched sessions, then roll forward. Fit historical volume baselines using only information before each evaluated session. Group uncertainty estimates by session because stocks and signals on the same morning are correlated. If the trade sample is small, report inconclusive evidence rather than optimize until it looks profitable.

Limited sensitivity checks, predeclared rather than a large combinatorial search:

- Opening/breakout RVOL: 1.2, 1.5, 2.0.
- Body fraction: 0.5, 0.6, 0.7.
- Close location: 0.70, 0.75, 0.80.
- Buffer range component: 0.025, 0.05, 0.075.
- Hold: one versus two following candles, acknowledging the later entry time.
- Net first-target R:R: 1.5 versus 2.0.
- Mean versus median baseline on the same history.

Use ablation comparisons to identify incremental value, not every permutation of every threshold. Report liquidity, gap-size, long/short and market-regime breakdowns, as well as aggregate results. Include all candidates available at the time; do not backtest only today's surviving watchlist or the eventual winning stocks.

Promotion requires matched live/historical volume semantics, repeatable as-of replay, an intact risk/order lifecycle, and stable out-of-sample behavior after costs across nearby parameters. If improvement is not convincing, keep the legacy behavior selected and retain the new evidence display as research support.

## 16. Sources and limits of the recommendation

- [Kite Connect WebSocket documentation](https://kite.trade/docs/connect/v3/websocket/) describes streaming quote fields, cumulative volume, average traded price and market depth. It supports the feed contract; it does not establish these strategy thresholds or complete trade-tape coverage.
- [Kite Connect historical candle documentation](https://kite.trade/docs/connect/v3/historical/) documents timestamped OHLCV and supported intervals. Auction-volume equivalence and real-time finalization timing still require verification for this app's use.
- [StockCharts Relative Volume](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/relative-volume-rvol) explains historical volume comparison, time-of-day variants and the need to interpret volume with price. It does not validate an NSE-specific 1.5x threshold.
- [TradingView VWAP documentation](https://www.tradingview.com/support/solutions/43000502018-volume-weighted-average-price-vwap/) explains volume-weighted price and its lag. A candle-derived approximation must remain distinguishable from the broker's reported average price.
- [Schwab: volume and price trends](https://www.schwab.com/learn/story/ways-volume-can-help-confirm-price-trends) discusses participation as supporting evidence. It is general background, not evidence that a particular opening strategy is profitable.

The three-minute reference, C4/C5 sequence, median baseline, 1.5x volume thresholds, 60% body, 75% close location, buffer, deadlines, chase limit and retest ratio are proposed research choices. They need the app's own historical and forward-paper evidence. No volume or candle rule can establish in advance that price will continue to sustain.
