import {
  BLOCKED_SCORE_CAP, CONVICTION_FACTORS, FNO_ORDERS_SHARE, GAP_SWEET_SPOT, MIN_GAP_PCT, FACTOR_DEFAULTS_VERSION,
} from '../../../src/utils/conviction.js';
import { HISTORY_FACTORS, MIN_HISTORY_FACTORS } from '../../../src/utils/historyLayer.js';
import { AUCTION_FACTORS, MIN_AUCTION_FACTORS } from '../../../src/utils/auctionLayer.js';
import { MIN_QUALITY_METRICS, SCREENER_GROUPS, SCREENER_METRICS } from '../../../src/utils/screener.js';
import { MIN_ROOM_PCT } from '../../../src/utils/tradeability.js';
import { RESEARCH_DAYS, MIN_RESEARCH_DAYS } from '../../../src/utils/research.js';
import { SIZE_PEERS, MIN_GAP_DAYS } from '../../../src/utils/sizeGap.js';
import { HIGH_RVOL_X, HIGH_DELIVERY_X, NOTABLE_OI_PCT } from '../../../src/utils/signals.js';

/**
 * Factor glossary generated from the current code (the factor lists, their help
 * text and thresholds), so it can't drift from what the Analyzer computes.
 * One markdown section per topic; the indexer chunks it by heading.
 */
export const GLOSSARY_VERSION = 1;

const onOff = (f) => ((f.defaultOn ?? true) ? `on by default, weight ${f.weight}` : `off by default (weight ${f.weight} when turned on)`);

export function buildGlossary() {
  const factor = (f) => `- **${f.label}** (\`${f.key}\`, ${onOff(f)}${f.marketWide ? ', market-wide' : ''}): ${f.help}${f.source ? ` Source: ${f.source}.` : ''}`;
  const core = CONVICTION_FACTORS.filter((f) => !f.group);
  return `# Factor glossary (generated from the app's code)

## Conviction score
The conviction score (0–100) ranks each gapped stock at the 09:08 pre-open close. Every factor is scored 0 to 1 in the direction of the gap (for a gap-down, "supportive" means more sellers, a weaker sector and so on), then the factors are combined by weight. Factors whose data is missing are dropped and the remaining weights rescaled; the stock's "missing" list names them. Stocks with a gap under ${MIN_GAP_PCT}% or inconsistent pre-open data are not scored. A stock with a blocking tradeability flag (trade-to-trade series, circuit-locked) is capped at ${BLOCKED_SCORE_CAP}. For F&O stocks the buy/sell orders factor counts ${FNO_ORDERS_SHARE * 100}% of its weight, because their book holds many resting orders. The score ranks setups; it is not a probability that the gap continues and it does not predict profit. Default weights are version ${FACTOR_DEFAULTS_VERSION}; the user can change every weight in "Conviction factors".

## Conviction factors
${core.map(factor).join('\n')}

Gap size sweet spot: full marks for ${GAP_SWEET_SPOT.up.join('–')}% gap-ups and ${GAP_SWEET_SPOT.down.join('–')}% gap-downs; bigger gaps taper.

## History layer and History score
The History layer has ${HISTORY_FACTORS.length} factors built only from the 20-session NSE end-of-day history. They are part of the conviction only when the user turns them on. Separately, every scored gap gets a History score (0–100): equal weights over the History factors that have data, needing ${MIN_HISTORY_FACTORS} or more.
${HISTORY_FACTORS.map(factor).join('\n')}

## Auction layer and Auction score
The Auction layer uses Kite /quote readings recorded by the app during the pre-open (09:00–09:09): the indicative equilibrium price, indicative volume, buy and sell quantities and the imbalance. Readings after the close of order entry are not used for the drift, orders held and imbalance. The factors join the conviction only when turned on. The separate Auction score is equal weights over the stock's own factors (the Nifty futures factor is market-wide and not in it), needing ${MIN_AUCTION_FACTORS} or more. It is blank when the app has no auction recording for that day.
${AUCTION_FACTORS.map(factor).join('\n')}

## Stock filter and quality rank
The Stock filter lists every gapped stock with these readings. Every threshold is typed by the user; a blank box is not applied, and a stock without the reading fails that box.
${SCREENER_GROUPS.map((g) => `- ${g.label} (${g.source}): ${SCREENER_METRICS.filter((m) => m.group === g.key).map((m) => `${m.label} [${m.unit}]`).join(', ')}`).join('\n')}

Quality is the average percentile, among all gapped stocks, of the readings ticked "in rank"; it needs ${MIN_QUALITY_METRICS} or more readings. Rank 1 is the best. The rank is computed before the thresholds, so it does not move as filters change. It is a ranking, not a forecast.

## Conviction vs quality vs History vs Auction
- Conviction: the weighted factor score the user configures (pre-open orders, value, relative volume, gap size by default).
- Quality rank: the Stock filter's average percentile of the readings ticked in rank; independent of the conviction weights.
- History score: equal-weight score of the History layer's factors (20 sessions of end-of-day data).
- Auction score: equal-weight score of the Auction layer's own factors (Kite pre-open readings recorded by the app).
None of them is a win probability. The report card measures how each one ranked recorded days; a small number of recorded days is weak evidence.

## Tradeability flags
- T2T (block): trade-to-trade series, delivery only, no intraday or short selling.
- At UC / At LC (block): locked at the upper or lower circuit, so an order may not fill.
- Room to the circuit (warn): under ${MIN_ROOM_PCT}% left before the circuit in the gap direction.
- Series other than EQ (warn), surveillance (GSM/ASM, warn), ex-date today (warn: part of the gap may be a price adjustment), and Data? (warn: NSE's final price, base and change disagree).

## Market cap columns
The Analyzer's "Free-float M.Cap" column is the FFM CAP (₹ Crores) field of each NSE pre-open row. It is blank when the row has no FFM CAP, for example an uploaded pm.csv without that column. Full market cap ("marketCap") is read only from the master list's market-cap column (a header like "Market Cap (Cr)"); a master list without that column, such as NSE's index constituent lists, gives no full market cap. The Excel export keeps both. Free-float cap is smaller than full cap for promoter-held companies.

## Gap vs size
Gap vs size = |today's gap| ÷ the typical gap for the company's size: the median 20-session average absolute gap of the ${SIZE_PEERS} stocks nearest in free-float cap (log scale), from NSE end-of-day files, needing ${MIN_GAP_DAYS} or more sessions; otherwise today's pre-open gaps of the size peers. Display only; not in any score.

## Research columns (vs ${RESEARCH_DAYS} sessions)
Each reading is compared with the stock's own previous ${RESEARCH_DAYS} completed sessions, never the observation itself, with the coverage shown ("17/20"). With fewer than ${MIN_RESEARCH_DAYS} sessions a cell shows the coverage instead of a ratio. Pre-open RVOL and value use the app's own recorded pre-open days; delivery, gaps and returns use NSE end-of-day files; OI uses NSE F&O files. Display only.

## Signals
Relative volume (Vol ×) is the pre-open quantity vs the 20-day average daily volume, as a multiple of the median stock; ${HIGH_RVOL_X}× or more is highlighted. A delivery % of ${HIGH_DELIVERY_X}× the usual is highlighted. Futures OI changes of ${NOTABLE_OI_PCT}% or more are shown as long build-up, short build-up, short covering or long unwinding. A higher delivery % is an observation; it does not prove that institutions bought the stock.

## Data sources and timestamps
- NSE pre-open snapshot: imported by the backend at 09:10 IST (NSE's own update time, e.g. 09:08:xx, is the exchange timestamp; the fetch time is when the backend downloaded it).
- NSE end-of-day files: usually published by 18:30 IST, so a day's outcome is not known that morning.
- NSE price bands and surveillance list: refreshed once per IST day.
- Corporate events: NSE announcements since the previous close; for a past date, announcements after that morning's open are left out.
- Market signals: GIFT Nifty before the pre-open close, India VIX close, FII/DII provisional flows published in the evening.
- Kite auction readings: recorded by the backend 09:00–09:09 on trading days when a Kite session was available.
`;
}
