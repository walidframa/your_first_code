import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Lock, LockOpen } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import {
  Button, Card, EmptyState, Input, LoadError, Modal, ModalActions, Skeleton, cx, money, useToast,
} from '../../components/ui';

/**
 * Drawing a line under a year.
 *
 * Two things happen at once, and the screen says so before it does either:
 * the earnings and the spending are emptied into retained earnings, and the
 * period is shut. Presenting it as one button called "Close" would hide the
 * half people care about — after this, nobody can post into that year, and
 * that is the part a shopkeeper needs to have understood before pressing it.
 *
 * So the preview is the screen and the button is an afterthought. Account by
 * account, because "your profit was $14,000" is not something anybody can
 * check, and "sales 40,000, wages 9,000, rent 6,000" is.
 */
export default function Closing() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(null);
  const [to, setTo] = useState(() => `${new Date().getFullYear() - 1}-12-31`);
  const [confirming, setConfirming] = useState(false);
  const [reopening, setReopening] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/ledger/closings', { params: { to } });
      setData(res.data);
      setFailed(null);
    } catch (err) {
      setFailed(err);
    }
  }, [to]);

  useEffect(() => {
    load();
  }, [load]);

  if (failed) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Financial closing" />
        <Card className="m-4">
          <LoadError error={failed} what="the closings" onRetry={load} />
        </Card>
      </div>
    );
  }

  const preview = data?.preview;
  const standing = data?.closings.filter((c) => !c.reopened_at) ?? [];
  const shutThrough = standing.length > 0 ? standing[0].period_end : null;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Financial closing"
        subtitle="Empty the year into retained earnings, and shut it"
        actions={
          preview && !preview.alreadyClosed ? (
            <Button onClick={() => setConfirming(true)}>
              <Lock size={16} />
              Close to {preview.to}
            </Button>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-4xl space-y-4">
          {shutThrough && (
            <div className="flex items-start gap-2 rounded-xl bg-slate-100 px-3 py-2.5 text-sm text-slate-700 ring-1 ring-slate-200">
              <Lock size={16} className="mt-0.5 shrink-0 text-slate-500" />
              <p>
                The books are shut through{' '}
                <span className="font-medium text-slate-900">{shutThrough}</span>. Nothing can be
                posted on or before that date. Anything that happened then and is only being
                entered now is dated the day after instead, so it still reaches the books.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <Input
                label="Close up to and including"
                name="to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>

          {!preview ? (
            <Card className="p-5"><Skeleton className="h-48 w-full" /></Card>
          ) : preview.alreadyClosed ? (
            <Card>
              <EmptyState
                icon={Lock}
                title="That period is already shut"
                description={`The books are closed through ${shutThrough}. Pick a later date, or reopen the last closing below.`}
              />
            </Card>
          ) : preview.accounts.length === 0 ? (
            <Card>
              <EmptyState
                title="Nothing has been earned or spent in this period"
                description="Closing it would shut the period without moving anything, which is still worth doing if you want it locked."
              />
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-xs text-slate-500">
                {preview.from ? `${preview.from} to ${preview.to}` : `Everything up to ${preview.to}`}
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-rule">
                  <tr className="border-b border-slate-100 bg-slate-50/60">
                    <td colSpan={2} className="px-4 py-1.5 text-xs font-semibold text-slate-600">
                      What it earned
                    </td>
                  </tr>
                  {preview.accounts.filter((a) => a.type === 'income').map((a) => (
                    <AccountRow key={a.id} account={a} />
                  ))}
                  <tr className="border-b border-slate-100 bg-slate-50/60">
                    <td colSpan={2} className="px-4 py-1.5 text-xs font-semibold text-slate-600">
                      What it spent
                    </td>
                  </tr>
                  {preview.accounts.filter((a) => a.type === 'expense').map((a) => (
                    <AccountRow key={a.id} account={a} />
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-slate-300 bg-slate-50">
                  <tr>
                    <td className="px-4 py-2.5 font-semibold text-slate-800">
                      {preview.profit >= 0 ? 'Profit for the period' : 'Loss for the period'}
                      <span className="block text-xs font-normal text-slate-500">
                        {money(preview.earned)} earned less {money(preview.spent)} spent — goes to
                        3900 Retained earnings
                      </span>
                    </td>
                    <td
                      className={cx(
                        'tnum px-4 py-2.5 text-right text-base font-semibold',
                        preview.profit >= 0 ? 'text-emerald-700' : 'text-red-700',
                      )}
                    >
                      {money(Math.abs(preview.profit))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </Card>
          )}

          {data?.closings.length > 0 && (
            <Card className="overflow-hidden">
              <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-600">
                Lines already drawn
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-rule">
                  {data.closings.map((c) => (
                    <tr key={c.id} className="border-t border-slate-100 first:border-t-0">
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-slate-800">{c.period_end}</span>
                        <span className="block text-xs text-slate-500">
                          {c.entry_number ? `${c.entry_number} · ` : ''}
                          closed by {c.closed_by_name || 'somebody'}
                          {c.reopened_at
                            ? ` · reopened by ${c.reopened_by_name || 'somebody'}`
                            : ''}
                        </span>
                      </td>
                      <td className="tnum px-4 py-2.5 text-right text-slate-700">
                        {money(c.profit_usd)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {c.reopened_at ? (
                          <span className="text-xs text-slate-400">reopened</span>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => setReopening(c)}>
                            <LockOpen size={14} />
                            Reopen
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </div>

      {confirming && preview && (
        <CloseModal
          preview={preview}
          onClose={() => setConfirming(false)}
          onDone={() => {
            setConfirming(false);
            toast(`Books closed to ${preview.to}`);
            load();
          }}
          onError={(err) => toast(err.response?.data?.error || 'Could not close the books', 'error')}
        />
      )}

      {reopening && (
        <ReopenModal
          closing={reopening}
          onClose={() => setReopening(null)}
          onDone={() => {
            setReopening(null);
            toast('Reopened');
            load();
          }}
          onError={(err) => toast(err.response?.data?.error || 'Could not reopen it', 'error')}
        />
      )}
    </div>
  );
}

function AccountRow({ account }) {
  return (
    <tr className="border-t border-slate-100">
      <td className="px-4 py-2">
        <span className="font-mono text-xs text-slate-400">{account.code}</span>{' '}
        <span className="text-slate-800">{account.name}</span>
      </td>
      <td className="tnum px-4 py-2 text-right text-slate-900">{money(account.balance)}</td>
    </tr>
  );
}

function CloseModal({ preview, onClose, onDone, onError }) {
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await api.post('/ledger/closings', { to: preview.to });
      onDone();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Close the books to ${preview.to}`}
      subtitle="Two things at once"
      footer={
        <ModalActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={saving}>Draw the line</Button>
        </ModalActions>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="space-y-2.5">
          <p className="text-slate-700">
            <span className="font-medium">One.</span> {money(preview.earned)} earned and{' '}
            {money(preview.spent)} spent come out of this year's accounts, and{' '}
            <span className="font-medium">
              {money(Math.abs(preview.profit))} {preview.profit >= 0 ? 'profit' : 'loss'}
            </span>{' '}
            goes to 3900 Retained earnings. Next year starts from nothing.
          </p>
          <p className="text-slate-700">
            <span className="font-medium">Two.</span> Everything on or before {preview.to} is shut.
            Nothing can be posted into it by hand after this.
          </p>
        </div>

        {/* The reassurance that matters most, because the fear it answers is
            the reason shopkeepers put this off until their accountant does it
            for them. */}
        <div className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-slate-600 ring-1 ring-slate-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-slate-400" />
          <p className="text-xs">
            The shop keeps trading. Sales, invoices and repairs still post — anything for a shut
            date is dated the day after instead, so nothing is lost. And this can be undone: the
            closing is reversed rather than deleted, so the books show that a line was drawn and
            then rubbed out.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function ReopenModal({ closing, onClose, onDone, onError }) {
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await api.post(`/ledger/closings/${closing.id}/reopen`);
      onDone();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Reopen ${closing.period_end}`}
      footer={
        <ModalActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={saving}>Reopen it</Button>
        </ModalActions>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <p>
          The {money(closing.profit_usd)} moved into retained earnings comes back to the accounts it
          came from, and the period accepts entries again.
        </p>
        <p className="text-xs text-slate-500">
          The closing entry is reversed, not deleted — both halves stay in the journal, so anybody
          reading the books can see that this year was closed and then opened again. That is the
          fact an accountant needs to see, which is why it is not tidied away.
        </p>
      </div>
    </Modal>
  );
}
