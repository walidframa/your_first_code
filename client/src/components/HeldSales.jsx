import { useEffect, useState } from 'react';
import { AlertTriangle, PauseCircle, Play, Trash2 } from 'lucide-react';
import api from '../api';
import {
  Button,
  EmptyState,
  Input,
  Modal,
  ModalActions,
  Skeleton,
  cx,
  money,
  useToast,
} from './ui';
import { useConfirm } from './ConfirmProvider';

/**
 * Put the sale down.
 *
 * The label is the whole point: a shelf of "HOLD-0007, HOLD-0008, HOLD-0009" is
 * a shelf nobody can pick from. A name, a phone number, "the man with the blue
 * case" — whatever the cashier will recognise in ten minutes.
 */
export function HoldSaleDialog({ cart, context, customer, total, onClose, onHeld }) {
  const toast = useToast();
  const [label, setLabel] = useState(customer?.name || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/held-sales', {
        label: label.trim() || null,
        note: note.trim() || null,
        cart,
        context,
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? null,
      });
      toast(`Sale held — ${res.data.held.reference}`);
      onHeld(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not hold this sale');
    } finally {
      setBusy(false);
    }
  }

  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <Modal open onClose={onClose} title="Hold this sale" subtitle="Put it to one side and take the next customer">
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-baseline justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
          <span className="text-slate-600">
            {itemCount} item{itemCount === 1 ? '' : 's'}
          </span>
          <span className="tnum font-semibold text-slate-900">{money(total)}</span>
        </div>

        <Input
          label="What to call it"
          name="heldLabel"
          placeholder="e.g. Rami · 03 123 456, or the blue case"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          hint="So you know which one to pick back up"
          autoFocus
        />
        <Input
          label="Note (optional)"
          name="heldNote"
          placeholder="e.g. gone to the ATM"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {/*
          * Said plainly, because the opposite is what a shopkeeper would assume.
          * Holding a sale does not put the stock aside — whoever pays first gets
          * it, and the cashier is told what changed when they pick it back up.
          */}
        <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          Nothing is reserved. If somebody else buys the last one meanwhile, you will be told when you pick
          this sale back up.
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy}>
            <PauseCircle size={16} /> Hold the sale
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/**
 * The shelf of sales waiting to be finished.
 *
 * Resuming hands the cart back with whatever has changed underneath it, and the
 * cashier decides what to do about that — the app does not quietly drop a line
 * or quietly sell something that is gone.
 */
export function HeldSalesDialog({ onClose, onResume, onCountChange }) {
  const toast = useToast();
  const [held, setHeld] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const confirm = useConfirm();

  useEffect(() => {
    api.get('/held-sales').then((res) => setHeld(res.data.held));
  }, []);

  async function resume(id) {
    setBusyId(id);
    try {
      const res = await api.post(`/held-sales/${id}/resume`);
      onResume(res.data);
    } catch (err) {
      toast(err.response?.data?.error || 'Could not pick that sale up', 'error');
      setBusyId(null);
    }
  }

  async function discard(id) {
    const sale = held?.find((h) => h.id === id);
    const agreed = await confirm({
      title: 'Discard this held sale?',
      body: `Everything on it is thrown away${sale?.label ? ` — ${sale.label}` : ''}. Nothing has been rung up, so nothing comes back.`,
      confirmLabel: 'Discard it',
      cancelLabel: 'Keep it',
    });
    if (!agreed) return;

    setBusyId(id);
    try {
      const res = await api.delete(`/held-sales/${id}`);
      setHeld((list) => list.filter((h) => h.id !== id));
      onCountChange?.(res.data.count);
      toast('Held sale discarded');
    } catch (err) {
      toast(err.response?.data?.error || 'Could not discard that sale', 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal open onClose={onClose} title="Held sales" subtitle="Pick one back up where it was left" size="lg">
      {!held ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : held.length === 0 ? (
        <EmptyState
          icon={PauseCircle}
          title="Nothing is being held"
          description="Hold a sale to put it to one side and take the next customer."
        />
      ) : (
        <ul className="space-y-2">
          {held.map((sale) => (
            <li
              key={sale.id}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">
                  {sale.label || sale.customerName || sale.reference}
                </p>
                <p className="text-xs text-slate-400">
                  {sale.itemCount} item{sale.itemCount === 1 ? '' : 's'} · {sale.reference} ·{' '}
                  {new Date(`${sale.heldAt}Z`).toLocaleTimeString([], { timeStyle: 'short' })}
                  {sale.heldByName ? ` · ${sale.heldByName}` : ''}
                </p>
                {sale.note && <p className="truncate text-xs text-slate-500 italic">{sale.note}</p>}
              </div>
              <span className="tnum shrink-0 text-sm font-semibold text-slate-900">{money(sale.total)}</span>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" loading={busyId === sale.id} onClick={() => resume(sale.id)}>
                  <Play size={14} /> Resume
                </Button>
                <button
                  onClick={() => discard(sale.id)}
                  aria-label={`Discard ${sale.label || sale.reference}`}
                  title="Discard"
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/**
 * What changed while the sale was on the shelf.
 *
 * Shown once, on the way back in, and then got out of the way. The cashier is
 * standing in front of the customer: they need to know the phone was sold, not
 * to be made to click through a list of it.
 */
export function ResumeIssues({ issues, onClose }) {
  if (!issues || issues.length === 0) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Some of this sale has changed"
      subtitle="Nothing was reserved while it was held"
    >
      <ul className="space-y-2">
        {issues.map((issue, i) => (
          <li
            key={`${issue.lineKey}-${i}`}
            className={cx(
              'flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm',
              issue.severity === 'gone' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800',
            )}
          >
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{issue.message}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-slate-500">
        The lines are back on the sale as they were. Change or remove whatever is no longer there before you
        charge.
      </p>
      <Button className="mt-4 w-full" onClick={onClose}>
        Got it
      </Button>
    </Modal>
  );
}
