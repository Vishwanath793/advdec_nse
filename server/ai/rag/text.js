import { createHash } from 'node:crypto';

/** Text helpers for indexing: hashing, token estimates, tokenising and chunking. */

export const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');

/** Rough token count (about 4 characters a token for English and numbers). */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);

const STOP = new Set(('a an and are as at be by for from has have how in is it its of on or that the this to was were what when '
  + 'where which who why will with does do did my me i you your it\'s than then there these those can could should would '
  + 'about into over under not no yes also only').split(' '));

/**
 * Lower-case terms for keyword search. Keeps NSE symbols with & and - whole
 * ("m&m", "bajaj-auto") and also their parts, and drops a plural "s".
 */
export function tokenize(text) {
  const out = [];
  for (const raw of String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9&._-]*[a-z0-9&]|[a-z0-9]/g) ?? []) {
    const word = raw.replace(/[._]+$/, '');
    if (STOP.has(word)) continue;
    out.push(word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
    if (/[&._-]/.test(word)) for (const part of word.split(/[&._-]+/)) if (part && !STOP.has(part) && part !== word) out.push(part);
  }
  return out;
}

/** Instruction-like text inside a document (flagged on the source card; never obeyed). */
const INJECTION = /\b(ignore (all |any )?(previous|prior|above) (instructions|rules)|disregard (the )?(system|previous)|you are now|system prompt|developer message|call the tool|place (an? )?order|reveal (the )?(key|secret|token|prompt)|new instructions:)/i;
export const looksLikeInstructions = (text) => INJECTION.test(String(text ?? ''));

const MAX_CHUNK_CHARS = 1400;

/**
 * Markdown split at headings, then at blank lines, into chunks of at most
 * MAX_CHUNK_CHARS (a paragraph longer than that is split at sentence ends).
 * A chunk never crosses a heading; each keeps its heading path.
 * Returns [{ heading, path, text, ordinal }].
 */
export function chunkMarkdown(markdown, { maxChars = MAX_CHUNK_CHARS } = {}) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  const path = [];
  let current = { path: [], lines: [] };
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      if (current.lines.join('').trim()) sections.push(current);
      const level = m[1].length;
      path.length = level - 1;
      path[level - 1] = m[2].trim();
      current = { path: path.filter(Boolean), lines: [] };
    } else current.lines.push(line);
  }
  if (current.lines.join('').trim()) sections.push(current);

  const chunks = [];
  for (const section of sections) {
    const paragraphs = section.lines.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const pieces = paragraphs.flatMap((p) => (p.length <= maxChars ? [p] : splitLong(p, maxChars)));
    let buffer = '';
    let ordinal = 0;
    const flush = () => {
      if (!buffer.trim()) return;
      chunks.push({ heading: section.path.at(-1) ?? null, path: section.path, text: buffer.trim(), ordinal: ordinal++ });
      buffer = '';
    };
    for (const piece of pieces) {
      if (buffer && buffer.length + piece.length + 2 > maxChars) flush();
      buffer = buffer ? `${buffer}\n\n${piece}` : piece;
    }
    flush();
  }
  return chunks;
}

function splitLong(text, maxChars) {
  const out = [];
  let buffer = '';
  for (const sentence of text.split(/(?<=[.!?])\s+|\n(?=[-*] )/)) {
    if (buffer && buffer.length + sentence.length + 1 > maxChars) { out.push(buffer); buffer = ''; }
    if (sentence.length > maxChars) {
      for (let i = 0; i < sentence.length; i += maxChars) out.push(sentence.slice(i, i + maxChars));
      continue;
    }
    buffer = buffer ? `${buffer} ${sentence}` : sentence;
  }
  if (buffer) out.push(buffer);
  return out;
}

export const slug = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'section';
