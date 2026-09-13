const SETTINGS_KEY = 'ad_settings_v1';
const SESSION_KEY = 'ad_kite_session_v1';

export const DEFAULT_SETTINGS = {
  kiteApiKey: '',
  kiteApiSecret: '',
  // --- Kite order parameters (used when placing BUY/SELL orders) ---
  exchange: 'NSE',            // NSE | BSE
  product: 'MIS',             // CNC | MIS | NRML | MTF — default MIS (intraday)
  orderType: 'MARKET',        // MARKET | LIMIT | SL | SL-M
  validity: 'DAY',            // DAY | IOC
  quantity: 1,                // default order quantity
  // Market protection (MARKET & SL-M only, per Kite Connect v3):
  //   -1 = automatic protection per Zerodha guidelines; 1-100 = custom %.
  //   Converts the market order into a limit order within exchange LPP range.
  marketProtection: -1,
  autoslice: true,            // auto-split orders exceeding freeze quantity
  disclosedQuantity: 0,       // 0 = no disclosure (equity only)
  tag: 'ADVDC',               // identifies orders from this app (alnum, max 20)
  maxLoss: 5000,              // auto square-off when portfolio P&L <= -maxLoss (₹)
  priceOffsetPct: 0.2,        // LIMIT price = ref price ± this % (BUY above / SELL below)
  triggerOffsetPct: 0.5,      // SL / SL-M trigger offset %
  variety: 'regular',         // regular | amo
  // --- Signal rules ---
  minAdvPctForBuy: 60,      // sector Adv % >= this => sector considered bullish
  minPctChangeForBuy: 1.0,  // stock %chg >= this => BUY candidate
  maxPctChangeForSell: -1.0, // stock %chg <= this => SELL candidate
  minValueCrores: 1,        // liquidity filter (pm.csv VALUE ₹ Cr)
  maxResults: 50,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    // Merge over defaults AND backfill any key that is missing/undefined so
    // settings saved before new fields were introduced stay valid.
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (merged[k] === undefined || merged[k] === null || merged[k] === '') {
        if (typeof DEFAULT_SETTINGS[k] === 'number' || typeof DEFAULT_SETTINGS[k] === 'boolean') {
          merged[k] = DEFAULT_SETTINGS[k];
        }
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}
