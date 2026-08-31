import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  Link2,
  Link2Off,
  Loader2,
  Plug,
  RefreshCw,
  Store,
} from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  Select,
  Skeleton,
  cx,
  useToast,
} from '../../components/ui';

/** "2 minutes ago" reads better than a timestamp for something that just ran. */
function ago(iso) {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/* ------------------------------------------------------------- connecting */

function ConnectForm({ onConnected }) {
  const toast = useToast();
  const [shopDomain, setShopDomain] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [locations, setLocations] = useState(null);
  const [locationId, setLocationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function connect(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/shopify/connect', { shopDomain, accessToken });
      setLocations(res.data.locations);
      setLocationId(res.data.locations[0]?.id || '');
      toast(`Connected to ${res.data.shop.name}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not connect');
    } finally {
      setBusy(false);
    }
  }

  async function chooseLocation(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const chosen = locations.find((l) => l.id === locationId);
      await api.post('/shopify/location', { locationId, locationName: chosen?.name });
      onConnected();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the location');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto max-w-xl p-6">
      <div className="mb-4 flex items-center gap-3">
        <span className="rounded-xl bg-emerald-50 p-2 text-emerald-700 ring-1 ring-emerald-200">
          <Store size={20} />
        </span>
        <div>
          <h2 className="font-semibold text-slate-900">Connect your Shopify shop</h2>
          <p className="text-sm text-slate-500">Keep the stock on the website and in the shop the same.</p>
        </div>
      </div>

      {!locations ? (
        <form onSubmit={connect} className="space-y-3">
          <Input
            label="Shop address"
            name="shopDomain"
            placeholder="my-shop.myshopify.com"
            value={shopDomain}
            onChange={(e) => setShopDomain(e.target.value)}
          />
          <Input
            label="Admin API access token"
            name="accessToken"
            type="password"
            placeholder="shpat_…"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            hint="Shopify admin → Settings → Apps → Develop apps → your app → API credentials"
          />

          <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
            The app needs these scopes:{' '}
            <code className="text-slate-800">read_products</code>,{' '}
            <code className="text-slate-800">read_inventory</code>,{' '}
            <code className="text-slate-800">write_inventory</code>,{' '}
            <code className="text-slate-800">read_locations</code>.
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <Button type="submit" className="w-full" loading={busy} disabled={!shopDomain || !accessToken}>
            <Plug size={16} /> Connect
          </Button>
        </form>
      ) : (
        <form onSubmit={chooseLocation} className="space-y-3">
          <Select
            label="Which location is this shop?"
            name="locationId"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-slate-500">
            Stock is synced against this location only, so a warehouse's stock is left alone.
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full" loading={busy}>
            <Check size={16} /> Use this location
          </Button>
        </form>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------- page */

export default function Shopify() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [statusRes, logRes] = await Promise.all([api.get('/shopify/status'), api.get('/shopify/log')]);
    setStatus(statusRes.data);
    setLog(logRes.data.log);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(name, fn, success) {
    setError('');
    setBusy(name);
    try {
      const result = await fn();
      if (success) toast(success(result));
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work');
    } finally {
      setBusy('');
    }
  }

  if (!status) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Shopify" subtitle="Keep website and shop stock in step" />
        <div className="p-6">
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (!status.connected) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Shopify" subtitle="Keep website and shop stock in step" />
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <ConnectForm onConnected={load} />
        </div>
      </div>
    );
  }

  const differing = status.links.filter((l) => l.differs);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Shopify"
        subtitle={`${status.shopDomain}${status.locationName ? ` · ${status.locationName}` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              loading={busy === 'sync'}
              onClick={() =>
                run(
                  'sync',
                  () => api.post('/shopify/sync'),
                  (res) =>
                    `Synced — ${res.data.applied.length} in, ${res.data.pushed.length} out`,
                )
              }
            >
              <RefreshCw size={16} /> Sync now
            </Button>
            <Button
              variant={status.enabled ? 'primary' : 'subtle'}
              loading={busy === 'toggle'}
              onClick={() =>
                run(
                  'toggle',
                  () => api.post('/shopify/enabled', { enabled: !status.enabled }),
                  () => (status.enabled ? 'Automatic sync paused' : 'Automatic sync on'),
                )
              }
            >
              {status.enabled ? <Check size={16} /> : null}
              {status.enabled ? 'Syncing' : 'Paused'}
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
        {error && (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">{error}</p>
        )}

        {!status.enabled && (
          <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            Automatic sync is paused. Stock changes are still recorded and will be sent when you switch it
            back on.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Linked products', status.linkedCount, null],
            ['Not linked', status.unlinkedCount, status.unlinkedCount > 0 ? 'text-amber-600' : null],
            ['Waiting to send', status.queueDepth, status.queueDepth > 0 ? 'text-amber-600' : null],
            ['Last sync', ago(status.lastSync), null],
          ].map(([label, value, tone]) => (
            <Card key={label} className="px-4 py-3">
              <p className="text-xs text-slate-500">{label}</p>
              <p className={cx('mt-1 text-2xl font-semibold text-slate-900', tone)}>{value}</p>
            </Card>
          ))}
        </div>

        {status.unlinkedCount > 0 && (
          <Card className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="font-medium text-slate-900">
                {status.unlinkedCount} product{status.unlinkedCount === 1 ? '' : 's'} not linked yet
              </p>
              <p className="text-sm text-slate-500">
                Matching pairs them with Shopify variants by SKU, then by barcode.
              </p>
            </div>
            <Button
              loading={busy === 'match'}
              onClick={() =>
                run(
                  'match',
                  () => api.post('/shopify/match'),
                  (res) => `Linked ${res.data.matched.length}, ${res.data.unmatched.length} left over`,
                )
              }
            >
              <Link2 size={16} /> Match by SKU
            </Button>
          </Card>
        )}

        {differing.length > 0 && (
          <Card>
            <CardHeader
              title={`${differing.length} product${differing.length === 1 ? '' : 's'} disagree`}
              subtitle="Choose which figure is right. A sync will not guess for you."
              action={
                differing.length > 1 && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-slate-400">Settle all as</span>
                    {[
                      ['local', 'This shop'],
                      ['shopify', 'Shopify'],
                    ].map(([keep, label]) => (
                      <Button
                        key={keep}
                        size="sm"
                        variant="secondary"
                        loading={busy === `all-${keep}`}
                        onClick={() =>
                          run(
                            `all-${keep}`,
                            () => api.post('/shopify/reconcile', { keep }),
                            (res) => `Settled ${res.data.settled.length} product(s)`,
                          )
                        }
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                )
              }
            />
            <table className="w-full text-sm">
              <thead className="border-y border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 text-right font-medium">Here</th>
                  <th className="px-3 py-2 text-right font-medium">Shopify</th>
                  <th className="px-5 py-2 text-right font-medium">Keep</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {differing.map((link) => (
                  <tr key={link.productId}>
                    <td className="px-5 py-2.5">
                      <p className="font-medium text-slate-800">{link.name}</p>
                      <p className="text-xs text-slate-400">{link.sku}</p>
                    </td>
                    <td className="tnum px-3 py-2.5 text-right font-semibold text-slate-900">
                      {link.localStock}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right font-semibold text-slate-900">
                      {link.shopifyQty ?? '—'}
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === `keep-local-${link.productId}`}
                          onClick={() =>
                            run(
                              `keep-local-${link.productId}`,
                              () =>
                                api.post('/shopify/reconcile', { productId: link.productId, keep: 'local' }),
                              () => `Shopify set to ${link.localStock}`,
                            )
                          }
                        >
                          This shop
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === `keep-shopify-${link.productId}`}
                          onClick={() =>
                            run(
                              `keep-shopify-${link.productId}`,
                              () =>
                                api.post('/shopify/reconcile', { productId: link.productId, keep: 'shopify' }),
                              () => `Stock set to ${link.shopifyQty}`,
                            )
                          }
                        >
                          Shopify
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        <Card>
          <CardHeader title="Linked products" subtitle="What each side is holding" />
          {status.links.length === 0 ? (
            <EmptyState
              icon={Link2Off}
              title="Nothing linked yet"
              description="Match your products to Shopify variants to start syncing."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-y border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">On Shopify</th>
                  <th className="px-3 py-2 text-right font-medium">Here</th>
                  <th className="px-3 py-2 text-right font-medium">Shopify</th>
                  <th className="px-3 py-2 font-medium">Synced</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {status.links.map((link) => (
                  <tr key={link.productId} className={cx(link.differs && 'bg-amber-50/40')}>
                    <td className="px-5 py-2.5">
                      <p className="font-medium text-slate-800">{link.name}</p>
                      <p className="text-xs text-slate-400">{link.sku}</p>
                    </td>
                    <td className="max-w-xs truncate px-3 py-2.5 text-slate-500">{link.shopifyTitle || '—'}</td>
                    <td className="tnum px-3 py-2.5 text-right text-slate-700">{link.localStock}</td>
                    <td className="tnum px-3 py-2.5 text-right text-slate-700">{link.shopifyQty ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      {link.lastError ? (
                        <Badge tone="critical" icon={AlertTriangle}>
                          {link.lastError.slice(0, 40)}
                        </Badge>
                      ) : link.differs ? (
                        <Badge tone="warning" icon={ArrowLeftRight}>
                          differs
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-400">{ago(link.lastSyncedAt)}</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <button
                        onClick={() =>
                          run(
                            `unlink-${link.productId}`,
                            () => api.delete(`/shopify/links/${link.productId}`),
                            () => `${link.name} unlinked`,
                          )
                        }
                        aria-label={`Unlink ${link.name}`}
                        className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                      >
                        {busy === `unlink-${link.productId}` ? (
                          <Loader2 size={15} className="animate-spin" />
                        ) : (
                          <Link2Off size={15} />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent activity" subtitle="What the sync has been doing" />
          {log.length === 0 ? (
            <EmptyState icon={RefreshCw} title="Nothing yet" description="Sync activity will appear here." />
          ) : (
            <ul className="divide-y divide-rule">
              {log.map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 px-5 py-2 text-sm">
                  <Badge
                    tone={
                      entry.direction === 'error' ? 'critical' : entry.direction === 'pull' ? 'info' : 'good'
                    }
                  >
                    {entry.direction}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-slate-600">
                    {entry.product_name ? `${entry.product_name} — ` : ''}
                    {entry.detail}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{ago(entry.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="pb-2">
          <Button
            variant="secondary"
            loading={busy === 'disconnect'}
            onClick={() =>
              run('disconnect', () => api.post('/shopify/disconnect'), () => 'Shopify disconnected')
            }
          >
            <Link2Off size={16} /> Disconnect
          </Button>
          <p className="mt-1.5 text-xs text-slate-400">
            Links are kept, so reconnecting the same shop will not mean matching everything again.
          </p>
        </div>
      </div>
    </div>
  );
}
