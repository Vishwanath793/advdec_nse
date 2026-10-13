import { unzipSync, strFromU8 } from 'fflate';
import { parseCSV, rowsToObjects, toNumber } from './csv.js';

/**
 * Master stock list helpers. A master list maps Symbol -> Company Name /
 * Industry, optionally with a market-cap column (₹ Crores). It can come from
 * the bundled master_stock.csv or a user-uploaded .csv / .xlsx file.
 */

const MCAP_HEADER = /market\s*cap|^m\.?\s*cap/i;

/** Find the market-cap column name in a master row, if any. */
export function marketCapKey(row) {
  return row ? Object.keys(row).find((k) => MCAP_HEADER.test(k)) : undefined;
}

/** Market cap in ₹ Crores, or null when absent/unparseable. */
export function marketCapOf(row, key = marketCapKey(row)) {
  if (!key) return null;
  const n = toNumber(row[key]);
  return Number.isNaN(n) ? null : n;
}

const decodeXml = (s) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const map = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });

/** Concatenate every <t> run inside an XML fragment (handles rich text). */
const textRuns = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');

/** "AB12" -> 27 (zero-based column index). */
function columnIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** Read the first worksheet of an .xlsx file into an array of string rows. */
export function parseXLSX(bytes) {
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const read = (path) => (files[path] ? strFromU8(files[path]) : null);

  // Resolve the first sheet through workbook.xml + its relationships.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  const firstId = workbook && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  if (firstId && rels) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${firstId}"`));
    const target = rel && /Target="([^"]+)"/.exec(rel)?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  const sheet = read(sheetPath);
  if (!sheet) throw new Error('No worksheet found in the Excel file.');

  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));

  const rows = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cell of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const body = cell[2] ?? '';
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = textRuns(body);
      else if (raw != null) value = decodeXml(raw);
      const idx = ref ? columnIndex(ref) : row.length;
      while (row.length < idx) row.push('');
      row[idx] = value;
    }
    if (row.some((v) => String(v).trim() !== '')) rows.push(row);
  }
  return rows;
}

/** Validate master rows: needs Symbol and Industry columns. Returns cleaned rows. */
export function validateMaster(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('The file has no data rows.');
  const headers = Object.keys(rows[0]);
  for (const required of ['Symbol', 'Industry']) {
    if (!headers.includes(required)) {
      throw new Error(`Missing "${required}" column. Expected columns: Company Name, Industry, Symbol (Market Cap optional).`);
    }
  }
  const cleaned = rows.filter((r) => String(r.Symbol ?? '').trim());
  if (cleaned.length === 0) throw new Error('No rows with a Symbol were found.');
  return cleaned;
}

/** Parse an uploaded master list File (.csv or .xlsx) into row objects. */
export async function parseMasterFile(file) {
  const isExcel = /\.xlsx$/i.test(file.name);
  if (/\.xls$/i.test(file.name)) throw new Error('Old .xls files are not supported. Save as .xlsx or .csv.');
  const rows = isExcel
    ? rowsToObjects(parseXLSX(new Uint8Array(await file.arrayBuffer())).map((r) => r.map(String)))
    : rowsToObjects(parseCSV(await file.text()));
  return validateMaster(rows);
}
