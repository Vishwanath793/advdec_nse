import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from './platform/index.js';
import { normalizeProfile, profileHash } from './utils/aiContext.js';

/**
 * AI Analyst: read-only research questions about an Analyzer snapshot,
 * answered on the backend from structured results and indexed documents.
 * Answers are plain text (never HTML); [E1]/[D1] markers open the source cards.
 */

const SUGGESTED = [
  { q: 'Why does this stock have this conviction score?', needsStock: true },
  { q: 'Why did this stock pass or fail my current filters?', needsStock: true },
  { q: 'What supports this gap continuing, and what contradicts it?', needsStock: true },
  { q: "What is missing or stale in this stock's analysis?", needsStock: true },
  { q: 'What happened after similar recorded setups?', needsStock: true },
  { q: 'Why is market cap blank, and which source supplies it?', needsStock: true },
  { q: 'Compare the selected stocks using this trading day\'s data.', needsStocks: 2 },
  { q: 'Which stocks satisfy conviction above 70 and gap between 1 and 3?' },
  { q: "Summarize the selected day's breadth and sector activity." },
  { q: 'How does this morning compare with recorded mornings?' },
  { q: 'Explain the difference between conviction, quality, History and Auction.' },
];

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) + ' IST' : '—');
/** "2026-10-23T09:10" typed as IST -> ISO. */
const istInputToIso = (v) => (v ? new Date(`${v}:00+05:30`).toISOString() : null);
const isoToIstInput = (iso) => {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  return d.toISOString().slice(0, 16);
};
const SOURCE_LABEL = { structured: 'App data', doc: 'Project document', glossary: 'Factor glossary', note: 'Research note', summary: 'Day summary', outcome: 'Outcome summary', tv: 'TV research' };

/** Answer text with [E1]/[D2] markers as buttons that open the source card. */
function CitedText({ text, onCite }) {
  const parts = String(text ?? '').split(/(\[[ED]\d{1,3}\])/g);
  return parts.map((p, i) => {
    const m = /^\[([ED]\d{1,3})\]$/.exec(p);
    return m
      ? <button key={i} type="button" className="ai-cite" onClick={() => onCite(m[1])} aria-label={`Show source ${m[1]}`}>{m[1]}</button>
      : <Fragment key={i}>{p}</Fragment>;
  });
}

function ClaimList({ title, items, onCite, className = '' }) {
  if (!items?.length) return null;
  return (
    <div className={`ai-section ${className}`}>
      <h4>{title}</h4>
      <ul>
        {items.map((c, i) => (
          <li key={i}>
            {c.kind === 'hypothesis' && <span className="ai-tag">hypothesis</span>}
            {c.claim ?? c.item}{' '}
            {c.sources?.map((id) => <button key={id} type="button" className="ai-cite" onClick={() => onCite(id)}>{id}</button>)}
            {c.unsupportedNumbers?.length > 0 && <span className="ai-warn-inline"> (not found in the source: {c.unsupportedNumbers.join(', ')})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceCard({ s, open, onToggle }) {
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(false);
  const showFull = async () => {
    setLoading(true);
    try { setFull((await api.ai.source(s.chunkId)).text); } catch (e) { setFull(`Could not load: ${e.message}`); } finally { setLoading(false); }
  };
  return (
    <div className={`ai-source ${open ? 'open' : ''}`} id={`ai-src-${s.id}`}>
      <button type="button" className="ai-source-head" onClick={onToggle} aria-expanded={open}>
        <span className="ai-source-id">{s.id}</span>
        <span className="ai-source-title">{s.title}</span>
        <span className="ai-source-type">{SOURCE_LABEL[s.sourceType] ?? s.sourceType ?? s.kind}</span>
        {s.retrospective && <span className="ai-tag retro">retrospective</span>}
        {s.methodology && <span className="ai-tag">current method</span>}
        {s.suspicious && <span className="ai-tag warn">instruction-like text (ignored)</span>}
      </button>
      {open && (
        <div className="ai-source-body">
          <dl className="ai-times">
            {s.date && (<><dt>Trading date</dt><dd>{s.date}</dd></>)}
            {s.exchangeAt && (<><dt>Exchange time</dt><dd>{fmtTime(s.exchangeAt)}</dd></>)}
            {s.fetchedAt && (<><dt>Fetched</dt><dd>{fmtTime(s.fetchedAt)}</dd></>)}
            <dt>Available</dt><dd>{s.availableAt ? fmtTime(s.availableAt) : 'not established'}</dd>
            {s.ingestedAt && (<><dt>Indexed</dt><dd>{fmtTime(s.ingestedAt)}</dd></>)}
            {s.ref && (<><dt>Source</dt><dd className="mono">{s.ref}</dd></>)}
            {s.matchedBy && (<><dt>Matched by</dt><dd>{s.matchedBy.join(', ')}</dd></>)}
          </dl>
          <pre className="ai-excerpt">{full ?? s.excerpt}</pre>
          {s.chunkId && full == null && <button type="button" className="btn ghost" onClick={showFull} disabled={loading}>{loading ? 'Loading…' : 'Show the whole passage'}</button>}
        </div>
      )}
    </div>
  );
}

function Answer({ r }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const cite = (id) => {
    setOpen((cur) => new Set(cur).add(id));
    setTimeout(() => document.getElementById(`ai-src-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
  };
  // The model's list, then the coverage check's findings it didn't mention (same text once).
  const missing = [];
  for (const m of [
    ...(r.missing ?? []),
    ...(r.coverage?.stale ?? []).map((item) => ({ item: `Stale: ${item}` })),
    ...(r.coverage?.missing ?? []).map((item) => ({ item })),
  ]) if (!missing.some((x) => x.item.includes(m.item) || m.item.includes(x.item))) missing.push(m);
  const c = r.checks ?? {};
  const warnings = [
    ...(c.policyNotes ?? []),
    c.unknownCitations?.length ? `The model cited ids that were not supplied (${c.unknownCitations.join(', ')}); they were removed.` : null,
    c.droppedClaims?.length ? `${c.droppedClaims.length} claim(s) without a valid source were removed.` : null,
    c.unsupportedNumbers?.some((u) => u.in === 'answer') ? `Numbers not found in the cited sources: ${c.unsupportedNumbers.filter((u) => u.in === 'answer').map((u) => u.number).join(', ')}. Check them against the sources.` : null,
    c.refusedCalls?.length ? `Refused function calls: ${c.refusedCalls.join(', ')} (read-only research only).` : null,
    c.parseError,
  ].filter(Boolean);
  return (
    <div className="ai-answer">
      <div className="ai-meta">
        <span className="badge unchanged">{r.mode === 'as-known' ? 'As known' : 'Retrospective'}</span>
        <span className="hint">Data date {r.dataDate} · cutoff {fmtTime(r.cutoff)} · {r.snapshot?.source === 'analyzer' ? 'Analyzer view' : 'recorded morning'}{r.cached ? ' · from cache' : ''}</span>
      </div>
      <p className={`ai-text ${r.insufficient ? 'insufficient' : ''}`}><CitedText text={r.answer} onCite={cite} /></p>
      {warnings.map((w) => <div key={w} className="alert warn ai-small">{w}</div>)}
      <ClaimList title="Supporting evidence" items={r.supporting} onCite={cite} className="support" />
      <ClaimList title="Contradicting evidence" items={r.contradicting} onCite={cite} className="contra" />
      <ClaimList title="Later outcomes (retrospective: not known at the time)" items={r.retrospective} onCite={cite} className="retro" />
      <ClaimList title="Missing or stale data" items={missing} onCite={cite} className="missing" />
      {r.retrieval && (
        <p className="hint">
          Document search: {r.retrieval.mode === 'hybrid' ? `keyword + vector (${r.retrieval.embedder})` : 'keyword only'}
          {r.retrieval.reason ? ` — ${r.retrieval.reason}` : ''}
          {r.retrieval.excluded?.afterCutoff ? ` ${r.retrieval.excluded.afterCutoff} passages after the cutoff were left out.` : ''}
          {r.retrieval.excluded?.unknownAvailability ? ` ${r.retrieval.excluded.unknownAvailability} passages with unknown availability were left out.` : ''}
        </p>
      )}
      {r.sources?.length > 0 && (
        <div className="ai-section">
          <h4>Sources</h4>
          {r.sources.map((s) => <SourceCard key={s.id} s={s} open={open.has(s.id)} onToggle={() => toggle(s.id)} />)}
        </div>
      )}
      {r.consulted?.length > 0 && <p className="hint">Also given to the model, not cited: {r.consulted.map((s) => `${s.id} ${s.title}`).join('; ')}.</p>}
      <p className="hint">{r.provider === 'mock' ? 'Mock provider (offline templates, no AI)' : r.model} · {r.usage?.calls ?? 0} provider call(s), {((r.usage?.input ?? 0) + (r.usage?.output ?? 0)).toLocaleString('en-IN')} tokens</p>
    </div>
  );
}

function StatusPanel({ status, onIndex, indexError }) {
  if (!status) return null;
  const { config, index, job, usage } = status;
  return (
    <details className="ai-status">
      <summary>
        {config.problem ? 'AI not configured' : `${config.provider === 'mock' ? 'Mock mode (offline)' : config.model}`} · index {index.docs} documents, {index.chunks} passages
        {index.embedder ? `, ${index.withVectors}/${index.chunks} with vectors` : ', keyword only'} · today {usage.calls + usage.embeddingCalls} calls, {usage.totalTokens.toLocaleString('en-IN')} tokens
      </summary>
      <div className="ai-status-body">
        <p>Generation: <strong>{config.model}</strong>. Embeddings: <strong>{config.embeddingModel ?? 'none (keyword search only)'}</strong>.</p>
        <p>
          Today: {usage.calls} answer calls, {usage.embeddingCalls} embedding calls, {usage.totalTokens.toLocaleString('en-IN')} of {usage.budget.tokens.toLocaleString('en-IN')} tokens
          ({usage.budget.calls} calls allowed). {usage.cost ? `Estimated cost ${usage.cost.amount.toFixed(4)} ${usage.cost.currency} (from configured prices).` : 'No cost estimate: prices are not configured.'}
        </p>
        <p>
          Index version {index.version}, updated {fmtTime(index.updatedAt)}.
          {' '}{Object.entries(index.bySource).map(([k, n]) => `${SOURCE_LABEL[k] ?? k}: ${n}`).join(', ')}.
          {index.suspiciousChunks ? ` ${index.suspiciousChunks} passages contain instruction-like text (treated as data).` : ''}
        </p>
        {job && <p>Indexing: {job.state}{job.progress?.stage ? ` (${job.progress.stage}${job.progress.of ? ` ${job.progress.done}/${job.progress.of}` : ''})` : ''}{job.error ? ` — ${job.error}` : ''}{job.stats ? ` — ${job.stats.added} added, ${job.stats.updated} updated, ${job.stats.removed} removed, ${job.stats.embedded} embedded` : ''}</p>}
        {status.indexQuietNow && <p className="hint">Indexing waits until 09:35 IST on trading days.</p>}
        <div className="ai-row">
          <button type="button" className="btn" onClick={() => onIndex(false)} disabled={job?.state === 'running'}>Update index (free)</button>
          {index.embedder && index.missingVectors > 0 && (
            <button type="button" className="btn" onClick={() => onIndex(true)} disabled={job?.state === 'running'}>
              {config.provider === 'mock' ? `Embed ${index.missingVectors} passages (mock, free)` : `Embed ${index.missingVectors} passages (about ${index.missingVectorTokens.toLocaleString('en-IN')} tokens)`}
            </button>
          )}
        </div>
        {indexError && <div className="alert error ai-small">{indexError}</div>}
      </div>
    </details>
  );
}

export default function AiAnalystPage({ analyzer, analyzerSymbols = [], profile, target, onTargetUsed }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [selected, setSelected] = useState('analyzer'); // 'analyzer' or a recorded snapshot id
  const [mode, setMode] = useState('as-known');
  const [cutoff, setCutoff] = useState('');
  const [symbols, setSymbols] = useState([]);
  const [symbolInput, setSymbolInput] = useState('');
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState([]); // [{ question, response?, error?, code? }]
  const [pending, setPending] = useState(false);
  const [indexError, setIndexError] = useState(null);
  const controller = useRef(null);
  const endRef = useRef(null);

  const refreshStatus = useCallback(() => {
    if (!api.ai) return;
    api.ai.status().then((s) => { setStatus(s); setStatusError(null); }).catch((e) => setStatusError(e.message));
    api.ai.snapshots().then((s) => setSnapshots(s.snapshots ?? [])).catch(() => {});
  }, []);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    if (status?.job?.state !== 'running') return undefined;
    const t = setInterval(refreshStatus, 3000);
    return () => clearInterval(t);
  }, [status?.job?.state, refreshStatus]);

  // "Ask AI" from the Analyzer: that stock, on the exact Analyzer snapshot.
  useEffect(() => {
    if (!target) return;
    setSelected('analyzer');
    setSymbols([target.symbol]);
    setQuestion(`Why does ${target.symbol} have this conviction score?`);
    onTargetUsed?.();
  }, [target, onTargetUsed]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns.length, pending]);

  const recorded = snapshots.filter((s) => s.source === 'recorded').sort((a, b) => b.date.localeCompare(a.date));
  const backendLive = snapshots.find((s) => s.source === 'analyzer');
  const recordedChoice = recorded.find((s) => s.snapshotId === selected);
  const snapshotInfo = selected === 'analyzer' ? backendLive : recordedChoice;

  function analysisContext() {
    if (selected === 'analyzer') return analyzer?.context ?? null;
    if (!recordedChoice) return null;
    const p = normalizeProfile(profile);
    return { source: 'recorded', snapshotId: recordedChoice.snapshotId, profile: p, profileHash: profileHash(p) };
  }

  const addSymbol = (raw) => {
    const s = raw.trim().toUpperCase();
    if (!s || symbols.includes(s) || symbols.length >= 5) return;
    setSymbols([...symbols, s]);
    setSymbolInput('');
  };

  async function ask(q = question) {
    const text = q.trim();
    const analysis = analysisContext();
    if (!text || pending || !analysis) return;
    const history = turns.filter((t) => t.response).slice(-6).map((t) => ({ question: t.question, answer: t.response.answer }));
    setTurns((cur) => [...cur, { question: text }]);
    setQuestion('');
    setPending(true);
    controller.current = new AbortController();
    try {
      const response = await api.ai.ask({ question: text, history, analysis, mode, cutoff: mode === 'as-known' ? istInputToIso(cutoff) : null, symbols }, controller.current.signal);
      setTurns((cur) => cur.map((t, i) => (i === cur.length - 1 ? { ...t, response } : t)));
    } catch (e) {
      const cancelled = e.name === 'AbortError';
      setTurns((cur) => cur.map((t, i) => (i === cur.length - 1 ? { ...t, error: cancelled ? 'Cancelled.' : e.message, code: cancelled ? 'cancelled' : e.code } : t)));
    } finally {
      setPending(false);
      controller.current = null;
      refreshStatus();
    }
  }

  const startIndex = async (embed) => {
    setIndexError(null);
    try { await api.ai.index(embed); } catch (e) { setIndexError(e.message); }
    refreshStatus();
  };

  if (!api.ai) {
    return (
      <div className="settings-page ai-page">
        <h2>AI Analyst <span className="badge unchanged">Read-only research</span></h2>
        <div className="alert info">
          The AI Analyst runs on the PC backend, which keeps the AI provider key. This app has no secure backend connection,
          so it is unavailable here. Use the browser version on the PC (the key is never put in the Android app).
        </div>
      </div>
    );
  }

  const problem = status?.config?.problem;
  const analyzerUnavailable = selected === 'analyzer' && !analyzer?.context;
  const stockQuestion = (s) => (s.needsStocks ? symbols.length >= s.needsStocks : s.needsStock ? symbols.length >= 1 : true);

  return (
    <div className="settings-page ai-page">
      <div className="ai-header">
        <h2>AI Analyst</h2>
        <span className="badge unchanged">Read-only research</span>
        <span className="hint">Explains recorded data with sources. It cannot place, change or cancel orders or change settings, and its scores are rankings, not win probabilities.</span>
      </div>

      {statusError && <div className="alert error">Could not reach the AI Analyst on the backend: {statusError}</div>}
      {problem && (
        <div className="alert warn">
          <strong>AI not configured.</strong> {problem}
          <ul className="ai-setup">
            <li>Real answers: in the backend <code>.env</code> set <code>AI_PROVIDER=openai</code>, <code>AI_API_KEY=…</code> and optionally <code>AI_MODEL</code> / <code>AI_EMBEDDING_MODEL</code>, then restart the backend.</li>
            <li>Try it offline at no cost: <code>AI_PROVIDER=mock</code> (template answers from the same data and sources).</li>
            <li>Details: <code>docs/ai-analyst.md</code>. The rest of the app works without any of this.</li>
          </ul>
        </div>
      )}
      {status?.quietNow && <div className="alert info">Questions pause {status.config.quietWindow.from}–{status.config.quietWindow.to} IST on trading days so the opening window has the backend to itself.</div>}

      <div className="ai-controls">
        <label>
          Snapshot
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="analyzer">Analyzer view{analyzer?.context ? ` (${analyzer.context.date})` : ' (not available)'}</option>
            {recorded.map((s) => <option key={s.snapshotId} value={s.snapshotId}>Recorded morning {s.date}</option>)}
          </select>
        </label>
        <div className="ai-mode" role="group" aria-label="Research mode">
          <button type="button" className={`btn ${mode === 'as-known' ? 'primary' : 'ghost'}`} onClick={() => setMode('as-known')}>As known at the selected time</button>
          <button type="button" className={`btn ${mode === 'retrospective' ? 'primary' : 'ghost'}`} onClick={() => setMode('retrospective')}>Retrospective research</button>
        </div>
        {mode === 'as-known' && (
          <label>
            Cutoff (IST)
            <input type="datetime-local" value={cutoff} onChange={(e) => setCutoff(e.target.value)} placeholder="snapshot time" />
            <span className="hint">{cutoff ? '' : `Blank = when the snapshot became available${snapshotInfo?.recordedAt ? ` (${fmtTime(snapshotInfo.recordedAt)})` : ''}.`}</span>
            {cutoff && <button type="button" className="btn ghost" onClick={() => setCutoff('')}>Use the snapshot time</button>}
          </label>
        )}
        <div className="ai-symbols">
          <span>Stocks</span>
          {symbols.map((s) => (
            <span key={s} className="ai-chip">{s}<button type="button" onClick={() => setSymbols(symbols.filter((x) => x !== s))} aria-label={`Remove ${s}`}>×</button></span>
          ))}
          {symbols.length < 5 && (
            <>
              <input
                list="ai-symbol-list"
                value={symbolInput}
                onChange={(e) => setSymbolInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSymbol(symbolInput); } }}
                placeholder="Add a symbol"
                aria-label="Add a stock symbol"
              />
              <button type="button" className="btn ghost" onClick={() => addSymbol(symbolInput)}>Add</button>
              <datalist id="ai-symbol-list">{analyzerSymbols.slice(0, 3000).map((s) => <option key={s} value={s} />)}</datalist>
            </>
          )}
        </div>
      </div>
      {selected === 'analyzer' && analyzer?.reason && <div className="alert info">{analyzer.reason}</div>}
      {selected === 'analyzer' && analyzer?.context && backendLive && backendLive.snapshotId !== analyzer.context.snapshotId && (
        <div className="alert warn">The backend has a different pre-open snapshot ({backendLive.date}) from the one on your Analyzer. Reload the page so both match.</div>
      )}

      <StatusPanel status={status} onIndex={startIndex} indexError={indexError} />

      <div className="ai-suggested">
        {SUGGESTED.map((s) => (
          <button key={s.q} type="button" className="btn ghost" disabled={pending || !stockQuestion(s) || analyzerUnavailable || Boolean(problem)} onClick={() => ask(s.q)} title={stockQuestion(s) ? '' : 'Add a stock first'}>
            {s.q}
          </button>
        ))}
      </div>

      <div className="ai-chat" aria-live="polite">
        {turns.length === 0 && <p className="hint">Pick a snapshot, optionally add stocks, then ask. Each answer lists its sources, what supports and contradicts it, and what data is missing.</p>}
        {turns.map((t, i) => (
          <div key={i} className="ai-turn">
            <div className="ai-question">{t.question}</div>
            {t.response && <Answer r={t.response} />}
            {t.error && (
              <div className={`alert ${t.code === 'cancelled' ? 'info' : 'error'}`}>
                {t.error}
                {t.code === 'stale' && <> <button type="button" className="btn ghost" onClick={() => window.location.reload()}>Reload</button></>}
              </div>
            )}
          </div>
        ))}
        {pending && (
          <div className="ai-pending">
            <span className="hint">Reading the data and sources…</span>
            <button type="button" className="btn danger" onClick={() => controller.current?.abort()}>Cancel</button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form className="ai-ask" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}
          placeholder="Ask about the selected snapshot, e.g. why INFY's conviction is 90"
          maxLength={2000}
          rows={2}
          aria-label="Question"
        />
        <div className="ai-row">
          <button type="submit" className="btn primary" disabled={pending || !question.trim() || analyzerUnavailable || Boolean(problem)}>Ask</button>
          <button type="button" className="btn ghost" onClick={() => { controller.current?.abort(); setTurns([]); }} disabled={!turns.length && !pending}>Clear answers</button>
          <button type="button" className="btn ghost" onClick={() => { controller.current?.abort(); setTurns([]); setSymbols([]); setQuestion(''); setCutoff(''); }}>New conversation</button>
        </div>
      </form>
    </div>
  );
}
