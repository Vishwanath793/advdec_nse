/**
 * Risk settings and checks for the 09:20 system (PAPER now; the same limits will
 * apply to LIVE). All values are configurable in Settings; these are defaults.
 * Nothing here promises that a stop fills or that a strategy makes money.
 */
import { cleanChargeRates, INTRADAY_EQUITY_RATES } from './charges.js';

export const DEFAULT_RISK_SETTINGS = {
  capital: 100_000, // ₹ trading capital
  riskPerTradePct: 0.25, // of capital, risked between entry and stop
  dailyLossPct: 1, // stop opening trades once the day's net loss reaches this % of capital
  maxOpenPositions: 2,
  maxTradesPerDay: 3,
  minRewardRisk: 1.5, // after costs
  maxConsecutiveLosses: 2, // stop for the day after this many losing trades in a row
  misLeverage: 5, // notional cap = capital × this (MIS); check your broker's current margin
  slippageBps: 5, // assumed slippage on top of the bid/ask for paper fills
  maxSlippageBps: 15, // an entry filling further than this past its trigger is rejected
  maxSpreadBps: 25, // wider live spread: no trade
  squareOffAt: '15:10', // paper positions still open are closed at this time (IST)
  entryUntil: '09:30', // entry orders not triggered by this time (IST) are cancelled
  charges: INTRADAY_EQUITY_RATES, // Zerodha intraday rates (utils/charges.js), adjustable when they change
};
const HHMM = /^(0\d|1[0-5]):[0-5]\d$/;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Settings merged over the defaults, with every number clamped to a sane range. */
export function cleanRiskSettings(input = {}) {
  const d = DEFAULT_RISK_SETTINGS;
  const c = (k, lo, hi) => Math.min(hi, Math.max(lo, num(input[k], d[k])));
  return {
    capital: c('capital', 1_000, 1e10),
    riskPerTradePct: c('riskPerTradePct', 0.01, 5),
    dailyLossPct: c('dailyLossPct', 0.05, 20),
    maxOpenPositions: Math.round(c('maxOpenPositions', 1, 20)),
    maxTradesPerDay: Math.round(c('maxTradesPerDay', 1, 50)),
    minRewardRisk: c('minRewardRisk', 0.5, 10),
    maxConsecutiveLosses: Math.round(c('maxConsecutiveLosses', 1, 20)),
    misLeverage: c('misLeverage', 1, 10),
    slippageBps: c('slippageBps', 0, 100),
    maxSlippageBps: c('maxSlippageBps', 1, 500),
    maxSpreadBps: c('maxSpreadBps', 1, 500),
    squareOffAt: HHMM.test(input.squareOffAt ?? '') && input.squareOffAt <= '15:20' ? input.squareOffAt : d.squareOffAt,
    entryUntil: HHMM.test(input.entryUntil ?? '') && input.entryUntil >= '09:20' && input.entryUntil <= '15:00' ? input.entryUntil : d.entryUntil,
    charges: cleanChargeRates(input.charges),
  };
}

/**
 * Quantity for a trade: risk ÷ stop distance, capped by the notional allowed
 * (capital × MIS leverage) and the available margin when known. Whole lots for
 * instruments with a lot size above 1. Returns { qty, riskAmount, reason? }.
 */
export function positionSize({ entry, stop, lot = 1, settings, availableMargin = null }) {
  const s = cleanRiskSettings(settings);
  const perShare = Math.abs(entry - stop);
  if (!(perShare > 0) || !(entry > 0)) return { qty: 0, riskAmount: 0, reason: 'no stop distance' };
  const riskBudget = (s.capital * s.riskPerTradePct) / 100;
  let qty = Math.floor(riskBudget / perShare);
  const notionalCap = s.capital * s.misLeverage;
  const marginCap = availableMargin != null ? availableMargin * s.misLeverage : Infinity;
  qty = Math.min(qty, Math.floor(Math.min(notionalCap, marginCap) / entry));
  if (lot > 1) qty = Math.floor(qty / lot) * lot;
  if (qty < 1) return { qty: 0, riskAmount: 0, reason: availableMargin != null && marginCap < entry ? 'insufficient margin' : 'risk budget smaller than one share/lot at this stop' };
  return { qty, riskAmount: qty * perShare, notional: qty * entry };
}

/**
 * Whether a new trade may open now. `day`: { realised (net ₹), trades (opened today),
 * open (positions), consecutiveLosses, killSwitch }. Returns the list of reasons it can't.
 */
export function tradeBlockers(day, settings) {
  const s = cleanRiskSettings(settings);
  const reasons = [];
  if (day.killSwitch) reasons.push('kill switch is on');
  if (day.realised <= -(s.capital * s.dailyLossPct) / 100) reasons.push(`daily loss limit reached (${s.dailyLossPct}% of capital)`);
  if (day.trades >= s.maxTradesPerDay) reasons.push(`maximum ${s.maxTradesPerDay} trades a day reached`);
  if (day.open >= s.maxOpenPositions) reasons.push(`maximum ${s.maxOpenPositions} open positions reached`);
  if (day.consecutiveLosses >= s.maxConsecutiveLosses) reasons.push(`${day.consecutiveLosses} losses in a row: stopped for the day`);
  return reasons;
}
