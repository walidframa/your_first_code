import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, XCircle } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import ColumnPicker from '../../components/ColumnPicker';
import { useColumns } from '../../lib/tableColumns';
import { RevenueChart, TopSellers, PaymentMix } from '../../components/charts';
import { Badge, Card, CardHeader, LoadError, Skeleton, cx, money } from '../../components/ui';

const RANGES = [
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
  { key: 'all', label: 'All time', days: null },
];

const dayKey = (d) => d.toISOString().slice(0, 10);

/**
 * The API returns only days that had sales. Pad the gaps with zeros so the
 * column chart reads as a continuous trend rather than a few floating bars.
 */
function fillDays(byDay, rangeDays) {
  const known = new Map(byDay.map((d) => [d.day, d]));
  const today = new Date();

  let span = rangeDays;
  if (!span) {
    const earliest = byDay[0]?.day;
    if (!earliest) return [];
    const days = Math.round((today - new Date(earliest)) / 86400000) + 1;
    span = Math.min(Math.max(days, 7), 30);
  }
  span = Math.min(span, 90);

  const out = [];
  for (let i = span - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    out.push(known.get(key) || { day: key, revenue: 0, orders: 0 });
  }
  return out;
}

/**
 * When the shop is busy.
 *
 * A shopkeeper decides who is on the counter on Saturday and whether it is
 * worth opening at nine, and neither question is answerable from a daily
 * total. Bars rather than a line: these are separate hours, not a journey
 * through one.
 */
/**
 * Which panels this screen shows.
 *
 * A dashboard is one screen answering a dozen questions, and no two shops ask
 * the same dozen. The owner pricing a delivery wants what is sitting still;
 * whoever is looking at the counter's week wants the hours. So they are
 * chosen, and — like the catalogue's columns — kept on the device rather than
 * in the database, because the tablet at the counter and the laptop in the
 * back office are different jobs.
 *
 * What is stored is the set turned *off*, so a panel added in a later version
 * arrives for everybody instead of a saved layout freezing this screen at the
 * panels that existed the day it was saved.
 */
const PANELS = [
  { key: 'headline', label: 'The figures along the top', fixed: true },
  { key: 'revenue', label: 'Daily revenue' },
  { key: 'hours', label: 'Busiest hours' },
  { key: 'sellers', label: 'Top sellers' },
  { key: 'mix', label: 'Payment mix' },
  { key: 'restock', label: 'Needs restocking' },
  { key: 'slow', label: 'Sitting still' },
];

function BusiestHours({ hours }) {
  if (!hours?.length) {
    return <p className="px-5 pb-5 text-sm text-slate-500">Nothing was rung up in this period.</p>;
  }
  const busiest = Math.max(...hours.map((h) => h.revenue));
  const clock = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;

  return (
    <ul className="space-y-1.5 px-5 pb-5">
      {hours.map((h) => (
        <li key={h.hour} className="flex items-center gap-3 text-sm">
          <span className="tnum w-12 shrink-0 text-slate-500">{clock(h.hour)}</span>
          <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
            <span
              className="block h-full rounded-full bg-brand-500"
              style={{ width: `${Math.max(3, (h.revenue / busiest) * 100)}%` }}
            />
          </span>
          <span className="tnum w-20 shrink-0 text-right font-medium text-slate-700">
            {money(h.revenue)}
          </span>
          <span className="tnum w-12 shrink-0 text-right text-xs text-slate-500">
            {h.orders} {h.orders === 1 ? 'sale' : 'sales'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Money asleep on the shelf.
 *
 * The opposite question to "what sells", and the one no other screen answers:
 * a shop can see what is running out and not what it is stuck with. Sorted by
 * what it is worth at cost rather than by how many there are, because forty
 * cheap cables and one dead phone are not the same problem.
 */
function SlowMovers({ products, tiedUp }) {
  if (!products?.length) {
    return <p className="px-5 pb-5 text-sm text-slate-500">Everything on the shelf sold at least once.</p>;
  }
  return (
    <>
      <p className="px-5 pb-2 text-sm text-slate-600">
        <span className="tnum font-semibold text-slate-900">{money(tiedUp)}</span> sitting still in
        the top {products.length}
      </p>
      <ul className="space-y-2 px-5 pb-5">
        {products.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-slate-700" title={p.sku}>
              {p.name}
            </span>
            <span className="shrink-0 text-right">
              <span className="tnum font-medium text-slate-800">{money(p.tiedUp)}</span>
              <span className="tnum ml-2 text-xs text-slate-500">{p.stock} left</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function StatTile({ label, value, hint }) {
  return (
    <Card className="px-4 py-3.5">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </Card>
  );
}

export default function Dashboard() {
  const [summary, setSummary] = useState(null);
  const [range, setRange] = useState('30d');
  const panels = useColumns('dashboard', PANELS);
  const shows = (key) => panels.visible.some((p) => p.key === key);
  const [refreshing, setRefreshing] = useState(false);
  const [accounts, setAccounts] = useState(null);
  const [failed, setFailed] = useState(null);
  // Bumped to ask for the figures again after a failure.
  const [attempt, setAttempt] = useState(0);

  /*
   * A `.then()` with no `.catch()` left this screen on its skeleton for ever
   * when the request failed, which reads as "still loading" and never stops.
   * The refusal is held instead, and shown.
   */
  useEffect(() => {
    const selected = RANGES.find((r) => r.key === range);
    const params = {};
    if (selected.days) {
      const from = new Date();
      from.setDate(from.getDate() - selected.days);
      params.from = from.toISOString().slice(0, 19).replace('T', ' ');
    }

    setRefreshing(true);
    setFailed(null);
    api
      .get('/reports/summary', { params })
      .then((res) => setSummary(res.data))
      .catch((err) => setFailed(err))
      .finally(() => setRefreshing(false));
  }, [range, attempt]);

  // Balances are a running position, not scoped to the selected date range.
  // A failure here dims one card rather than the screen, so it is swallowed on
  // purpose — `accounts` staying null is already the "not known" rendering.
  useEffect(() => {
    api
      .get('/accounts/summary')
      .then((res) => setAccounts(res.data))
      .catch(() => setAccounts(null));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Dashboard"
        subtitle="Sales performance and stock health"
        actions={
          /* One filter row scoping every chart below. */
          <div className="flex max-w-full overflow-x-auto rounded-lg bg-slate-100 p-0.5 text-sm font-medium">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={cx(
                  'shrink-0 rounded-md px-3 py-1.5 whitespace-nowrap transition',
                  range === r.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      >
        {/* Beside the period, because both are choices about the screen
            underneath and belong where it can be seen changing. */}
        <ColumnPicker
          table="dashboard"
          columns={PANELS}
          hidden={panels.hidden}
          onChange={panels.setHidden}
          label="Panels"
          what="panels"
        />
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {/*
          * The failure wins even when a previous range is still in hand.
          * Holding the old figures on screen under the new range's label would
          * be a dashboard quietly answering a question nobody asked — the one
          * failure mode on this screen worse than showing nothing.
          */}
        {failed ? (
          <LoadError
            error={failed}
            onRetry={() => setAttempt((n) => n + 1)}
            what="the dashboard figures"
          />
        ) : !summary ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-[86px]" />
              ))}
            </div>
            <Skeleton className="h-[260px]" />
          </div>
        ) : (
          /* Hold the previous render at reduced opacity while refetching. */
          <div className={cx('space-y-4 transition-opacity', refreshing && 'opacity-60')}>
            <section>
              <p className="text-sm text-slate-500">Revenue</p>
              <p className="text-5xl font-semibold tracking-tight text-slate-900">
                {money(summary.revenue)}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                across {summary.orderCount} order{summary.orderCount === 1 ? '' : 's'}
              </p>
            </section>

            {accounts && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Link to="/admin/customers">
                  <Card className="px-4 py-3.5 transition hover:ring-brand-300">
                    <p className="text-xs text-slate-500">Owed to you</p>
                    <p className="mt-1 text-2xl font-semibold text-amber-700">
                      {money(accounts.receivable)}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      across {accounts.receivableParties} customer
                      {accounts.receivableParties === 1 ? '' : 's'}
                    </p>
                  </Card>
                </Link>
                <Link to="/admin/suppliers">
                  <Card className="px-4 py-3.5 transition hover:ring-brand-300">
                    <p className="text-xs text-slate-500">You owe</p>
                    <p className="mt-1 text-2xl font-semibold text-slate-900">{money(accounts.payable)}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      across {accounts.payableParties} supplier
                      {accounts.payableParties === 1 ? '' : 's'}
                    </p>
                  </Card>
                </Link>
                <Card className="px-4 py-3.5">
                  <p className="text-xs text-slate-500">Net position</p>
                  <p
                    className={cx(
                      'mt-1 text-2xl font-semibold',
                      accounts.net >= 0 ? 'text-brand-700' : 'text-red-600',
                    )}
                  >
                    {money(accounts.net)}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">receivables less payables</p>
                </Card>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile label="Orders" value={summary.orderCount} />
              <StatTile label="Average order" value={money(summary.averageOrderValue)} />
              {/* A tile reading $0.00 every day is a tile that teaches people
                  to stop reading the row it is in. */}
              {summary.taxCollected > 0 && (
                <StatTile label="Tax collected" value={money(summary.taxCollected)} />
              )}
              <StatTile label="Discounts given" value={money(summary.discountsGiven)} />
            </div>

            {shows('revenue') && (
              <Card>
                <CardHeader
                  title="Daily revenue"
                  subtitle={`Completed sales per day · ${RANGES.find((r) => r.key === range).label.toLowerCase()}`}
                />
                <RevenueChart data={fillDays(summary.byDay, RANGES.find((r) => r.key === range).days)} />
              </Card>
            )}

            {shows('hours') && (
              <Card>
                <CardHeader
                  title="Busiest hours"
                  subtitle="When the counter is actually working"
                />
                <BusiestHours hours={summary.byHour} />
              </Card>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {shows('sellers') && (
                <Card>
                  <CardHeader title="Top sellers" subtitle="By units sold" />
                  <TopSellers products={summary.topProducts} />
                </Card>
              )}

              {shows('mix') && (
                <Card>
                  <CardHeader title="Payment mix" subtitle="Revenue by tender" />
                  <PaymentMix mix={summary.paymentMix} />
                </Card>
              )}

              {shows('slow') && (
                <Card>
                  <CardHeader
                    title="Sitting still"
                    subtitle="On the shelf, unsold all period"
                    action={
                      <Link
                        to="/admin/products"
                        className="text-xs font-medium text-brand-700 hover:underline"
                      >
                        Catalogue
                      </Link>
                    }
                  />
                  <SlowMovers products={summary.slowMovers} tiedUp={summary.tiedUp} />
                </Card>
              )}

              {shows('restock') && (
              <Card>
                <CardHeader
                  title="Needs restocking"
                  subtitle="At or below reorder point"
                  action={
                    <Link
                      to="/admin/inventory"
                      className="text-xs font-medium text-brand-700 hover:underline"
                    >
                      Manage
                    </Link>
                  }
                />
                {summary.lowStock.length === 0 ? (
                  <p className="px-5 pb-5 text-sm text-slate-400">Everything is well stocked.</p>
                ) : (
                  <ul className="space-y-2 px-5 pb-5">
                    {summary.lowStock.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate text-slate-700">{p.name}</span>
                        {p.stock <= 0 ? (
                          <Badge tone="critical" icon={XCircle}>
                            Out of stock
                          </Badge>
                        ) : (
                          <Badge tone="warning" icon={AlertTriangle}>
                            {p.stock} left
                          </Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
