import { useCallback, useEffect, useState } from 'react';
import { Download, HardDriveDownload, ShieldAlert } from 'lucide-react';
import api from '../api';
import { Button, Card, Skeleton, useToast } from './ui';

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Copies of the shop's books, and the one warning that goes with them.
 *
 * The whole business is one file: every sale, customer, IMEI, repair and the
 * passwords held on customers' behalf. A shop that has never thought about this
 * finds out it should have on the day the machine does not turn on.
 *
 * The warning about `server/.env` is not decoration. Those customer passwords
 * and repair passcodes are encrypted with a key that lives in that file and
 * nowhere else — a database restored without it has every one of them
 * permanently unreadable, and there is no recovering from that afterwards.
 */
export default function Backups() {
  const toast = useToast();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get('/backups');
    setState(res.data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function takeOne() {
    setBusy(true);
    try {
      const res = await api.post('/backups');
      toast(`Backup taken — ${mb(res.data.backup.bytes)}`);
      await load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not take a backup', 'error');
    } finally {
      setBusy(false);
    }
  }

  /*
   * Fetched with the session's token and handed to the browser as a file: a
   * plain link would arrive without the Authorization header and be refused.
   */
  async function download(name) {
    try {
      const res = await api.get(`/backups/${encodeURIComponent(name)}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast('Could not download that backup', 'error');
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Backups</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            One is taken automatically each day the shop is open, and the last {state?.keep ?? 14} are
            kept.
          </p>
        </div>
        <Button size="sm" loading={busy} onClick={takeOne}>
          <HardDriveDownload size={15} /> Back up now
        </Button>
      </div>

      {/*
        * Said before the list rather than after it, because somebody who copies
        * a file off this screen and stops reading has to have seen this.
        */}
      <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900">
        <ShieldAlert size={14} className="mt-px shrink-0" />
        <span>
          Download one to somewhere that is not this machine — and keep{' '}
          <code className="rounded bg-amber-100 px-1">server/.env</code> with it. The customer
          passwords and repair passcodes inside are encrypted with a key that lives in that file, and
          a backup restored without it has every one of them unreadable for good.
        </span>
      </p>

      {!state ? (
        <Skeleton className="mt-4 h-24" />
      ) : state.backups.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          None yet. Take one now — it takes a second, and it is the only thing on this page that
          matters the day something goes wrong.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {state.backups.slice(0, 8).map((b) => (
            <li key={b.name} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="tnum block truncate text-slate-800">{b.takenAt}</span>
                <span className="tnum text-xs text-slate-400">{mb(b.bytes)}</span>
              </span>
              <button
                onClick={() => download(b.name)}
                className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-700 transition hover:bg-brand-50"
              >
                <Download size={13} /> Download
              </button>
            </li>
          ))}
        </ul>
      )}

      {state && (
        <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
          Kept in <code className="rounded bg-slate-100 px-1">{state.directory}</code>. To put one
          back, stop the server and run{' '}
          <code className="rounded bg-slate-100 px-1">npm run restore -- &lt;file&gt;</code> — it is a
          command rather than a button because restoring throws away everything since the copy was
          taken.
        </p>
      )}
    </Card>
  );
}
