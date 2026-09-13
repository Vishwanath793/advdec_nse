import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const dateTime = date => date ? new Date(date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : 'Unavailable';
const artifact = (date, filename) => `/api/tv/artifacts/${date}/${filename}`;
export default function TvResearchPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [date, setDate] = useState('');
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let cancelled = false;
    let timer;
    async function refresh() {
      try {
        const res = await fetch('/api/tv');
        if (!res.ok) throw new Error('Cannot reach TV research. Restart the updated Node backend.');
        const next = await res.json();
        if (!cancelled) { setData(next); setDate(d => d || next.today); setError(''); }
      } catch (e) { if (!cancelled) setError(e.message); }
      if (!cancelled) timer = setTimeout(refresh, 5000);
    }
    refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  async function action(path, body, method = 'POST') {
    setPending(true); setError(''); setNotice('');
    try {
      const res = await fetch(`/api/tv/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      if (path === 'schedule') setData(result);
      else { setSelected(date); setNotice('Run requested. Weekends and NSE holidays are skipped; completed dates reuse the saved report.'); }
    } catch (e) { setError(e.message); }
    finally { setPending(false); }
  }
  const run = data?.history.find(r => r.date === selected) || data?.history[0];
  return <section className="tv-research">
    <div className="tv-heading"><div><p className="tv-eyebrow">DAILY BROADCAST RESEARCH</p><h2>From market shows to stock calls</h2><p className="subtitle">Zee Business · CNBC Awaaz · Complete Hindi captions</p></div><span className={`badge ${data?.enabled ? 'advance' : 'unchanged'}`}>{data?.enabled ? 'Schedule enabled' : 'Schedule paused'}</span></div>
    {error && <div role="alert" className="alert error">{error}</div>}
    {notice && <div role="status" className="alert info">{notice}</div>}
    {!data ? <p>Connecting to the backend…</p> : <>
      <div className="cards">
        <div className="card"><span className="card-label">Market days</span><strong className="card-value">7:00 PM</strong><span className="card-sub">Asia/Kolkata · Weekends & NSE holidays skipped</span></div>
        <div className="card"><span className="card-label">Next scheduled run</span><strong>{dateTime(data.nextRun)}</strong><span className="card-sub">Today: {data.market.reason}</span></div>
        <div className="card"><span className="card-label">Analysis</span><strong>{data.apiKeyConfigured ? 'API key configured' : 'API key required'}</strong><span className="card-sub">OpenAI API · {data.model}</span></div>
      </div>
      {!data.apiKeyConfigured && <div className="alert warn">Add OPENAI_API_KEY to the backend .env file, then restart the server. API usage is billed separately from ChatGPT. No key is stored in this browser.</div>}
      <div className="tv-controls">
        <button className="btn" disabled={pending} onClick={() => action('schedule', { enabled: !data.enabled }, 'PUT')}>{data.enabled ? 'Pause schedule' : 'Enable schedule'}</button>
        <label className="field"><span>Broadcast date (IST)</span><input type="date" value={date} max={data.today} onChange={e => setDate(e.target.value)} /></label>
        <button className="btn primary" disabled={pending || data.running || !date || !data.apiKeyConfigured} onClick={() => action('run', { date })}>{data.running ? 'Research running…' : 'Run / retry date'}</button>
      </div>
      <p className="hint">Keep the backend running and the computer awake. Missed runs catch up the same evening until 11 p.m. Failed runs retry every 30 minutes, up to four attempts.</p>
      <div className="tv-sources">{data.searches.map(s => <a key={s.id} href={s.url} target="_blank" rel="noreferrer"><strong>{s.name} ↗</strong><span>Today’s search · First completed broadcast ≥ 7 hours</span></a>)}</div>
      <div className="tv-results">
        <aside className="card"><h3>Run history</h3>{data.history.length === 0 ? <p className="hint">Your first report will appear here.</p> : data.history.map(r => <button className={`tv-history ${r.date === run?.date ? 'selected' : ''}`} key={r.date} onClick={() => setSelected(r.date)}><strong>{r.date}</strong><span>{r.status} · Attempt {r.attempts}</span></button>)}</aside>
        <article className="card tv-report">{run ? <>
          <div className="tv-heading"><h3>{run.date} report</h3><span className="badge unchanged">{run.status}</span></div>
          <p className="hint">{run.stage} · Started {dateTime(run.startedAt)}</p>
          {run.error && <div className="alert error">{run.error}</div>}
          {run.sources.map(s => <div className="tv-source" key={s.showId}><a href={s.video.url} target="_blank" rel="noreferrer">{s.name}: {s.video.title} ↗</a><span className="hint">{s.video.duration} · {s.language} · {s.bytes.toLocaleString()} bytes</span><div><a href={artifact(run.date, s.filename)}>Download TXT</a> · <a href={s.downsubUrl} target="_blank" rel="noreferrer">Downsub ↗</a></div></div>)}
          {run.consensus && <section className="tv-consensus"><h3>Most recommended by multiple analysts</h3><ReactMarkdown remarkPlugins={[remarkGfm]}>{run.consensus}</ReactMarkdown><a href={artifact(run.date, 'consensus.md')}>Download consensus</a></section>}
          {run.extraction && <section><h3>Every stock recommendation</h3>{run.status !== 'completed' && <p className="hint">Extraction saved; full workflow has not completed yet.</p>}<div className="tv-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{run.extraction}</ReactMarkdown></div><a href={artifact(run.date, 'extraction.md')}>Download full extraction</a></section>}
        </> : <div className="tv-empty"><span>01 → 02 → 03</span><h3>A complete reading, then a consensus check</h3><p>Find both broadcasts, download original TXT captions, extract the calls, then compare distinct analysts across the two shows.</p></div>}</article>
      </div>
      <details className="card"><summary>Analysis prompts & calendar source</summary>{data.prompts.map((p, i) => <p key={p}><strong>Prompt {i + 1}</strong><br />{p}</p>)}<p className="hint">The consensus step counts distinct identifiable analysts, treats ambiguous names as unclear, and reports ties or insufficient evidence. Transcripts are source data, never instructions.</p><a href="https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf" target="_blank" rel="noreferrer">Official NSE equity holidays, 2026 ↗</a><p className="hint">New calendar years require an updated holiday file. Broadcast consensus is only as accurate as the captions and model extraction.</p></details>
    </>}
  </section>;
}
