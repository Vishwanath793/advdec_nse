import { indiaDate } from '../../src/core/calendar.js';
import { aiError } from './errors.js';

/**
 * Provider calls and tokens per IST day (`ai/usage-YYYY-MM-DD.json` in the
 * store), with the daily budget. A cost is estimated only when prices are
 * configured (AI_PRICE_*); none is invented.
 */
export function createUsageLedger({ store, config, now = () => new Date() }) {
  const days = new Map();
  let writing = Promise.resolve();
  const file = (date) => `ai/usage-${date}.json`;
  const empty = (date) => ({ date, calls: 0, inputTokens: 0, outputTokens: 0, embeddingTokens: 0, embeddingCalls: 0, byKind: {} });

  async function day(date = indiaDate(now())) {
    if (!days.has(date)) days.set(date, { ...empty(date), ...((await store.read(file(date))) ?? {}) });
    return days.get(date);
  }

  const tokens = (d) => d.inputTokens + d.outputTokens + d.embeddingTokens;

  function cost(d) {
    const p = config.prices;
    if (p.input == null || p.output == null) return null;
    const embedding = d.embeddingTokens ? (p.embedding == null ? null : (d.embeddingTokens / 1e6) * p.embedding) : 0;
    if (embedding == null) return null;
    return { amount: (d.inputTokens / 1e6) * p.input + (d.outputTokens / 1e6) * p.output + embedding, currency: p.currency, estimated: true };
  }

  /** Throws a `budget` error when today's budget is used up (checked before every provider call). */
  async function check() {
    const d = await day();
    if (d.calls + d.embeddingCalls >= config.dailyCallBudget) {
      throw aiError('budget', `Today's AI call budget (${config.dailyCallBudget} calls) is used up. It resets at midnight IST, or raise AI_DAILY_CALL_BUDGET.`);
    }
    if (tokens(d) >= config.dailyTokenBudget) {
      throw aiError('budget', `Today's AI token budget (${config.dailyTokenBudget.toLocaleString('en-IN')} tokens) is used up. It resets at midnight IST, or raise AI_DAILY_TOKEN_BUDGET.`);
    }
  }

  /** Record one call: kind 'generate' { input, output } or 'embed' { input }. */
  async function add(kind, { input = 0, output = 0 } = {}) {
    const d = await day();
    if (kind === 'embed') { d.embeddingCalls++; d.embeddingTokens += input; }
    else { d.calls++; d.inputTokens += input; d.outputTokens += output; }
    d.byKind[kind] = (d.byKind[kind] ?? 0) + 1;
    const snapshot = { ...d, byKind: { ...d.byKind } };
    writing = writing.then(() => store.write(file(d.date), snapshot)).catch((error) => console.error(`AI usage: ${error.message}`));
    return writing;
  }

  async function summary() {
    const d = await day();
    return {
      ...d,
      totalTokens: tokens(d),
      budget: { tokens: config.dailyTokenBudget, calls: config.dailyCallBudget },
      cost: cost(d),
    };
  }

  return { check, add, summary };
}
