/**
 * 09:15–09:20 candidate chart (plain SVG, no chart library): the five
 * one-minute candles (approximate: built from sampled ticks), the opening-range
 * high/low, Kite's VWAP at 09:20, volume bars, and the plan's entry, stop and targets.
 */
const W = 560;
const H = 280;
const PAD = { l: 8, r: 92, t: 10, b: 8 };
const VOL_H = 54;

export default function OpeningChart({ d, plan }) {
  const candles = (d.candles ?? []).map((c, i) => (c ? { ...c, i } : null)).filter(Boolean);
  if (!candles.length) return <p className="hint">No candles yet.</p>;
  const lines = [
    { y: d.orHigh, label: 'Range high', cls: 'line-range' },
    { y: d.orLow, label: 'Range low', cls: 'line-range' },
    d.vwap ? { y: d.vwap, label: 'VWAP', cls: 'line-vwap' } : null,
    ...(plan ? [
      { y: plan.trigger, label: `Entry ${plan.side === 'BUY' ? '≥' : '≤'}`, cls: 'line-entry' },
      { y: plan.stop, label: 'Stop', cls: 'line-stop' },
      { y: plan.target1, label: 'T1', cls: 'line-target' },
      { y: plan.target2, label: 'T2', cls: 'line-target' },
    ] : []),
  ].filter((x) => x && Number.isFinite(x.y));
  const prices = [...candles.flatMap((c) => [c.h, c.l]), ...lines.map((x) => x.y)];
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = (hi - lo) * 0.06 || hi * 0.002;
  lo -= pad; hi += pad;
  const priceH = H - PAD.t - PAD.b - VOL_H - 10;
  const y = (p) => PAD.t + ((hi - p) / (hi - lo)) * priceH;
  const slot = (W - PAD.l - PAD.r) / 5;
  const x = (i) => PAD.l + slot * i + slot / 2;
  const maxVol = Math.max(1, ...candles.map((c) => c.volume ?? 0));
  const volTop = H - PAD.b - VOL_H;
  // Keep labels apart when lines are close.
  const labelled = [...lines].sort((a, b) => y(a.y) - y(b.y));
  let lastY = -Infinity;
  for (const l of labelled) { l.ly = Math.max(y(l.y), lastY + 11); lastY = l.ly; }

  return (
    <svg className="opening-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${d.symbol} 09:15 to 09:20 one-minute candles with range, VWAP and the trade plan`}>
      {lines.map((l) => (
        <g key={l.label + l.y}>
          <line className={l.cls} x1={PAD.l} x2={W - PAD.r} y1={y(l.y)} y2={y(l.y)} />
          <text className={`chart-label ${l.cls}`} x={W - PAD.r + 4} y={l.ly + 3}>{l.label} {l.y.toFixed(2)}</text>
        </g>
      ))}
      {candles.map((c) => {
        const up = c.c >= c.o;
        const top = y(Math.max(c.o, c.c));
        const bodyH = Math.max(1, Math.abs(y(c.o) - y(c.c)));
        const vh = ((c.volume ?? 0) / maxVol) * (VOL_H - 4);
        return (
          <g key={c.i} className={up ? 'candle-up' : 'candle-down'}>
            <line x1={x(c.i)} x2={x(c.i)} y1={y(c.h)} y2={y(c.l)} />
            <rect x={x(c.i) - slot * 0.28} width={slot * 0.56} y={top} height={bodyH} />
            <rect className="vol-bar" x={x(c.i) - slot * 0.28} width={slot * 0.56} y={volTop + VOL_H - vh} height={vh} />
            <text className="chart-axis" x={x(c.i)} y={H - 1} textAnchor="middle">09:{15 + c.i}</text>
          </g>
        );
      })}
      <line className="chart-sep" x1={PAD.l} x2={W - PAD.r} y1={volTop} y2={volTop} />
    </svg>
  );
}
