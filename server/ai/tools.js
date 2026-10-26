import { aiError } from './errors.js';
import { CATEGORY_FIELDS, MAX_COMPARE, MAX_SCREEN_ROWS, NUMERIC_OPS, SCREEN_FIELDS, SORT_FIELDS } from './data.js';

/**
 * The only functions the model can call: seven read-only data functions.
 * Each has a strict JSON schema for the provider and its own validation here,
 * because the provider's schema check is not a security boundary. There is no
 * tool that places, changes, cancels or schedules an order, squares off, or
 * changes a setting, and none that reads a file path, runs code or fetches a URL.
 */

const SYMBOL = /^[A-Z0-9][A-Z0-9&_-]{0,19}$/;
const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

function symbol(v, what = 'symbol') {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (!SYMBOL.test(s)) throw aiError('invalid', `${what} must be an NSE symbol such as INFY or M&M.`);
  return s;
}
function number(v, what, { min = -1e9, max = 1e9, allowNull = true } = {}) {
  if (v == null) {
    if (allowNull) return null;
    throw aiError('invalid', `${what} is required.`);
  }
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw aiError('invalid', `${what} must be a number from ${min} to ${max}.`);
  return n;
}
const bool = (v) => v === true;
function noExtra(args, allowed) {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) throw aiError('invalid', 'Arguments must be an object.');
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length) throw aiError('invalid', `Unknown argument: ${extra[0]}.`);
}

const FIELD_NAMES = [...Object.keys(SCREEN_FIELDS), ...Object.keys(CATEGORY_FIELDS)];

export const TOOLS = [
  {
    name: 'getAnalysisSnapshot',
    description: "Summary of the selected Analyzer snapshot: advance/decline breadth, sector counts, the largest gaps, the top conviction scores and the Stock filter's match count.",
    parameters: obj({}),
    validate: (a) => { noExtra(a, []); return {}; },
  },
  {
    name: 'getStockAnalysis',
    description: "Every recorded reading for one stock in the selected snapshot, computed with the user's active factor and filter settings: prices and gap, market caps, the conviction score with each factor's score, weight share and detail, the History and Auction scores, signals, research columns, circuit limits, tradeability flags and why it passes or fails the Stock filter.",
    parameters: obj({ symbol: { type: 'string', description: 'NSE symbol, e.g. INFY' } }),
    validate: (a) => { noExtra(a, ['symbol']); return { symbol: symbol(a.symbol) }; },
  },
  {
    name: 'compareStocks',
    description: `Side-by-side readings for 2 to ${MAX_COMPARE} stocks in the selected snapshot.`,
    parameters: obj({ symbols: { type: 'array', items: { type: 'string' }, description: `2 to ${MAX_COMPARE} NSE symbols` } }),
    validate: (a) => {
      noExtra(a, ['symbols']);
      if (!Array.isArray(a.symbols)) throw aiError('invalid', 'symbols must be a list.');
      const symbols = [...new Set(a.symbols.map((s) => symbol(s)))];
      if (symbols.length < 2 || symbols.length > MAX_COMPARE) throw aiError('invalid', `Compare 2 to ${MAX_COMPARE} different stocks.`);
      return { symbols };
    },
  },
  {
    name: 'screenSnapshot',
    description: `Stocks in the selected snapshot that meet exact numerical conditions (all must hold), sorted and limited to ${MAX_SCREEN_ROWS}. Fields: ${Object.entries(SCREEN_FIELDS).map(([k, f]) => `${k} (${f.label})`).join('; ')}; sector and direction ('up' or 'down') with op 'eq' or 'in' and 'values'. Numeric ops: ${NUMERIC_OPS.join(', ')} (between uses value and value2).`,
    parameters: obj({
      conditions: {
        type: 'array',
        items: obj({
          field: { type: 'string', enum: FIELD_NAMES },
          op: { type: 'string', enum: [...NUMERIC_OPS, 'in'] },
          value: nullable('number'),
          value2: nullable('number'),
          values: nullable('array', { items: { type: 'string' } }),
        }),
      },
      useMyFilters: { type: 'boolean', description: "Start from the stocks that pass the user's own Stock filter" },
      tradeableOnly: { type: 'boolean' },
      sortBy: nullable('string', { enum: [...SORT_FIELDS, null] }),
      sortDir: { type: 'string', enum: ['asc', 'desc'] },
      limit: nullable('integer'),
    }),
    validate: (a) => {
      noExtra(a, ['conditions', 'useMyFilters', 'tradeableOnly', 'sortBy', 'sortDir', 'limit']);
      if (!Array.isArray(a.conditions) || a.conditions.length > 10) throw aiError('invalid', 'conditions must be a list of at most 10.');
      const conditions = a.conditions.map((c, i) => {
        noExtra(c, ['field', 'op', 'value', 'value2', 'values']);
        if (!FIELD_NAMES.includes(c.field)) throw aiError('invalid', `Condition ${i + 1}: unknown field.`);
        if (CATEGORY_FIELDS[c.field]) {
          if (!['eq', 'in'].includes(c.op)) throw aiError('invalid', `Condition ${i + 1}: ${c.field} takes eq or in.`);
          if (!Array.isArray(c.values) || !c.values.length || c.values.length > 20 || c.values.some((v) => typeof v !== 'string' || v.length > 60)) {
            throw aiError('invalid', `Condition ${i + 1}: values must list 1 to 20 short strings.`);
          }
          return { field: c.field, op: c.op, value: null, value2: null, values: c.values.map((v) => v.trim()) };
        }
        if (!NUMERIC_OPS.includes(c.op)) throw aiError('invalid', `Condition ${i + 1}: ${c.field} takes ${NUMERIC_OPS.join(', ')}.`);
        const value = number(c.value, `Condition ${i + 1} value`, { allowNull: false });
        const value2 = c.op === 'between' ? number(c.value2, `Condition ${i + 1} value2`, { allowNull: false }) : null;
        return { field: c.field, op: c.op, value, value2, values: null };
      });
      if (a.sortBy != null && !SORT_FIELDS.includes(a.sortBy)) throw aiError('invalid', 'Unknown sort field.');
      return {
        conditions,
        useMyFilters: bool(a.useMyFilters),
        tradeableOnly: bool(a.tradeableOnly),
        sortBy: a.sortBy ?? null,
        sortDir: a.sortDir === 'asc' ? 'asc' : 'desc',
        limit: Math.floor(number(a.limit, 'limit', { min: 1, max: MAX_SCREEN_ROWS }) ?? 10),
      };
    },
  },
  {
    name: 'getRecordedDates',
    description: 'The trading days this app recorded, with what is stored for each (pre-open, auction readings, 09:20 sealed window, paper results, end-of-day outcome), limited to what was known by the cutoff in as-known mode.',
    parameters: obj({}),
    validate: (a) => { noExtra(a, []); return {}; },
  },
  {
    name: 'getHistoricalOutcomes',
    description: "Recorded setups like the given one on earlier recorded days and how they closed (entry at the pre-open price, end-of-day close). Setups are chosen from morning data only, with the user's profile. Results are retrospective and the sample is small.",
    parameters: obj({
      direction: { type: 'string', enum: ['up', 'down', 'both'] },
      minGap: nullable('number'),
      maxGap: nullable('number'),
      minScore: nullable('number'),
      maxScore: nullable('number'),
      tradeableOnly: { type: 'boolean' },
      sector: nullable('string'),
      lastDays: nullable('integer'),
    }),
    validate: (a) => {
      noExtra(a, ['direction', 'minGap', 'maxGap', 'minScore', 'maxScore', 'tradeableOnly', 'sector', 'lastDays']);
      if (!['up', 'down', 'both'].includes(a.direction)) throw aiError('invalid', 'direction must be up, down or both.');
      if (a.sector != null && (typeof a.sector !== 'string' || a.sector.length > 60)) throw aiError('invalid', 'sector must be a short name.');
      return {
        direction: a.direction,
        minGap: number(a.minGap, 'minGap', { min: 0, max: 50 }),
        maxGap: number(a.maxGap, 'maxGap', { min: 0, max: 50 }),
        minScore: number(a.minScore, 'minScore', { min: 0, max: 100 }),
        maxScore: number(a.maxScore, 'maxScore', { min: 0, max: 100 }),
        tradeableOnly: bool(a.tradeableOnly),
        sector: a.sector?.trim() || null,
        lastDays: a.lastDays == null ? null : Math.floor(number(a.lastDays, 'lastDays', { min: 1, max: 250 })),
      };
    },
  },
  {
    name: 'getDataCoverage',
    description: "What data the selected snapshot has and what is missing or stale (history, events, market signals, auction readings, pre-open baseline, price bands, market caps), optionally for one stock's factors.",
    parameters: obj({ symbol: nullable('string') }),
    validate: (a) => { noExtra(a, ['symbol']); return { symbol: a.symbol == null || a.symbol === '' ? null : symbol(a.symbol) }; },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** Tool definitions in the provider's function-tool shape. */
export const toolDefinitions = () => TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true }));

/** Validate and run one tool call against the data functions; unknown names are refused. */
export async function runTool(functions, session, name, rawArgs) {
  const tool = BY_NAME.get(name);
  if (!tool || typeof functions[name] !== 'function') throw aiError('invalid', `Unknown function ${String(name).slice(0, 40)}: only the read-only research functions exist.`);
  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    if (rawArgs.length > 8000) throw aiError('invalid', 'Arguments are too long.');
    try { args = JSON.parse(rawArgs || '{}'); } catch { throw aiError('invalid', 'Arguments are not valid JSON.'); }
  }
  const clean = tool.validate(args ?? {});
  return { args: clean, ...(await functions[name](session, clean)) };
}
