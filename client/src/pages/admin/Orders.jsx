import { useEffect, useState } from 'react';
import api from '../../api';

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  async function load() {
    const res = await api.get('/orders');
    setOrders(res.data.orders);
  }

  useEffect(() => {
    load();
  }, []);

  async function openOrder(id) {
    const res = await api.get(`/orders/${id}`);
    setSelected(res.data);
    setError('');
  }

  async function refund(id) {
    try {
      await api.post(`/orders/${id}/refund`);
      setSelected(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Refund failed');
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold text-slate-800">All Orders</h1>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Order</th>
              <th className="px-4 py-3">Cashier</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Payment</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr
                key={o.id}
                onClick={() => openOrder(o.id)}
                className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
              >
                <td className="px-4 py-3 font-medium text-slate-700">{o.order_number}</td>
                <td className="px-4 py-3 text-slate-500">{o.cashier_name}</td>
                <td className="px-4 py-3 text-slate-500">{o.created_at}</td>
                <td className="px-4 py-3 capitalize text-slate-500">{o.payment_method}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      o.status === 'refunded' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
                    }`}
                  >
                    {o.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-semibold text-slate-800">{money(o.total)}</td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan="6" className="px-4 py-10 text-center text-slate-400">
                  No orders yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4" onClick={() => setSelected(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 font-semibold text-slate-900">{selected.order.order_number}</h2>
            <p className="mb-3 text-xs text-slate-400">
              {selected.order.created_at} · {selected.order.cashier_name}
            </p>
            <div className="space-y-1 border-y border-dashed border-slate-200 py-3 text-sm">
              {selected.items.map((item) => (
                <div key={item.id} className="flex justify-between">
                  <span className="text-slate-600">
                    {item.quantity} × {item.name}
                  </span>
                  <span>{money(item.line_total)}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-between py-3 font-semibold">
              <span>Total</span>
              <span>{money(selected.order.total)}</span>
            </div>

            {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

            <div className="flex gap-2">
              {selected.order.status === 'completed' && (
                <button
                  onClick={() => refund(selected.order.id)}
                  className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-medium text-white hover:bg-red-700"
                >
                  Refund order
                </button>
              )}
              <button
                onClick={() => setSelected(null)}
                className="flex-1 rounded-lg bg-slate-100 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
