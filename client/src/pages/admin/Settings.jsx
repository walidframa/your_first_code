import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, History, Save } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useSettings, lbp } from '../../context/SettingsContext';
import { Button, Card, CardHeader, EmptyState, Input, Skeleton, money, useToast } from '../../components/ui';

const PREVIEW_AMOUNTS = [1, 5, 10, 25, 100];

export default function Settings() {
  const toast = useToast();
  const { settings, refresh } = useSettings();

  const [rate, setRate] = useState('');
  const [step, setStep] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(null);

  const loadHistory = useCallback(() => {
    api.get('/settings/rate-history').then((res) => setHistory(res.data.history));
  }, []);

  useEffect(() => {
    if (settings) {
      setRate(String(settings.exchange_rate));
      setStep(String(settings.lbp_rounding));
    }
  }, [settings]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const rateNum = Number(rate);
  const stepNum = Number(step);
  const valid = Number.isFinite(rateNum) && rateNum > 0 && Number.isFinite(stepNum) && stepNum >= 1;
  const dirty =
    settings && (rateNum !== settings.exchange_rate || stepNum !== settings.lbp_rounding);

  const preview = (usd) => {
    if (!valid) return 0;
    const raw = usd * rateNum;
    return stepNum > 1 ? Math.round(raw / stepNum) * stepNum : Math.round(raw);
  };

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.put('/settings', { exchange_rate: rateNum, lbp_rounding: stepNum });
      await refresh();
      loadHistory();
      toast('Exchange rate updated');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Settings"
        subtitle="Exchange rate and currency display used across the register"
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid max-w-4xl grid-cols-2 gap-4">
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-slate-900">Exchange rate</h2>
            <p className="mt-0.5 mb-4 text-xs text-slate-500">
              Products are priced in US dollars. Lebanese pounds are calculated from this rate
              everywhere in the app, so this is the only number to update.
            </p>

            {!settings ? (
              <Skeleton className="h-40" />
            ) : (
              <form onSubmit={save} className="space-y-4">
                <Input
                  label="Lebanese pounds per 1 US dollar"
                  type="number"
                  min="1"
                  step="any"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  hint="Ask around for the day's rate and set it here each morning."
                  required
                />
                <Input
                  label="Round pound amounts to the nearest"
                  type="number"
                  min="1"
                  step="1"
                  value={step}
                  onChange={(e) => setStep(e.target.value)}
                  hint="1,000 is typical — quoting to the single pound is meaningless."
                  required
                />

                {error && <p className="text-sm text-red-600">{error}</p>}

                <Button type="submit" loading={saving} disabled={!valid || !dirty}>
                  <Save size={15} /> {dirty ? 'Save changes' : 'Saved'}
                </Button>
              </form>
            )}
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader title="Preview" subtitle="What cashiers and customers will see" />
              <ul className="space-y-1.5 px-5 pb-5 text-sm">
                {PREVIEW_AMOUNTS.map((usd) => (
                  <li key={usd} className="flex items-center justify-between">
                    <span className="tnum text-slate-600">{money(usd)}</span>
                    <ArrowRight size={13} className="text-slate-300" />
                    <span className="tnum w-40 text-right font-medium text-slate-800">
                      {lbp(preview(usd))}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Rate history" subtitle="Every change, and who made it" />
              {!history ? (
                <div className="px-5 pb-5">
                  <Skeleton className="h-20" />
                </div>
              ) : history.length === 0 ? (
                <EmptyState
                  icon={History}
                  title="No changes yet"
                  description="Rate updates will be listed here."
                />
              ) : (
                <ul className="max-h-56 space-y-1.5 overflow-y-auto px-5 pb-5 text-sm">
                  {history.map((h) => (
                    <li key={h.id} className="flex items-baseline justify-between gap-3">
                      <span className="tnum font-medium text-slate-800">
                        {Number(h.rate).toLocaleString('en-US')}
                      </span>
                      <span className="truncate text-xs text-slate-400">
                        {h.created_at} · {h.user_name || 'System'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
