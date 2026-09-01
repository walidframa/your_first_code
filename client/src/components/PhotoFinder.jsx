import { useEffect, useRef, useState } from 'react';
import { ImageOff, Images, RotateCcw, Square } from 'lucide-react';
import api from '../api';
import { Button, Modal, ModalActions, ProductThumb, useToast } from './ui';

/**
 * Going and getting a picture for everything on the shelf that has none.
 *
 * The register is a wall of tiles, and a tile with no picture is a coloured
 * monogram — legible, but nothing a cashier recognises at a glance. A shop that
 * typed nine hundred products in has nine hundred of them, and photographing
 * each one is a week nobody has.
 *
 * Three things this screen exists to do, beyond pressing start:
 *
 *  - **Show the work as it happens.** A run over a large catalogue takes
 *    minutes. A spinner for four minutes is indistinguishable from a hang, so
 *    every picture appears the moment it lands and the count moves with it.
 *  - **Let it be stopped.** Twenty products in is enough to see whether the
 *    matches are any good. Stopping keeps what it has already done.
 *  - **Let it be undone.** It is a machine guessing from a name, and it will
 *    sometimes be confidently wrong — a cable that comes back as a garden hose.
 *    One button puts the whole run back; the × on a row puts one back.
 */
export default function PhotoFinder({ open, onClose, onChanged }) {
  const toast = useToast();
  const [pending, setPending] = useState(null);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /*
   * Whether anything has actually changed, so the catalogue behind is reloaded
   * once on the way out rather than on every poll — a product list carrying a
   * picture per row is not a cheap thing to fetch.
   */
  const changed = useRef(false);

  async function refresh() {
    const { data } = await api.get('/products/photos/pending');
    setPending(data.pending);
    setRun(data.run?.started ? data.run : null);
    return data.run;
  }

  useEffect(() => {
    if (!open) return undefined;
    changed.current = false;
    setError('');
    refresh().catch(() => setError('Could not read the catalogue'));
    return undefined;
  }, [open]);

  /*
   * Poll only while something is running.
   *
   * A second is fast enough to feel live and slow enough that a run of nine
   * hundred does not answer a thousand requests it did not need. The interval
   * is torn down the moment the run stops, so a finished screen left open is
   * not quietly talking to the server all afternoon.
   */
  useEffect(() => {
    if (!open || !run?.running) return undefined;
    const timer = setInterval(async () => {
      try {
        const { data } = await api.get('/products/photos/run');
        setRun(data.run);
        if (data.run.found > 0) changed.current = true;
        if (!data.run.running) setPending((p) => Math.max(0, (p ?? 0) - data.run.found));
      } catch {
        // A poll that fails is not the run failing; the next one will say.
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [open, run?.running]);

  async function startRun() {
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post('/products/photos/run', {});
      setRun(data.run);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not start looking');
    } finally {
      setBusy(false);
    }
  }

  async function stopRun() {
    try {
      const { data } = await api.post('/products/photos/run/stop', {});
      setRun(data.run);
    } catch {
      setError('Could not stop it');
    }
  }

  async function undo(productId = null) {
    try {
      const { data } = await api.post('/products/photos/run/undo', { productId });
      setRun(data.run);
      changed.current = true;
      await refresh();
      toast(productId ? 'Put back' : `${data.undone} put back`);
    } catch {
      setError('Could not put that back');
    }
  }

  function close() {
    if (changed.current) onChanged?.();
    onClose();
  }

  if (!open) return null;

  const running = Boolean(run?.running);
  const results = (run?.results || []).filter((r) => !r.undone);
  const progress = run?.total ? Math.round((run.done / run.total) * 100) : 0;

  return (
    <Modal
      open
      onClose={close}
      title="Find pictures"
      subtitle="From each product's name, for everything still without one"
      size="full"
    >
      <div className="flex h-full min-h-0 flex-col gap-4">
        {/* What it is about to do, or what it is doing. */}
        <div className="rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
          {running ? (
            <>
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-medium text-slate-800">
                  Looking… {run.done} of {run.total}
                </p>
                <p className="tnum text-sm text-slate-500">
                  {run.found} found · {run.missed} not found
                </p>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-brand-600 transition-[width] duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </>
          ) : run?.started ? (
            <p className="text-sm text-slate-700">
              Finished. <span className="font-semibold">{run.found}</span> picture
              {run.found === 1 ? '' : 's'} found
              {run.missed > 0 && `, ${run.missed} the libraries had nothing for`}
              {pending ? ` · ${pending} still without one` : ''}.
            </p>
          ) : (
            <p className="text-sm text-slate-700">
              {pending === null
                ? 'Counting…'
                : pending === 0
                  ? 'Every product already has a picture.'
                  : `${pending} product${pending === 1 ? '' : 's'} have no picture.`}
            </p>
          )}
        </div>

        {/*
          * Said before the button is pressed rather than in a help page.
          *
          * A shop is about to put pictures it has never seen onto its own
          * catalogue, from libraries it did not choose. It should know that
          * before, not find out from a customer.
          */}
        {!run?.started && (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
            These come from public picture libraries and are matched on the name alone, so some will
            be wrong — check them afterwards. Where each one came from is kept on the product, and
            the whole run can be put back with one press.
          </p>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        {/* What it has found, newest first, so the last one in is at the top. */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl ring-1 ring-slate-200">
          {results.length === 0 ? (
            <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-slate-400">
              <Images size={28} />
              <p className="text-sm">{running ? 'Nothing yet…' : 'Nothing found yet'}</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {results.map((r) => (
                <li key={r.productId} className="flex items-center gap-3 px-3 py-2">
                  <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl ring-1 ring-slate-200">
                    <ProductThumb product={{ name: r.name, image_url: r.image }} size="fill" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{r.name}</p>
                    <p className="truncate text-xs text-slate-500">{r.source || r.provider}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => undo(r.productId)}
                    aria-label={`Put back the picture for ${r.name}`}
                  >
                    <ImageOff size={14} /> Put back
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={close}>
            Close
          </Button>
          {results.length > 0 && !running && (
            <Button type="button" variant="secondary" onClick={() => undo(null)}>
              <RotateCcw size={16} /> Put them all back
            </Button>
          )}
          {running ? (
            <Button type="button" variant="secondary" onClick={stopRun} disabled={run.stopping}>
              <Square size={16} /> {run.stopping ? 'Stopping…' : 'Stop'}
            </Button>
          ) : (
            <Button type="button" className="flex-1" loading={busy} disabled={!pending} onClick={startRun}>
              <Images size={16} /> {run?.started ? 'Look again' : 'Find pictures'}
            </Button>
          )}
        </ModalActions>
      </div>
    </Modal>
  );
}
