import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import OrderTable from '../../components/OrderTable';
import { money } from '../../components/ui';

export default function Orders() {
  const [orders, setOrders] = useState(null);

  const load = useCallback(() => {
    api.get('/orders').then((res) => setOrders(res.data.orders));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const completed = (orders || []).filter((o) => o.status === 'completed');
  const refunded = (orders || []).filter((o) => o.status === 'refunded');
  const total = completed.reduce((sum, o) => sum + o.total, 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Orders"
        subtitle={
          orders
            ? `${completed.length} completed · ${refunded.length} refunded · ${money(total)} net`
            : 'Loading…'
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <OrderTable orders={orders} showCashier canRefund onChanged={load} />
      </div>
    </div>
  );
}
