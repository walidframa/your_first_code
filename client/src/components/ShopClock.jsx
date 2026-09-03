import { useEffect, useState } from 'react';
import { Clock, Save } from 'lucide-react';
import api from '../api';
import { useSettings } from '../context/SettingsContext';
import { Button, Card, Select, Skeleton, useToast } from './ui';

/** Every zone this browser knows, for shops that are not where the server is. */
const ZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    /* An older browser: the device's own zone is still offered below. */
    return [];
  }
})();

const HERE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
})();

/** The wall clock in a zone, for the line under the box. */
function readsAs(zone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone || 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
  } catch {
    return '';
  }
}

/**
 * Where the shop is, which is where its day starts and ends.
 *
 * Every timestamp in the database is UTC and stays that way — it is
 * unambiguous, it sorts, and it survives the server being moved. This is about
 * the other half: reports are read by somebody standing in a shop, and a shop
 * three hours east of Greenwich was being shown days that ran from three in the
 * morning to three the next morning.
 *
 * What that cost, in the shop's own words: a sale rung up after midnight
 * appeared under yesterday, "today" and the register disagreed, and the
 * busiest-hours chart was three hours out.
 *
 * One setting, set once. Blank means UTC, which is what every shop was getting
 * before this existed — so nothing moves under anybody until they say where
 * they are.
 */
export default function ShopClock() {
  const toast = useToast();
  const { settings, refresh } = useSettings();
  const [zone, setZone] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /* Ticking, so the preview is a clock rather than a screenshot of one. */
  const [, tick] = useState(0);

  useEffect(() => {
    if (settings) setZone(settings.time_zone || '');
  }, [settings]);

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const dirty = settings && zone !== (settings.time_zone || '');

  async function save() {
    setSaving(true);
    setError('');
    try {
      await api.put('/settings', { time_zone: zone });
      await refresh();
      toast(zone ? `Reports now follow ${zone}` : 'Reports now follow UTC');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Clock size={15} className="text-brand-600" /> The shop&rsquo;s day
      </h2>
      <p className="mt-0.5 mb-4 text-xs text-slate-500">
        Which midnight the reports cut at. Sales are stored with the exact moment they happened;
        this decides whose day they land in — so a sale rung up at half past midnight belongs to the
        night it was made rather than to the morning after.
      </p>

      {!settings ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="space-y-3">
          <Select
            label="Time zone"
            name="time_zone"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
          >
            <option value="">UTC — no offset</option>
            {ZONES.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>

          <p className="tnum text-xs text-slate-500">
            Reports read <span className="font-medium text-slate-700">{readsAs(zone)}</span>
            {HERE && HERE !== (zone || 'UTC') && (
              <>
                {' · '}this device says {readsAs(HERE)} ({HERE.replace(/_/g, ' ')})
              </>
            )}
          </p>

          {/*
            * The commonest answer, in one press. The shop is almost always in
            * the same place as the person setting this up, and typing a zone
            * name from memory is how "Asia/Beiruit" gets saved.
            */}
          {HERE && HERE !== zone && (
            <button
              type="button"
              onClick={() => setZone(HERE)}
              className="text-xs font-medium text-brand-700 transition hover:underline"
            >
              Use this device&rsquo;s zone ({HERE.replace(/_/g, ' ')})
            </button>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <Button onClick={save} loading={saving} disabled={!dirty}>
            <Save size={15} /> {dirty ? 'Save' : 'Saved'}
          </Button>
        </div>
      )}
    </Card>
  );
}
