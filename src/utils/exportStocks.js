import { strToU8, zipSync } from 'fflate';
import { BLOCKED_SCORE_CAP, cleanWeight, CONVICTION_FACTORS, DEFAULT_FACTOR_SETTINGS, factorWeights, FNO_ORDERS_SHARE, MIN_GAP_PCT, weightShares } from './conviction.js';

/**
 * Excel export of the Stocks table with the conviction score broken down:
 *  - "Stocks": one row per stock, each factor's score (0–100) and the weight it
 *    counted with for that stock;
 *  - "Conviction factors": the settings used (on/off, weight, share) and notes;
 *  - "Breakdown": one row per stock and factor, with the explanation shown on hover.
 * Shared by the download button, the backend's 9:30 save and the Android app.
 */

// ---- Minimal .xlsx writer (inline strings, bold header row, frozen header, filters) ----

const xml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
  // Characters XML 1.0 does not allow.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Column letters for a 0-based index: 0 -> A, 26 -> AA. */
export function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function sheetXml({ rows, widths = [], header = true, filter = header }) {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const body = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      if (value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return '';
      const ref = `${columnName(c)}${r + 1}`;
      const style = header && r === 0 ? ' s="1"' : '';
      return typeof value === 'number'
        ? `<c r="${ref}"${style}><v>${value}</v></c>`
        : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const views = header
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '';
  const autoFilter = filter && rows.length > 1 ? `<autoFilter ref="A1:${columnName(width - 1)}${rows.length}"/>` : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `${views}${cols}<sheetData>${body}</sheetData>${autoFilter}</worksheet>`;
}

/** Build an .xlsx file: sheets = [{ name, rows: [[cell]], widths?, header?, filter? }]. Returns bytes. */
export function buildXlsx(sheets) {
  const filtered = (s) => (s.filter ?? s.header ?? true) && s.rows.length > 1;
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + sheets.map((s, i) => `<sheet name="${xml(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets>'
      + (sheets.some(filtered)
        ? `<definedNames>${sheets.map((s, i) => (filtered(s)
          ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(s.name.slice(0, 31))}'!$A$1:$${columnName(Math.max(1, ...s.rows.map((r) => r.length)) - 1)}$${s.rows.length}</definedName>`
          : '')).join('')}</definedNames>`
        : '')
      + '</workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + '</Relationships>',
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
      + '</styleSheet>',
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s); });
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

// ---- Stocks workbook ----

const round = (n, digits = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits);

/** IST timestamp "16-Oct-2026 09:30" for file contents. */
export function istStamp(at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}`;
}

/** File name like "Stocks_2026-10-16_0930.xlsx" (IST). */
export function exportFileName(at = new Date(), prefix = 'Stocks') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return `${prefix}_${parts.year}-${parts.month}-${parts.day}_${parts.hour === '24' ? '00' : parts.hour}${parts.minute}.xlsx`;
}

function signalsText(s) {
  const out = [];
  if (s.results?.length) out.push('Results');
  if (s.resultsDue) out.push('Results due');
  if (s.rvolX != null) out.push(`Vol ${s.rvolX >= 10 ? Math.round(s.rvolX) : s.rvolX.toFixed(1)}x`);
  if (s.delivX != null) out.push(`Deliv ${s.delivPct.toFixed(0)}% (${s.delivX.toFixed(1)}x usual)`);
  if (s.foBuild && s.foBuild !== 'neutral') out.push(`OI ${s.foBuild} (${s.foOiChangePct >= 0 ? '+' : ''}${s.foOiChangePct.toFixed(1)}%)`);
  if (s.rangeBreak === 'above') out.push('Above PDH');
  else if (s.rangeBreak === 'below') out.push('Below PDL');
  else if (s.rangeBreak === 'inside') out.push('Inside PD range');
  return out.join(', ');
}

/**
 * The workbook for `stocks` (analysis output, in table order) scored with
 * `factorSettings`. `meta`: { exportedAt: Date, source: string, filters?: string }.
 */
export function stocksWorkbook(stocks, factorSettings, meta = {}) {
  const exportedAt = meta.exportedAt ?? new Date();
  const weights = factorWeights(factorSettings);
  const shares = weightShares(weights);

  const header = [
    'Symbol', 'Company', 'Sector', 'Market cap (₹ Cr)', 'Prev close', 'Final price', 'Change', '% change', 'Status',
    'Pre-open value (₹ Cr)', 'Conviction', 'Direction', 'Score before cap', 'Capped by', 'Flags', 'Signals',
    'Lower circuit', 'Upper circuit', 'Band',
    ...CONVICTION_FACTORS.flatMap((f) => [`${f.label} score`, `${f.label} weight`]),
    'Factors without data',
  ];
  const rows = stocks.map((s) => {
    const c = s.conviction;
    const used = new Map((c?.factors ?? []).map((f) => [f.key, f]));
    return [
      s.symbol, s.company, s.sector, round(s.marketCap), s.prevClose, s.finalPrice, s.change, s.pctChange,
      s.status === 'advance' ? 'Advance' : s.status === 'decline' ? 'Decline' : 'Unchanged',
      round(s.valueCr, 4),
      c?.score ?? null,
      c ? (c.direction === 'up' ? 'Gap-up' : 'Gap-down') : null,
      c?.rawScore != null && c.rawScore !== c.score ? c.rawScore : null,
      c?.cappedBy && c.rawScore > c.score ? c.cappedBy.join(', ') : null,
      (s.flags ?? []).map((f) => f.label).join(', '),
      signalsText(s),
      s.lowerCircuit, s.upperCircuit,
      typeof s.band === 'number' ? `${s.band}%` : s.band === 'none' ? 'F&O (no fixed band)' : null,
      ...CONVICTION_FACTORS.flatMap((f) => {
        const u = used.get(f.key);
        return u ? [Math.round(u.value * 100), round(u.weight)] : [null, null];
      }),
      c?.missing?.length ? c.missing.join(', ') : null,
    ];
  });

  const breakdown = [['Symbol', 'Direction', 'Conviction', 'Factor', 'Weight used', 'Factor score (0–100)', 'Explanation']];
  for (const s of stocks) {
    for (const f of s.conviction?.factors ?? []) {
      breakdown.push([s.symbol, s.conviction.direction === 'up' ? 'Gap-up' : 'Gap-down', s.conviction.score,
        f.label, round(f.weight), Math.round(f.value * 100), f.detail]);
    }
  }

  const scored = stocks.filter((s) => s.convictionScore != null).length;
  const settingsRows = [
    ['Factor', 'In the score', 'Weight set', 'Share of score', 'What it measures'],
    ...CONVICTION_FACTORS.map((f) => [f.label, weights[f.key] ? 'Yes' : 'No',
      cleanWeight(factorSettings?.[f.key]?.weight) ?? DEFAULT_FACTOR_SETTINGS[f.key].weight,
      weights[f.key] ? `${shares[f.key]}%` : '0%', f.help]),
    [],
    ['Exported at (IST)', istStamp(exportedAt)],
    ['Pre-open data', meta.source ?? ''],
    ['Stocks in this file', stocks.length],
    ['Stocks with a conviction score', scored],
    ...(meta.filters ? [['Table filters', meta.filters]] : []),
    [],
    ['Notes'],
    ['Each factor scores 0–100 in the direction of the gap; the conviction is their weighted average, rescaled over the factors with data.'],
    [`Buy/sell orders count at ${FNO_ORDERS_SHARE * 100}% of their weight for F&O stocks (see the weight column per stock).`],
    [`Gaps under ${MIN_GAP_PCT}% and rows with inconsistent NSE data are not scored.`],
    [`T2T and circuit-locked stocks are capped at ${BLOCKED_SCORE_CAP} ("Score before cap" shows the uncapped score).`],
  ];

  return buildXlsx([
    {
      name: 'Stocks',
      rows: [header, ...rows],
      widths: [14, 30, 24, 14, 11, 11, 9, 9, 11, 13, 11, 10, 11, 14, 18, 26, 12, 12, 16,
        ...CONVICTION_FACTORS.flatMap(() => [12, 11]), 30],
    },
    { name: 'Conviction factors', rows: settingsRows, widths: [30, 12, 11, 14, 100], filter: false },
    { name: 'Breakdown', rows: breakdown, widths: [14, 10, 11, 24, 12, 18, 110] },
  ]);
}
