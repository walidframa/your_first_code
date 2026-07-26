import { useState } from 'react';
import { cx, money } from './ui';

/*
 * Chart colors are the validated tokens from index.css:
 *   viz-primary #059669  (single-series magnitude / trend)
 *   viz-cash    #2a78d6  · viz-card #eb6834  (the only 2-series categorical pair)
 * Marks follow the shared spec: bars capped in thickness with a 4px rounded
 * data-end, hairline solid axes, 2px surface gaps, labels in ink not series color.
 */

const AXIS = '#c3c2b7';
const GRID = '#e1e0d9';

function shortDate(iso) {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

/** Toggle between the plot and its table twin — every value stays reachable. */
function ViewToggle({ view, setView }) {
  return (
    <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
      {['chart', 'table'].map((v) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={cx(
            'rounded-md px-2 py-1 capitalize transition',
            view === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          )}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------- Revenue over time (column) */

export function RevenueChart({ data }) {
  const [view, setView] = useState('chart');
  const [hover, setHover] = useState(null);

  if (!data.length) {
    return <p className="px-5 pb-5 text-sm text-slate-400">No sales in this period.</p>;
  }

  const max = niceCeil(Math.max(...data.map((d) => d.revenue)));
  // The viewBox aspect matches the rendered card width so the plot fills its
  // container instead of being letterboxed by preserveAspectRatio.
  const width = 1280;
  const height = 280;
  const padding = { top: 16, right: 16, bottom: 34, left: 64 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const band = plotW / data.length;
  const barW = Math.min(24, Math.max(6, band * 0.55));
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(data.length / 8);

  return (
    <div className="px-5 pb-4">
      <div className="mb-2 flex justify-end">
        <ViewToggle view={view} setView={setView} />
      </div>

      {view === 'table' ? (
        <div className="max-h-[200px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-left text-xs text-slate-500">
              <tr>
                <th className="py-1.5 font-medium">Day</th>
                <th className="py-1.5 text-right font-medium">Orders</th>
                <th className="py-1.5 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {data.map((d) => (
                <tr key={d.day} className="border-t border-slate-50">
                  <td className="py-1.5 text-slate-600">{d.day}</td>
                  <td className="py-1.5 text-right text-slate-600">{d.orders}</td>
                  <td className="py-1.5 text-right font-medium text-slate-800">{money(d.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-auto w-full"
            role="img"
            aria-label="Daily revenue"
          >
            {ticks.map((t) => {
              const y = padding.top + plotH - (t / max) * plotH;
              return (
                <g key={t}>
                  <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke={GRID} strokeWidth="1" />
                  <text x={padding.left - 10} y={y + 4} textAnchor="end" fontSize="12" fill="#79808f" className="tnum">
                    ${Math.round(t).toLocaleString()}
                  </text>
                </g>
              );
            })}

            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={padding.top + plotH}
              y2={padding.top + plotH}
              stroke={AXIS}
              strokeWidth="1"
            />

            {data.map((d, i) => {
              const barH = max ? (d.revenue / max) * plotH : 0;
              const x = padding.left + i * band + (band - barW) / 2;
              const y = padding.top + plotH - barH;
              const isHover = hover === i;
              return (
                <g key={d.day}>
                  {/* Hit target spans the full band so hovering never requires precision. */}
                  <rect
                    x={padding.left + i * band}
                    y={padding.top}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  />
                  {barH > 0 && (
                    <rect
                      x={x}
                      y={y}
                      width={barW}
                      height={barH}
                      rx="4"
                      fill="var(--color-viz-primary)"
                      opacity={hover === null || isHover ? 1 : 0.45}
                      style={{ transition: 'opacity 120ms' }}
                    />
                  )}
                  {/* Label on the interval, plus the final day only when it won't crowd. */}
                  {(i % labelEvery === 0 ||
                    (i === data.length - 1 && (data.length - 1) % labelEvery > labelEvery / 2)) && (
                    <text
                      x={padding.left + i * band + band / 2}
                      y={height - 10}
                      textAnchor="middle"
                      fontSize="12"
                      fill="#79808f"
                    >
                      {shortDate(d.day)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {hover !== null && (
            <div
              className="pointer-events-none absolute -top-1 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg"
              style={{
                left: `${((padding.left + hover * band + band / 2) / width) * 100}%`,
                transform: 'translateX(-50%)',
              }}
            >
              <span className="font-medium">{money(data[hover].revenue)}</span>
              <span className="text-slate-300">
                {' '}
                · {data[hover].orders} order{data[hover].orders === 1 ? '' : 's'}
              </span>
              <div className="text-slate-400">{data[hover].day}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------- Top sellers (bars) */

export function TopSellers({ products }) {
  if (!products.length) {
    return <p className="px-5 pb-5 text-sm text-slate-400">No sales in this period.</p>;
  }
  const max = Math.max(...products.map((p) => p.unitsSold));

  return (
    <ul className="space-y-2.5 px-5 pb-5">
      {products.map((p) => (
        <li key={p.name}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate text-slate-700">{p.name}</span>
            <span className="tnum shrink-0 text-slate-500">
              <span className="font-medium text-slate-800">{p.unitsSold}</span> · {money(p.revenue)}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full"
              style={{ width: `${(p.unitsSold / max) * 100}%`, background: 'var(--color-viz-primary)' }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------- Payment mix (2-series stacked) */

export function PaymentMix({ mix }) {
  const total = mix.reduce((sum, m) => sum + m.revenue, 0);
  if (!total) {
    return <p className="px-5 pb-5 text-sm text-slate-400">No payments in this period.</p>;
  }

  const cash = mix.find((m) => m.payment_method === 'cash') || { revenue: 0, orders: 0 };
  const card = mix.find((m) => m.payment_method === 'card') || { revenue: 0, orders: 0 };

  const segments = [
    { key: 'cash', label: 'Cash', color: 'var(--color-viz-cash)', ...cash },
    { key: 'card', label: 'Card', color: 'var(--color-viz-card)', ...card },
  ].filter((s) => s.revenue > 0);

  return (
    <div className="px-5 pb-5">
      {/* 2px surface gaps separate the segments — no borders drawn on the marks. */}
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
        {segments.map((s) => (
          <div
            key={s.key}
            style={{ width: `${(s.revenue / total) * 100}%`, background: s.color }}
            className="h-full first:rounded-l-full last:rounded-r-full"
          />
        ))}
      </div>

      <ul className="mt-3 space-y-1.5">
        {[
          { key: 'cash', label: 'Cash', color: 'var(--color-viz-cash)', ...cash },
          { key: 'card', label: 'Card', color: 'var(--color-viz-card)', ...card },
        ].map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: s.color }}
              aria-hidden="true"
            />
            <span className="text-slate-600">{s.label}</span>
            <span className="tnum ml-auto text-slate-500">
              {s.orders} order{s.orders === 1 ? '' : 's'}
            </span>
            <span className="tnum w-20 text-right font-medium text-slate-800">{money(s.revenue)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
