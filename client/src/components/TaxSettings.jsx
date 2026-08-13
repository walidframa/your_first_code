import { useEffect, useState } from 'react';
import { Percent, Save } from 'lucide-react';
import api from '../api';
import { Button, Card, Input, Skeleton, useToast } from './ui';

/**
 * What the shop adds to a sale, if anything.
 *
 * This was an environment variable set to eight per cent, which meant every
 * shop that charges no tax — most small ones here — was adding eight per cent
 * to every sale with no way to reach the setting doing it. A number that lands
 * on every receipt a customer keeps belongs on a screen the shop can open.
 *
 * Off is the honest default. A shop that should be charging tax knows it and
 * will come here; a shop that should not would never have thought to look.
 */
export default function TaxSettings() {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [percent, setPercent] = useState('0');
  const [name, setName] = useState('Tax');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/settings').then((res) => {
      const s = res.data.settings;
      setSettings(s);
      setEnabled(String(s.tax_enabled) === 'true');
      setPercent(String(s.tax_percent ?? 0));
      setName(s.tax_name || 'Tax');
    });
  }, []);

  const percentNum = Number(percent);
  const valid = !enabled || (Number.isFinite(percentNum) && percentNum > 0 && percentNum <= 100);
  const dirty =
    settings &&
    (enabled !== (String(settings.tax_enabled) === 'true') ||
      percentNum !== Number(settings.tax_percent ?? 0) ||
      name !== (settings.tax_name || 'Tax'));

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.put('/settings', {
        tax_enabled: enabled ? 'true' : 'false',
        tax_percent: percentNum || 0,
        tax_name: name.trim() || 'Tax',
      });
      setSettings(res.data.settings);
      toast(enabled ? `${name.trim() || 'Tax'} set to ${percentNum}%` : 'Tax turned off');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-start gap-2">
        <Percent size={16} className="mt-0.5 shrink-0 text-slate-400" />
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Tax</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Added to every sale and shown on the receipt. Off unless your shop actually charges it.
          </p>
        </div>
      </div>

      {!settings ? (
        <Skeleton className="mt-4 h-32" />
      ) : (
        <form onSubmit={save} className="mt-4 space-y-4">
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
            />
            <span className="text-sm text-slate-800">
              Charge tax on sales
              <span className="block text-xs text-slate-500">
                Off means no tax line at all — not a line reading zero.
              </span>
            </span>
          </label>

          {enabled && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Rate"
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                hint="A percentage — 11 means eleven per cent."
                required
              />
              <Input
                label="Called"
                value={name}
                onChange={(e) => setName(e.target.value)}
                hint="What it says on the receipt: VAT, TVA, Tax."
              />
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <Button type="submit" loading={saving} disabled={!valid || !dirty}>
            <Save size={15} /> {dirty ? 'Save changes' : 'Saved'}
          </Button>
        </form>
      )}
    </Card>
  );
}
