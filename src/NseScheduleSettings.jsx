import { useEffect, useState } from 'react';

export function formatIST(value) {
  return value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : '—';
}

export default function NseScheduleSettings({ data, connectionError, onUpdate }) {
  const [enabled, setEnabled] = useState(true);
  const [time, setTime] = useState('09:10');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (data?.config) {
      setEnabled(data.config.enabled);
      setTime(data.config.time);
    }
  }, [data?.config.enabled, data?.config.time]);

  async function request(path, options, success) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(path, options);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'NSE request failed.');
      onUpdate(payload);
      setMessage({ type: 'info', text: success });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally { setBusy(false); }
  }

  return (
    <section className="settings-card">
      <h3>NSE pre-open data</h3>
      <p className="hint">Fetch NSE data daily and automatically populate the Analyzer. Keep this computer awake and the backend running at the scheduled time. The browser can be closed.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        request('/api/nse/schedule', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: values.has('enabled'), time: values.get('time') }),
        }, 'NSE schedule saved.');
      }}>
        <label className="field checkbox">
          <span><input name="enabled" type="checkbox" checked={enabled} disabled={busy || !data} onChange={(event) => setEnabled(event.target.checked)} /> Enable daily fetch</span>
        </label>
        <label className="field">
          <span>Daily fetch time (Indian Standard Time, UTC+05:30)</span>
          <input name="time" type="time" value={time} required disabled={busy || !data} onInput={(event) => setTime(event.currentTarget.value)} onChange={(event) => setTime(event.target.value)} />
        </label>
        <div className="row gap">
          <button className="btn primary" disabled={busy || !data}>Save NSE schedule</button>
          <button type="button" className="btn" disabled={busy || !data || data.running} onClick={() => request('/api/nse/preopen/refresh', { method: 'POST' }, 'NSE data loaded into the Analyzer.')}>
            {busy || data?.running ? 'Working…' : 'Fetch now'}
          </button>
        </div>
      </form>
      {message && <div role="status" className={`alert ${message.type}`}>{message.text}</div>}
      {connectionError && <div className="alert error">{connectionError}</div>}
      <div className="session-box">
        <div><strong>Next fetch:</strong> {data?.config.enabled ? formatIST(data.nextRun) : data ? 'Disabled' : 'Loading…'}</div>
        <div><strong>Last attempt:</strong> {formatIST(data?.lastAttempt)}</div>
        <div><strong>Last successful fetch:</strong> {formatIST(data?.snapshot?.fetchedAt)}</div>
        <div><strong>NSE data timestamp:</strong> {data?.snapshot?.marketUpdatedAt ? `${data.snapshot.marketUpdatedAt} IST` : '—'}</div>
        {data?.lastError && <div className="alert error">{data.lastError} Previous successful data is retained.</div>}
      </div>
      <p className="hint">On holidays and weekends, NSE may return the previous trading session. Missed runs while the backend is stopped are not replayed; use Fetch now.</p>
    </section>
  );
}
