# Analyzer review — 21 October 2026

The most useful next feature is a **saved, explainable daily shortlist with an honest outcome comparison**. The Analyzer already has many indicators. Its larger opportunity is to make the evidence behind each selection trustworthy, reproducible, and measurable.

This is a source-level review of the Analyzer UI, every scoring/filtering module it calls, acquisition and persistence paths, exports, Android differences, and the handoff to confirmation/reporting. It is not a market-hours execution test or a visual browser acceptance test. No trading code, settings, live orders, or existing uncommitted work were changed. Findings describe this checkout, not another running copy of the project.

## 1. Complete functional map

| Area | Implemented logic and important boundaries |
|---|---|
| Master list | Loads a saved upload, otherwise bundled `public/master_stock.csv`. CSV and the first XLSX worksheet are supported. Upload validation requires `Symbol` and `Industry`; company name and market cap are optional. Symbols are uppercased for joins. Market cap is assumed to be in crores. Uploaded lists persist through the platform API; reset restores the bundled list. Duplicate master symbols overwrite earlier values in the join maps. |
| Pre-open input | Backend schedule defaults to 09:10 IST; manual fetch runs the same job. NSE fields are normalized into CSV-style rows, with rupee values converted to crores. A successful snapshot is persisted, published by SSE, and offered to the recorder. Overlapping fetches share a request; failures retain the previous successful snapshot. CSV upload is local to the browser analysis and is not automatically archived by the backend recorder. |
| Input switching | A new NSE snapshot, identified by `fetchedAt`, replaces the currently displayed rows, including a manual upload. Source changes reset search, sector/status filters and the expanded sector; they do not reset every filter or sort setting. |
| Dates and context | NSE snapshots use the exchange timestamp to derive a trading date. Uploaded CSVs have no date selector and request today's context. Context supplies completed-session price/volume/delivery history, corporate events, futures OI, market readings, stored pre-open baselines and desktop auction features. |
| Universe and breadth | Only symbols in the master list enter the analysis. Positive `CHANGE` means advance, negative means decline, zero or missing means unchanged. Summary counts, A/D ratio and sector counts use this joined universe. No declines gives infinity when advances exist, otherwise null. Search and table filters do not recompute these summaries. |
| Circuits | Numeric bands come from NSE's security list. Base price is the positive NSE base price, otherwise previous close. Limits are derived with price-slab tick sizes: upper rounded down, lower up. `No Band` is treated as F&O/dynamic bands. The displayed limits are estimates from these inputs, not necessarily an authoritative current broker quote. |
| Data consistency | `FINAL PRICE` is checked against base plus `CHANGE`, with 0.05% of base tolerance. A mismatch adds `Data?` and suppresses conviction. This check does not validate `%CHANGE`, uniqueness, all required columns, positive prices, or every numeric domain. |
| Tradeability | BE/BZ and touching an estimated circuit produce blocking flags. Data mismatch, non-EQ series, surveillance, ex-date and less than 2% room to the directional circuit are warnings. `isTradeable` means only that no block flag exists. Unknown eligibility therefore passes. |
| Signals | Results since the previous close; results due today; ex-date; pre-open volume relative to daily volume; gap beyond previous high/low; delivery surge; close location; 5/20-session returns; and price/OI build-up. Signal badges have their own visibility thresholds. |
| Market panel | GIFT Nifty, previous-session VIX change and FII/DII net flows. The research disclosure additionally shows VIX relative to its history, Nifty return, flow z-score, cumulative 5/20-session flows and buying-day counts. Market-wide readings cannot distinguish stocks on the same side unless availability or normalization differs. |
| Conviction | 27 configurable factors; 4 enabled by default. Direction comes from advance/decline. Gaps below 0.5%, unchanged rows and detected inconsistent rows get no conviction object. Available active factors are weighted and rescaled; score is rounded to an integer. A block caps it at 30. Missing and switched-off factors are listed in the tooltip. |
| Factor controls | Individual toggles, weight sliders/boxes, all-factor toggle, History/Auction group toggles and reset. Weights are clamped to 0–100; turning on a zero-weight factor restores its default. Display shares sum to 100. Settings persist locally; changed factors are debounced for 500 ms and sent to the backend, with 15-second failure retries and reconnect retry. Startup deliberately does not push local factors. |
| Separate History score | Equal average of available History factors, minimum two. Uses the conviction object's gap eligibility but is not capped for tradeability. Hiding its column does not switch its factors off. Its factors join conviction only when enabled there. |
| Separate Auction score | Equal average of at least two of the five stock-specific Auction factors. Nifty futures is excluded from this separate score, but can be enabled in conviction. Requires auction recordings; column visibility and factor activation are independent. |
| Top five movers | Starts with stocks with known market cap at or above the floor (default ₹5,000 Cr) and known percentage change. Optional tradeable-only filter defaults on. Ranks each direction by absolute gap or conviction, with absolute gap breaking conviction ties. Missing conviction does not itself exclude a stock. The main table and stock screener do not inherit this market-cap floor. |
| Main stock table | Search symbol/company, sector filter, advance/decline filter, independent tradeable-only switch. Sorts numerically or as strings, with missing values last either way. Optional History/Auction/research columns. The Signals header sorts by `rvolX`; Circuit sorts by `bandPct`. |
| Stock filter | Independent settings and universe. Includes every non-unchanged stock, even below the conviction minimum gap. Ten metrics; gap is filtering-only and nine can enter quality rank. Blank thresholds are off; a missing value fails an enabled threshold. Minimum/maximum gap, order side, direction, tradeability and maximum global quality rank are supported. All enabled constraints are ANDed. |
| Quality rank | Average percentile of selected available metrics across all gapped stocks, requiring at least three metrics. Ties within a metric use midpoint ranking. Quality is rounded, then ties sort by value and symbol. Rank is assigned before direction/threshold filters. Changing buy/sell filter side does not change the gap-side order input to quality. Top N means global rank ≤ N, not the best N remaining matches. Only the first 200 matches render. |
| Sector table | Counts, percentages, ratio, breadth bar and optional advancing-share deviation from its stored baseline. Clicking a sector updates the main table's sector filter and scrolls there; other active main-table filters remain in force. |
| Manual export | Exports the main table's filtered/sorted rows, with Stocks, Conviction factors and Breakdown worksheets. Includes History/Auction summaries and research fields even when their columns are hidden. It does not export the stock filter's quality ranks, selected metrics, thresholds or rejection reasons. |
| Automatic export | Backend saves all stocks once per trading day from 09:30 until 15:30, with a five-minute catch-up check and backend factor settings. Phone saves through the app while open, checks every 30 seconds and tracks the date locally. This is a separate output from the manual filtered export. |
| Orders | Both top movers and stock filter call `handleTradeAction`. Quantity/product/type/etc. come from global settings. LIMIT/SL prices use offsets from pre-open price and round to two decimals. Warnings can be accepted. With a session, the handler directly submits to Kite. It does not route through the 09:20 paper broker. |
| Confirmation handoff | Confirm receives all analyzed stocks and derives its own scored-gapper list. Its Schedule action prefills Orders. The desktop opening collector independently re-analyzes backend data/settings, selects scored gaps or explicit watchlist stocks, and validates the snapshot date. Analyzer screener thresholds and quality ranks are not passed into this selection. |
| Recorder and report card | Archives the latest exchange timestamp per day, master-list version, security flags, events and market inputs. Report recomputes scores using requested factor settings and cached historical files. It compares directional close returns, best/worst excursion and gap fills; top picks by conviction, History, Auction and gap; factor correlations; and confirmation outcomes. It does not reconstruct a filled order from these end-of-day comparisons. |
| Android | Shares the analysis code but has local files/context and an app-open/resume fetch schedule with notifications. No desktop Auction collector or 09:20 paper engine. F&O backfill is disabled, so history grows incrementally. Direct Kite and scheduled-order APIs nevertheless exist on the phone; the “phone never places orders” badge text is inconsistent with those paths. |

## 2. Every conviction factor

Scores below are 0–1 before multiplication by 100. Direction `d` is +1 for advances and −1 for declines. Linear directional factors clamp to their stated bounds. Missing inputs are omitted, not treated as zero.

| Factor | Actual transformation |
|---|---|
| Gap size | 0.6 at 0.5% gap; rises to 1 at 0.75%. Full score through 2% for gap-ups or 3% for gap-downs. Tapers to 0.3 two percentage points beyond that ceiling and 0.1 six points beyond. |
| Sector strength | Half sector average-gap rank, mirrored for shorts; half count of same-direction ≥1% gappers divided by 5 and capped at 1. Sectors need five stocks to rank; smaller ones receive neutral rank. The cluster includes the stock itself. |
| Buy/sell orders | Gap-side quantity divided by total pending buy and sell quantity. Its configured weight is multiplied by 0.25 for stocks whose band is `none`. |
| Market A/D | Share of the entire analyzed universe advancing or declining in the stock's direction, including unchanged stocks in the denominator. |
| 52-week breakout | 1 at/beyond the directional 52-week extreme, otherwise 0.5. Requires valid high, low and price. |
| Pre-open value | Cross-sectional rank of traded crores, using strictly lower values divided by N−1; singleton gets 1. |
| Results catalyst | Ex-date 0; results announced 1; checked with no results 0.5. Does not measure whether results were good or bad. |
| Relative volume | Cross-sectional percentile of pre-open quantity / average daily quantity. The displayed `Vol ×` is that ratio divided by the universe's median positive ratio. It is not the stock's own historical pre-open multiple. |
| Gap versus prior range | 1 when price exceeds prior high for an advance or falls below prior low for a decline, otherwise 0.5. |
| Delivery percentage | Neutral 0.5 at normal/below-normal delivery. Directional strength increases to full at 2× normal delivery, using yesterday's move; moves below 0.25% count flat. |
| Previous close location | Position within yesterday's low/high range, mirrored for shorts. |
| Trend | 0.5 plus 0.25 times directional 5-session return / 5%, plus 0.25 times directional 20-session return / 10%; each return term clamped to ±1. Missing 20-session return reuses the short term. |
| Futures OI build-up | Directional OI strength up to 10% change; long/short build-up full strength, covering/unwinding half. Price <0.25% or OI <1% absolute change is neutral. OI sums expiries; price comes from the nearest expiry. |
| GIFT Nifty | 0.5 plus half directional GIFT percentage move, full strength at ±1%. A later same-day fallback may currently be included. |
| VIX change | Direction inverted relative to VIX change, full strength at ±10%. |
| FII/DII | Uses FII net flow only for the score, full directional strength at ±₹3,000 Cr; DII shown as context. |
| History: normalized gap | Absolute gap / own usual absolute gap. Neutral below 0.75×, rising to 1 at 1.5×, full through 3×, tapering to 0.3 at 6× and 0.1 at 10×. |
| History: delivery quantity | Direction of yesterday's move times log(delivery surge)/log(3), clamped to 0–1, around neutral 0.5. Full strength at 3×. |
| History: volume | Yesterday's volume reconstructed from delivered quantity / delivery percentage, compared with average daily volume. Directional strength above 1×, full at 2×. This daily-volume average includes yesterday; delivery-quantity comparison excludes it. |
| History: OI unusualness | Directional build-up strength scales from historical absolute-OI-change percentile 0.5 to 0.9. Covering/unwinding half strength. |
| History: sector relative strength | 20-session stock return minus sector median, directional full strength at ±10 percentage points. Sector median requires three stocks. |
| Auction: drift | Directional final indicative-gap change from the last reading at/before 09:04, divided by max(abs(early gap), 0.5 points). Requires two minutes between early and final readings. |
| Auction: orders held | Final buy share minus average buy share, directionally mirrored; full strength at 10 percentage points. At least three usable shares for the average. Currently includes post-matching readings. |
| Auction: unmatched demand | Signed imbalance / matched quantity, full directional strength at 1×. Uses the inferred close-of-entry reading; negative imbalance explicitly means sell, otherwise side is inferred from buy/sell totals. |
| Auction: futures versus cash | Near-month futures gap minus cash gap; full directional strength at 0.5 points. Future needs positive matched volume. |
| Auction: circuit room | Directional distance from indicative price to Kite limit divided by 3%, clamped to 0–1. |
| Auction: Nifty futures | Directional Nifty futures indicative gap, full strength at ±1%; Bank Nifty displayed for reference. Not in the separate Auction score. |

Default conviction weights are gap 15, orders 100, value 100 and relative volume 100, totaling 315. Everything else is off. With all four available, ordinary-stock shares are about 5%, 32%, 32%, 31%. F&O effective weights become 15/25/100/100, so the per-stock shares differ materially from the generic controls.

Research columns additionally expose own pre-open volume/value multiples, own historical gap multiple, delivery-quantity multiple, relative return to sector/Nifty, OI percentile, and sector advancing-share deviation. These columns are not automatically added to conviction, although some underlying measurements also feed optional History factors.

## 3. Issues to address before adding more signals

### A. Make the execution mode truthful and consistent — highest priority

`src/App.jsx:883` submits direct Kite orders from Analyzer. `src/TradingPanel.jsx:17` says PAPER means no real orders. The badge describes one subsystem while these buttons use another. A row without flags and with a session submits immediately; a block flag is only an overrideable confirmation. There is no in-flight button lock, stale-snapshot gate or tick-size rounding in this handler.

Recommended behavior: an Analyzer action creates a reviewable draft with explicit **Live manual order** mode, source date, current quote, actual tick size, product eligibility and risk sizing. Route submission through one shared order service with request deduplication and persisted order IDs/status. Reuse existing scheduler/unknown-outcome handling instead of inventing a second retry mechanism. The current Kite client already warns when the submission outcome is unknown; retain that protection.

Kite explicitly distinguishes successful placement from execution, and exposes order history/trades: [official order documentation](https://kite.trade/docs/connect/v3/orders/). Its instrument dump supplies `tick_size`: [official instrument documentation](https://kite.trade/docs/connect/v3/market-data-and-instruments/).

### B. Add score coverage and a common eligibility gate

Reproduced: a 1% gap with orders, value and relative volume missing receives **100 conviction using only the gap factor**. It has 15/315, or 4.8%, of the configured ordinary-stock weight available. The tooltip lists omissions, but the headline score looks fully supported.

Reproduced: an inconsistent row gets no conviction but still passes `isTradeable` and the screener's tradeable-only option because `Data?` is a warning. Separate History/Auction scores are also not tradeability caps. These are different semantics presented with similar score styling.

Add separate fields for signal strength, applicable-weight coverage, freshness and execution eligibility. Suppress the actionable shortlist below a documented minimum coverage; do not arbitrarily treat all missing data as bearish. Distinguish “not applicable” (for example futures for a non-F&O stock) from “expected feed missing.” Display why a row is blocked or incomplete.

Evidence: `src/utils/conviction.js:451`, `src/utils/conviction.js:466`, `src/utils/tradeability.js`, `src/utils/screener.js`.

### C. Bind all data to one trading date and cutoff

Uploaded CSVs silently use today's context (`src/App.jsx:214`). A new snapshot can temporarily be analyzed with the prior `marketContext`; failed context fetches keep that old object. Price bands are fetched only at component mount, independently of the displayed snapshot date. A fresh NSE event can also overwrite a manual upload.

Corporate events are cutoff-filtered only for historical dates; today's query has no morning cutoff (`src/core/marketContext.js:556`). A same-day GIFT fallback after pre-open can enter the score. Consequently, viewing the same pre-open later can introduce information unavailable at the original decision time.

Require or infer an explicit CSV trading date. Create one immutable analysis input object containing snapshot ID, trading date, decision cutoff, master version, source timestamps and factor version. Commit it to the UI only after date checks; show a loading/incomplete state while preparing it. Offer a deliberate “as known at the open” versus “updated research” view. Preserve historical band snapshots or clearly mark estimates unavailable.

### D. Correct Auction phase handling

> **Update, 21 Oct 2026 (later the same day):** fixed. Drift and orders-held are now measured over order entry
> only: the gap and buy share at the close-of-entry reading, and the average buy share over readings up to it
> (`auctionEntry` in `src/utils/auctionLayer.js`). Final post-matching values are kept separately (`gap`,
> `buyShare`). With fewer than three entry readings there is no orders-held reading. The repro script now
> reports `heldScore: null` for the counter-example below. Per-batch receipt times and a confidence label for the
> inferred boundary are still open.

The tracker records until approximately 09:09:45. `closeOfEntryAt` estimates the close from the last sweep with at least half the peak count of non-zero imbalances. Only imbalance and its related quantities use that close reading. Drift and orders-held still use `last`; average order share includes all readings (`src/utils/auctionLayer.js:98`).

Reproduced: 90% buy share at inferred close followed by 10% after matching yields a fully negative orders-held factor. That does not establish that participants cancelled demand before entry closed. A change in share also cannot alone distinguish cancellation from changes on the opposite side.

Compute entry-phase drift/order metrics using the same phase boundary and truncate the baseline there. Preserve final equilibrium as a separate feature. Label the inferred boundary and its confidence. Store per-batch receipt times and exchange timestamps: the current sweep gives sequential quote batches one common start time. Add minimum coverage and stale-reading rules, and verify special cases where imbalances are zero or only a partial universe was captured.

The phase distinction is material: NSE documents separate order collection, matching and buffer periods, with random closure: [official pre-open description](https://www.nseindia.com/static/products-services/equity-market-pre-open).

### E. Strengthen import and universe integrity

Reproduced: two identical symbol rows count twice in breadth. A row with `CHANGE=+1`, price 100→101 and `%CHANGE=-5` is classified as advancing and scored in the up direction without `dataIssue`. Missing change is counted as unchanged. CSV validation currently only requires a nonempty body.

Validate headers, finite numeric ranges, uniqueness, sign consistency and price/change/percentage agreement. Report rejected rows and reasons. Keep invalid/unknown separate from unchanged. Make the master-list coverage denominator explicit: this is breadth of the joined universe, not necessarily all NSE equities. The UI's master-load error says sectors become Unknown, but an empty master actually excludes every row (`src/utils/analysis.js:105`, `src/App.jsx:1214`). Fix that contract.

### F. Preserve historical calendar slots and honest coverage

Missing daily files are dropped before `historyStats` uses array offsets (`src/core/marketContext.js:502`, `:517`). This can make “previous session” mean the latest available earlier session, and a supposed one-session gap span a missing session. Index history is compressed similarly. Some past 404s are remembered until service restart; history can remain partially cached even after files become available.

Reproduced separately: the pre-open baseline stores one count as `max(quantityDays, valueDays)`. One valid volume day plus five valid value days passes the five-day minimum for volume and displays five days of coverage (`src/utils/research.js:192`, `:220`).

Keep the exchange calendar slots even when files are absent; calculate lookbacks against exact session dates. Track quantity/value/price/OI coverage independently, with per-field as-of dates. Retry missing published files with bounded backoff. Use corporate-action-aware history or quarantine affected windows before trusting gap/trend/relative-strength comparisons. Avoid assuming raw split-adjusted discontinuities are demand signals.

### G. Make the stock filter measurable

Its nine rank metrics mix pending demand, traded activity, delivery and Auction evidence. A score based on three available metrics competes with one based on nine. Correlated inputs can count the same phenomenon repeatedly. Quality is distinct from conviction, and “top N” is applied before other filters. These are valid design choices only if users understand and can evaluate them.

Export all matches, quality components, raw values, coverage, thresholds, ranking settings and rejection reasons. Add named presets and a visible “Why selected / why excluded?” drawer. Offer a clearly labeled rank-within-direction option while preserving the existing stable global rank. Group related metrics so selecting several volume/delivery variants does not silently increase that family's influence. Validate any weighting change prospectively.

### H. Compare the shortlist fairly against alternatives

The report card has useful directional/day-specific Spearman analysis and factor comparisons. However, it re-scores history with current settings rather than preserving the original displayed shortlist. Its gap comparator includes blocked stocks while the conviction/History/Auction top picks filter tradeability (`src/utils/reportCard.js`, `buildReportCard`). It does not apply the Analyzer top-mover market-cap floor, and it does not evaluate screener quality at all.

Separate **original decisions** from **what-if rescoring**. Compare rankings on the same eligible universe, capital/risk limits and available dates. Retain raw close-return research, but evaluate executable variants using the existing paper/candle/tick engines with spread, charges, slippage and explicit entry/exit rules. Do not interpret daily high/low as proof a stop or target filled in a known order.

The local recorder index currently contains only 15, 16, 19 and 21 October 2026. This is a small local sample, not evidence of a stable trading edge. The latest archived snapshot has 2,278 unique symbols and an exchange timestamp of 09:08:44 IST. This checkout has no `.data/auction` directory, so recorded real-auction performance was not evaluated here. Other copies/devices may have more history.

### I. Make settings reproducible across clients

Avoiding a startup overwrite is sensible, but there is no backend configuration read/reconciliation in the Analyzer. A browser can show its local factors while the backend export and collector use another client's last saved factors. Overlapping save requests also lack a revision contract.

Store a versioned profile server-side; return the effective profile ID in analysis, collector and export results. Show local unsaved changes separately. Save with revision checks and serialize writes. Capture the profile and schema/version in every frozen shortlist. Validate migrations without discarding custom settings on newly added factor groups.

### J. Align scheduling, secrets and user interface contracts

The desktop pre-open cron runs daily, including weekends/holidays, and has no missed-run startup catch-up or scheduled-failure retry. Android does have calendar-aware due/retry behavior, but regards a recent fetch timestamp as success even if the exchange snapshot is stale. Use exchange trading date and readiness for completion and bounded retries on both platforms.

`src/store.js` persists the full settings object, including the API-secret field, and session object in localStorage. Backend memory-only behavior does not mean browser credentials are ephemeral. Move secrets to an appropriate backend/OS credential boundary and align the documented security model.

Replace hover-only score explanations with a keyboard/touch-accessible drawer. Put shortlist controls before the full universe table, add pagination/virtualization if profiling warrants it, expose all matches beyond the 200-row display cap, and clearly label independent filter scopes. Remove obsolete signal settings left in `DEFAULT_SETTINGS` that have no consumers. Separate Analyzer UI/state, profile sync and order drafting from the large `App.jsx` after the behavioral contracts are tested.

## 4. Recommended feature: saved daily shortlist

A row should answer these questions without requiring several tables:

| Question | Proposed fields |
|---|---|
| Why this stock? | Selected preset, raw threshold values, factor contributions, relative rank and inclusion reason. |
| Is the evidence complete? | Source trading dates, last exchange/receipt time, applicable coverage, missing feeds, input validation and Auction phase confidence. |
| What is the hypothesis? | Continuation candidate, possible fade, mixed evidence or insufficient data. These are research labels until validated. |
| What happens next? | Watch, send to Confirm, prepare a paper/live draft, or block with a specific reason. |
| Can we reproduce it? | Snapshot ID, master version, factor/profile version, filter settings, scoring-code version and immutable selection timestamp. |
| Did it help? | Frozen membership, subsequent confirmation, specified-horizon returns, adverse/favorable excursion, simulated executable net return and actual fills where available. |

Suggested sequence:

1. **Correctness first:** execution labels/gate, input schema, date binding, coverage, Auction phase and historical-slot fixes. Acceptance: the counterexamples below become explicit incomplete/invalid states rather than misleading rankings.
2. **Daily shortlist:** profile persistence, immutable snapshot, explanation drawer, complete export and handoff to Confirm. Acceptance: reopening a saved shortlist reproduces its membership, metrics and reasons exactly.
3. **Evaluation:** compare conviction, quality, History, Auction and simple baselines on identical eligibility. Freeze rules before evaluating future sessions; report number of independent days, costs, drawdown and uncertainty. Assess correlated factor families and long/short sides separately.
4. **Evidence-led additions:** test own-stock pre-open volume, Auction persistence and market-regime splits using data already collected. Add a feature to the production rank only when the prospective comparison supports it. Do not choose new weights from the same few days used to judge them.

## 5. Verification and review artifacts

Read the current implementations in `App.jsx`, `StockScreener.jsx`, `ResearchColumns.jsx`, `HistoryLayer.jsx`, `AuctionLayer.jsx`, `store.js`; utilities for CSV/master/analysis/conviction/signals/tradeability/research/history/Auction/screener/exports/report card; core pre-open/context/price bands/Auction/recorder/calendar; web and Android adapters; backend pre-open/routes/auto-export; and the relevant confirmation, collector, mode-badge and Kite submission handoffs.

Ran 13 related test files: **98 tests, 97 passed and 1 failed** in the workspace-temp run. The failure was Windows `EPERM` on a temporary JSON-file rename. An isolated pre-open rerun passed 6/7 with a rename failure in a different test. This suggests an environment/filesystem interaction, but the suite is not fully verified green; no production defect is claimed from that error alone. An initial default-temp run had additional similar permission failures. No live API order tests were run.

The accompanying `analyzer-review-repro.mjs` uses synthetic inputs and read-only archive metadata to demonstrate sparse-score inflation, inconsistent-row eligibility, contradictory percentage acceptance, duplicate breadth, Auction phase mixing, baseline count inflation and compressed-history behavior. All its assertions passed. These are targeted counterexamples, not a claim that every row in today's data exhibits them.

No application implementation changes were made. Existing modified/untracked work on Vite and backtest downloads was preserved. Market-hours data availability, actual order submission/fills, Android UI, and end-to-end browser behavior remain unverified by this review.
