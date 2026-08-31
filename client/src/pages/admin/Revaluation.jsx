import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Scale, TrendingDown, TrendingUp } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import {
  Button, Card, EmptyState, LoadError, Modal, ModalActions, Skeleton, cx, money, useToast,
} from '../../components/ui';

/**
 * What the rate has done to the money the shop is already holding.
 *
 * Every pound that comes in is booked in dollars at that day's rate and stays
 * there, which is right — an entry records what something was worth when it
 * happened. But it leaves a drawer full of pounds carried at every rate the
 * shop has ever traded at, while the pounds themselves are worth whatever they
 * are worth this morning.
 *
 * So this screen is mostly working, not answer. The number at the bottom is
 * one a shopkeeper is being asked to put into their accounts, and the only way
 * to check it is to see what it was made of: the pounds actually held, the
 * rate the books are implicitly carrying them at, and the rate today. Somebody
 * who cannot recognise that first rate should not press the button, and the
 * screen is laid out so they can tell.
 */
export default function Revaluation() {
  const toast = useToast();
  const [report, setReport] = useState(null);
  const [failed, setFailed] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/ledger/revaluation');
      setReport(res.data);
      setFailed(null);
    } catch (err) {
      setFailed(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (failed) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Exchange differences" />
        <Card className="m-4">
          <LoadError error={failed} what="the revaluation" onRetry={load} />
        </Card>
      </div>
    );
  }

  const movable = report?.accounts.filter((a) => a.holdsPounds && a.difference !== 0) ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Exchange differences"
        subtitle="What the rate has done to the money you are already holding"
        actions={
          movable.length > 0 ? (
            <Button onClick={() => setConfirming(true)}>
              <Scale size={16} />
              Restate at today’s rate
            </Button>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {!report ? (
          <Card className="max-w-4xl p-5"><Skeleton className="h-56 w-full" /></Card>
        ) : report.accounts.length === 0 ? (
          <Card className="max-w-4xl">
            <EmptyState
              title="No tills to revalue"
              description="This shows the shop’s own drawers and safes against what the books say they hold. There are none yet."
            />
          </Card>
        ) : (
          <div className="max-w-4xl space-y-4">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-xl bg-slate-100 px-4 py-3 text-sm">
              <span className="text-slate-600">
                Today’s rate{' '}
                <span className="tnum font-semibold text-slate-900">
                  {report.rate.toLocaleString('en-US')}
                </span>{' '}
                to the dollar
              </span>
              {report.total !== 0 && (
                <span
                  className={cx(
                    'inline-flex items-center gap-1.5 font-medium',
                    report.total > 0 ? 'text-emerald-700' : 'text-red-700',
                  )}
                >
                  {report.total > 0 ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
                  {report.total > 0 ? 'Worth' : 'Down'} {money(Math.abs(report.total))} against the books
                </span>
              )}
            </div>

            {report.accounts.map((a) => (
              <Card key={a.id} className="overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                  <p className="text-sm font-semibold text-slate-800">
                    <span className="font-mono text-xs text-slate-400">{a.code}</span> {a.name}
                  </p>
                  <p className="text-xs text-slate-500">{a.tills.join(', ')}</p>
                </div>

                {a.holdsPounds ? (
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-rule">
                      <Row label="Pounds actually held" value={`${a.heldLbp.toLocaleString('en-US')} LL`} />
                      <Row
                        label="On the books at"
                        value={money(a.bookedLbpUsd)}
                        hint={
                          a.impliedRate
                            ? `an average of ${a.impliedRate.toLocaleString('en-US')} to the dollar`
                            : undefined
                        }
                      />
                      <Row
                        label="Worth today"
                        value={money(a.worthTodayUsd)}
                        hint={`at ${report.rate.toLocaleString('en-US')}`}
                      />
                      {/* Zero gets its own word. "Gained $0.00" is the sort of
                          line that makes somebody read the whole screen again
                          to find out what it is trying to tell them. */}
                      <Row
                        label={a.difference === 0 ? 'No change' : a.difference > 0 ? 'Gained' : 'Lost'}
                        value={a.difference === 0 ? '—' : money(Math.abs(a.difference))}
                        strong
                        tone={a.difference === 0 ? null : a.difference > 0 ? 'up' : 'down'}
                      />
                    </tbody>
                  </table>
                ) : (
                  <div className="px-4 py-3">
                    {a.unexplained === 0 ? (
                      <p className="text-sm text-slate-500">
                        No pounds in it, and the books agree with what is there. Nothing to restate.
                      </p>
                    ) : (
                      /*
                       * The one thing this screen must not do is bury a
                       * bookkeeping mistake in Exchange differences, which is
                       * the account nobody would ever look in for it. So a gap
                       * with no pounds behind it is named as what it is, and
                       * the button below will not touch it.
                       */
                      <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                        <p>
                          The books say {money(a.bookUsd)} and there is {money(a.heldUsd)} in it —{' '}
                          <span className="font-medium">{money(a.unexplained)} apart</span>, with no
                          pounds to explain it. That is not the rate moving, so restating will not
                          touch it. Something was posted here by hand, or posted twice.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            ))}

            <p className="text-xs text-slate-500">
              Restating writes one new entry dated today. The sales and payments already in the
              journal are left exactly as they are — each recorded what it was worth on the day it
              happened, and rewriting that every time the rate moves would make last month’s
              accounts disagree with themselves.
            </p>
          </div>
        )}
      </div>

      {confirming && report && (
        <ConfirmModal
          report={report}
          moving={movable}
          onClose={() => setConfirming(false)}
          onDone={() => {
            setConfirming(false);
            toast('Restated at today’s rate');
            load();
          }}
          onError={(err) => toast(err.response?.data?.error || 'Could not restate it', 'error')}
        />
      )}
    </div>
  );
}

function Row({ label, value, hint, strong, tone }) {
  return (
    <tr className="border-t border-slate-100 first:border-t-0">
      <td className="px-4 py-2.5">
        <span className={cx('text-slate-800', strong && 'font-medium')}>{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </td>
      <td
        className={cx(
          'tnum px-4 py-2.5 text-right text-slate-900',
          strong && 'font-semibold',
          tone === 'up' && 'text-emerald-700',
          tone === 'down' && 'text-red-700',
        )}
      >
        {value}
      </td>
    </tr>
  );
}

function ConfirmModal({ report, moving, onClose, onDone, onError }) {
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await api.post('/ledger/revaluation');
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
      title="Restate at today’s rate"
      subtitle={`${report.rate.toLocaleString('en-US')} to the dollar`}
      footer={
        <ModalActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={saving}>Write the entry</Button>
        </ModalActions>
      }
    >
      <div className="space-y-4">
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-rule">
              {moving.map((a) => (
                <Row
                  key={a.id}
                  label={a.name}
                  value={money(a.difference)}
                  hint={
                    a.impliedRate
                      ? `${a.heldLbp.toLocaleString('en-US')} LL, on the books at ${a.impliedRate.toLocaleString('en-US')}`
                      : undefined
                  }
                />
              ))}
              <Row
                label="To Exchange differences"
                value={money(report.total)}
                strong
                tone={report.total > 0 ? 'up' : 'down'}
              />
            </tbody>
          </table>
        </Card>

        <p className="text-xs text-slate-500">
          {report.total > 0
            ? 'A gain: the pounds you are holding are worth more than the books say.'
            : 'A loss: the pounds you are holding are worth less than the books say.'}{' '}
          It is not money you earned by selling anything, which is why it goes to Exchange
          differences rather than to Sales.
        </p>
      </div>
    </Modal>
  );
}
