function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

export default function Receipt({ receipt, onClose }) {
  const { order, items } = receipt;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-4 text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-xl">✅</div>
          <h2 className="text-lg font-semibold text-slate-900">Payment complete</h2>
          <p className="text-xs text-slate-400">{order.order_number}</p>
        </div>

        <div className="max-h-48 space-y-1 overflow-y-auto border-y border-dashed border-slate-200 py-3 text-sm">
          {items.map((item) => (
            <div key={item.id} className="flex justify-between">
              <span className="text-slate-600">
                {item.quantity} × {item.name}
              </span>
              <span className="text-slate-800">{money(item.line_total)}</span>
            </div>
          ))}
        </div>

        <div className="space-y-1 py-3 text-sm">
          <div className="flex justify-between text-slate-500">
            <span>Subtotal</span>
            <span>{money(order.subtotal)}</span>
          </div>
          <div className="flex justify-between text-slate-500">
            <span>Discount</span>
            <span>-{money(order.discount)}</span>
          </div>
          <div className="flex justify-between text-slate-500">
            <span>Tax</span>
            <span>{money(order.tax)}</span>
          </div>
          <div className="flex justify-between text-base font-semibold text-slate-900">
            <span>Total</span>
            <span>{money(order.total)}</span>
          </div>
          {order.payment_method === 'cash' && (
            <>
              <div className="flex justify-between text-slate-500">
                <span>Tendered</span>
                <span>{money(order.amount_tendered)}</span>
              </div>
              <div className="flex justify-between font-medium text-emerald-700">
                <span>Change due</span>
                <span>{money(order.change_due)}</span>
              </div>
            </>
          )}
        </div>

        <button
          onClick={onClose}
          className="mt-2 w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700"
        >
          New sale
        </button>
      </div>
    </div>
  );
}
