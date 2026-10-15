/**
 * Intraday tradeability checks for a gap trade at the open.
 *
 * Each flag is { key, label, severity, detail }:
 *  - 'block': the trade likely can't be done intraday (excluded by "Tradeable only").
 *  - 'warn':  tradeable, but with a caveat worth seeing before entering.
 *
 * Rules are about the exchange, not a specific broker; confirm edge cases
 * (e.g. SME or REIT intraday eligibility) with your broker.
 */

/** Below this % of room to the circuit in the gap direction, warn. */
export const MIN_ROOM_PCT = 2;

const TRADE_TO_TRADE = new Set(['BE', 'BZ']);

/** % distance from the final price to the circuit in the gap direction (null if no fixed band). */
export function roomToCircuit(stock) {
  const { finalPrice, upperCircuit, lowerCircuit, status } = stock;
  if (finalPrice == null || !finalPrice || upperCircuit == null) return null;
  if (status === 'advance') return ((upperCircuit - finalPrice) / finalPrice) * 100;
  if (status === 'decline') return ((finalPrice - lowerCircuit) / finalPrice) * 100;
  return null;
}

export function tradeFlags(stock) {
  const flags = [];
  const { series, surveillance, circuitHit } = stock;

  if (stock.dataIssue) {
    flags.push({ key: 'data', label: 'Data?', severity: 'warn', detail: `Inconsistent NSE pre-open data: ${stock.dataIssue}` });
  }

  if (series && TRADE_TO_TRADE.has(series)) {
    flags.push({
      key: 't2t',
      label: 'T2T',
      severity: 'block',
      detail: `Series ${series} is trade-to-trade: delivery only, no intraday (MIS) or short selling.`,
    });
  } else if (series && series !== 'EQ') {
    flags.push({
      key: 'series',
      label: series,
      severity: 'warn',
      detail: `Series ${series} (not EQ): check intraday eligibility with your broker.`,
    });
  }

  if (surveillance) {
    const gsm = /GSM/i.test(surveillance);
    flags.push({
      key: 'surveillance',
      label: gsm ? surveillance.replace(/GSM STAGE\s*-\s*/i, 'GSM ') : surveillance,
      severity: 'warn',
      detail: `Under NSE surveillance (${surveillance}): higher margins and trading restrictions may apply.`,
    });
  }

  if (stock.exDate?.length) {
    flags.push({
      key: 'exdate',
      label: 'Ex-date',
      severity: 'warn',
      detail: `Ex-date today (${stock.exDate.join('; ')}): part of the gap may be a price adjustment for the corporate action, not demand.`,
    });
  }

  if (circuitHit) {
    const upper = circuitHit === 'upper';
    flags.push({
      key: 'circuit',
      label: upper ? 'At UC' : 'At LC',
      severity: 'block',
      detail: upper
        ? 'Locked at the upper circuit: few or no sellers, so a buy may not fill.'
        : 'Locked at the lower circuit: few or no buyers, so a sell may not fill.',
    });
  } else {
    const room = roomToCircuit(stock);
    if (room != null && room < MIN_ROOM_PCT) {
      const upper = stock.status === 'advance';
      flags.push({
        key: 'room',
        label: `${room.toFixed(1)}% to ${upper ? 'UC' : 'LC'}`,
        severity: 'warn',
        detail: `Only ${room.toFixed(2)}% left before the ${upper ? 'upper' : 'lower'} circuit: limited room for the move to continue.`,
      });
    }
  }

  return flags;
}

export const isTradeable = (stock) => !stock.flags?.some((f) => f.severity === 'block');
