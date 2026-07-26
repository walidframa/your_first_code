import { useEffect, useState } from 'react';
import api from '../../api';

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function StatCard({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    api.get('/reports/summary').then((res) => setSummary(res.data));
  }, []);

  if (!summary) {
    return <div className="p-6 text-slate-400">Loading dashboard…</div>;
  }

  const maxRevenue = Math.max(...summary.byDay.map((d) => d.revenue), 1);

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold text-slate-800">Sales Dashboard</h1>

      <div className="mb-6 grid grid-cols-4 gap-4">
        <StatCard label="Revenue" value={money(summary.revenue)} />
        <StatCard label="Orders" value={summary.orderCount} />
        <StatCard label="Avg order" value={money(summary.averageOrderValue)} />
        <StatCard label="Tax collected" value={money(summary.taxCollected)} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 font-medium text-slate-700">Revenue (last 14 days)</h2>
          {summary.byDay.length === 0 && <p className="text-sm text-slate-400">No sales yet.</p>}
          <div className="space-y-2">
            {summary.byDay.map((d) => (
              <div key={d.day} className="flex items-center gap-2 text-xs">
                <span className="w-20 shrink-0 text-slate-500">{d.day}</span>
                <div className="h-4 flex-1 rounded bg-slate-100">
                  <div
                    className="h-4 rounded bg-emerald-500"
                    style={{ width: `${(d.revenue / maxRevenue) * 100}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right font-medium text-slate-700">{money(d.revenue)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 font-medium text-slate-700">Top sellers</h2>
            {summary.topProducts.length === 0 && <p className="text-sm text-slate-400">No sales yet.</p>}
            {summary.topProducts.map((p) => (
              <div key={p.name} className="flex justify-between border-b border-slate-50 py-1.5 text-sm last:border-0">
                <span className="text-slate-600">{p.name}</span>
                <span className="text-slate-800">
                  {p.unitsSold} sold · {money(p.revenue)}
                </span>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 font-medium text-slate-700">Low stock alerts</h2>
            {summary.lowStock.length === 0 && <p className="text-sm text-slate-400">All products well stocked.</p>}
            {summary.lowStock.map((p) => (
              <div key={p.id} className="flex justify-between border-b border-slate-50 py-1.5 text-sm last:border-0">
                <span className="text-slate-600">{p.name}</span>
                <span className={p.stock === 0 ? 'font-medium text-red-600' : 'text-amber-600'}>
                  {p.stock} left
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
