import { useCallback, useEffect, useState } from 'react';
import { Building2, Scale, Wallet } from 'lucide-react';
import api from '../api';
import { lbp, useSettings } from '../context/SettingsContext';
import { useAuth } from '../context/AuthContext';
import MoneyInput, { PoundsInput } from './MoneyInput';
import VoucherSlip from './VoucherSlip';
import { Badge, Button, Card, EmptyState, Input, Modal, ModalActions, Skeleton, cx, money, useToast } from './ui';
import { when } from '../lib/when';

/**
 * What the shop stands at with each agency it runs a counter for.
 *
 * The number an operator actually wants at the end of a day: the drawer says I
 * am holding four hundred dollars of OMT's money — does OMT agree? Until this
 * existed, the shop's half of that comparison was somebody's memory, and a
 * disagreement was settled by whoever sounded more certain.
 *
 * The sign is the ledger's throughout: positive means the shop owes the agency,
 * which is what a day of sends leaves behind. A day of payouts leaves the other
 * way round, and most days land somewhere in between.
 */
function Standing({ balance }) {
  if (Math.abs(balance) < 0.005) return <Badge tone="neutral">square</Badge>;
  return balance > 0 ? (
    <Badge tone="warning">you owe them</Badge>
  ) : (
    <Badge tone="good">they owe you</Badge>
  );
}

/**
 * What an agency stands at, in the money it is settled in.
 *
 * Dollars and pounds on separate lines, and the combined equivalent only where
 * both are in play — that one is for comparing against the agency's own app,
 * not for counting out.
 */
function StandingAmounts({ balanceUsd = 0, balanceLbp = 0, balance = 0, className }) {
  const usd = Math.abs(Number(balanceUsd) || 0);
  const lbp_ = Math.abs(Number(balanceLbp) || 0);
  const total = Math.abs(Number(balance) || 0);

  /*
   * No split to show, so show the total.
   *
   * Two different situations arrive here and both want the same answer. One is
   * a settled account, where the figure is $0.00. The other is a server that
   * has not been restarted since this was added and answers without the two
   * piles at all — and there the old combined figure is right, whereas the
   * blank cell this used to render told an operator their balance had
   * disappeared. A screen must never go quiet about money.
   */
  if (usd < 0.005 && lbp_ < 1) return <span className={className}>{money(total)}</span>;

  return (
    <span className={cx('block', className)}>
      {usd >= 0.005 && <span className="block">{money(usd)}</span>}
      {lbp_ >= 1 && <span className="block">{lbp(lbp_)}</span>}
      {usd >= 0.005 && lbp_ >= 1 && (
        <span className="block text-[11px] font-normal text-slate-400">{money(total)} in all</span>
      )}
    </span>
  );
}

/** Where a shop that was trading before this screen starts counting from. */
function OpeningDialog({ company, onClose, onSaved }) {
  const toast = useToast();
  const [usd, setUsd] = useState(String(company.opening_usd || ''));
  const [lbpAmount, setLbpAmount] = useState(String(company.opening_lbp || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.put(`/transfers/companies/${company.id}/opening`, {
        amountUsd: Number(usd) || 0,
        amountLbp: Number(lbpAmount) || 0,
      });
      toast(`${company.name}'s opening balance set`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not set that');
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="sm" title={`${company.name} — opening balance`}>
      <form onSubmit={submit}>
        <p className="text-sm text-slate-600">
          What you already owed {company.name} on the day you started keeping this — or a negative
          figure if they owed you. Nobody is going to key in years of past transfers, so this is where
          the running balance starts.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <MoneyInput label="In dollars" name="openingUsd" value={usd} onChange={setUsd} />
          <PoundsInput label="In pounds" name="openingLbp" value={lbpAmount} onChange={setLbpAmount} />
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Setting it again replaces the old figure rather than adding to it, so a correction moves the
          balance by the difference and every transfer since stays where it is.
        </p>
        {company.opening_set_at && (
          <p className="mt-1 text-xs text-slate-400">Last set {when(company.opening_set_at)}</p>
        )}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Set it
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/**
 * Squaring up at the end of the day.
 *
 * The rider comes round, and either the shop hands over the cash it has been
 * holding or the agency makes it good for what it paid out. Both currencies,
 * separately, because that is how it is counted out on the counter — a bundle
 * of dollars and a brick of pounds — and one figure converted at today's rate
 * would leave the drawer disagreeing with what is in it.
 *
 * Here rather than on the voucher screen. This used to send the operator off to
 * a general-purpose form with both ends prefilled in the address bar, which
 * worked and which nobody did: settling is the last thing before locking up,
 * and it belongs next to the balance that says it is due.
 */
function SettleDialog({ company, tillId, tillName, onClose, onSettled }) {
  const toast = useToast();
  const { rate } = useSettings();
  const owed = company.balance;
  /*
   * The two piles, which is what is actually owed.
   *
   * A day of sends leaves the shop holding dollars *and* pounds, and the rider
   * collects both. Filling the form from one converted total would have the
   * operator counting out dollars for money that came in as pounds, and the
   * agency's own app disagreeing about both halves by the end of the week.
   */
  const owedUsd = Number(company.balanceUsd ?? company.balance) || 0;
  const owedLbp = Number(company.balanceLbp) || 0;

  // Which way the money goes is already known — the balance says so. Still a
  // choice, because a float handed over in advance settles the other way.
  const [direction, setDirection] = useState(owed < 0 ? 'receive' : 'pay');
  // Each pile is only offered where it points the same way as the settlement:
  // the shop can owe dollars while the agency owes it pounds, and prefilling
  // both would settle one of them backwards.
  const [usd, setUsd] = useState(
    Math.sign(owedUsd) === Math.sign(owed) && Math.abs(owedUsd) > 0.005
      ? Math.abs(owedUsd).toFixed(2)
      : '',
  );
  const [lbpAmount, setLbpAmount] = useState(
    Math.sign(owedLbp) === Math.sign(owed) && Math.abs(owedLbp) >= 1
      ? String(Math.round(Math.abs(owedLbp)))
      : '',
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [slip, setSlip] = useState(null);

  const paying = direction === 'pay';
  const moving = (Number(usd) || 0) + (rate > 0 ? (Number(lbpAmount) || 0) / rate : 0);
  // Paying brings what the shop owes down; being paid brings what it is owed up.
  const sign = paying ? -1 : 1;
  const after = Math.round((owed + sign * moving) * 100) / 100;
  const afterUsd = Math.round((owedUsd + sign * (Number(usd) || 0)) * 100) / 100;
  const afterLbp = Math.round(owedLbp + sign * (Number(lbpAmount) || 0));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/transfers/companies/${company.id}/settle`, {
        accountId: tillId,
        direction,
        amountUsd: Number(usd) || 0,
        amountLbp: Number(lbpAmount) || 0,
        note,
      });
      toast(paying ? `Paid ${company.name}` : `${company.name} settled up`);
      // The slip stays open on top: it is the piece of paper somebody signs,
      // and closing the dialog before it is printed loses the moment.
      setSlip(res.data.voucher);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  if (slip) {
    return (
      <VoucherSlip
        voucher={slip}
        onClose={() => {
          setSlip(null);
          onSettled();
        }}
        onChanged={onSettled}
      />
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Settle with ${company.name}`}
      subtitle={`Out of ${tillName} — the money moves for real`}
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">Started at</p>
            <p className="tnum text-sm font-semibold text-slate-900">
              {company.opening_set_at ? money(company.opening_usd) : '—'}
            </p>
            {company.opening_lbp > 0 && (
              <p className="tnum text-[11px] text-slate-400">{lbp(company.opening_lbp)}</p>
            )}
          </div>
          <div className="rounded-xl bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">Standing now</p>
            <p
              className={cx(
                'tnum text-sm font-semibold',
                owed > 0 ? 'text-amber-700' : owed < 0 ? 'text-emerald-700' : 'text-slate-500',
              )}
            >
              <StandingAmounts balanceUsd={owedUsd} balanceLbp={owedLbp} balance={owed} />
            </p>
            <p className="text-[11px] text-slate-400">
              {Math.abs(owed) < 0.005 ? 'square' : owed > 0 ? 'they need it from us' : 'they owe us'}
            </p>
          </div>
          <div className="rounded-xl bg-slate-900 px-3 py-2 text-white">
            <p className="text-xs text-slate-300">After this</p>
            <p className="tnum text-sm font-semibold">
              <StandingAmounts balanceUsd={afterUsd} balanceLbp={afterLbp} balance={after} />
            </p>
            <p className="text-[11px] text-slate-400">
              {Math.abs(after) < 0.005 ? 'square' : after > 0 ? 'still to pay' : 'still to collect'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {[
            ['pay', 'We pay them', 'Cash out of the drawer'],
            ['receive', 'They pay us', 'Cash into the drawer'],
          ].map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              onClick={() => setDirection(value)}
              className={cx(
                'rounded-xl px-4 py-3 text-left ring-1 transition',
                direction === value
                  ? 'bg-brand-50 ring-2 ring-brand-600'
                  : 'bg-white ring-slate-200 hover:bg-slate-50',
              )}
            >
              <span className="block text-sm font-semibold text-slate-900">{label}</span>
              <span className="block text-xs text-slate-500">{hint}</span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Dollars"
            name="settleUsd"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={usd}
            onChange={(e) => setUsd(e.target.value)}
            autoFocus
          />
          <PoundsInput
            label="In pounds"
            name="settleLbp"
            value={lbpAmount}
            onChange={setLbpAmount}
            hint="If part of it is paid in pounds"
          />
        </div>

        <Input
          label="Note"
          name="settleNote"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Who collected it, which day it covers…"
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy} disabled={moving <= 0}>
            {paying ? 'Pay it over' : 'Take it in'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** The agency's own statement: every transfer and every settlement, in order. */
function StatementDialog({ company, onClose }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get(`/transfers/companies/${company.id}`).then((res) => setData(res.data));
  }, [company.id]);

  return (
    <Modal
      open
      onClose={onClose}
      title={company.name}
      subtitle="Everything that moved the balance, newest first"
    >
      {!data ? (
        <Skeleton className="h-40" />
      ) : data.entries.length === 0 ? (
        <EmptyState
          icon={Scale}
          title="Nothing on the account yet"
          description="Transfers put money on it; settling up takes it off."
        />
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {data.entries.map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="text-slate-700">{e.note || e.kind}</span>
                <span className="ml-2 text-xs text-slate-400">{String(e.created_at).slice(0, 16)}</span>
              </span>
              <span
                className={cx(
                  'tnum shrink-0 font-medium',
                  e.amount_usd > 0 ? 'text-amber-700' : 'text-emerald-700',
                )}
              >
                {e.amount_usd > 0 ? '+' : '−'}
                {money(Math.abs(e.amount_usd))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export default function TransferAgencies({ tillId = null, tillName = 'the drawer', refreshKey = 0, onSettled }) {
  const toast = useToast();
  /*
   * Where the count starts is the owner's to set.
   *
   * It is the figure every later balance is measured from, and moving it moves
   * what the shop appears to owe without anything having happened at the
   * counter — so an operator who is short has an obvious way to make that go
   * away. Recording transfers is still their job; saying where the count
   * begins is not. Hidden rather than shown and refused: a button that always
   * fails is worse than no button.
   */
  const { user } = useAuth();
  const owner = user?.role === 'admin';
  const [companies, setCompanies] = useState(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [opening, setOpening] = useState(null);
  const [settling, setSettling] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [failed, setFailed] = useState('');

  /*
   * A failure is said out loud rather than shown as an empty list.
   *
   * "No agencies yet" and "the server would not tell me" look identical on
   * screen and mean opposite things — one is a shop that has not started, the
   * other is a shop whose list is missing.
   */
  const load = useCallback(() => {
    api
      .get('/transfers/companies')
      .then((res) => {
        setCompanies(res.data.companies);
        setFailed('');
      })
      .catch((err) => {
        setCompanies([]);
        setFailed(err.response?.data?.error || 'Could not read the agencies');
      });
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function add(e) {
    e.preventDefault();
    try {
      await api.post('/transfers/companies', { name });
      toast(`${name} added`);
      setName('');
      setNaming(false);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not add that', 'error');
    }
  }

  if (!companies) return <Skeleton className="h-40" />;

  return (
    <Card className="mb-4">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <div className="flex items-center gap-2">
          <Building2 size={16} className="text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-800">Agencies</h3>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setNaming(true)}>
          Add an agency
        </Button>
      </div>

      {failed ? (
        <EmptyState icon={Building2} title="The agency list did not load" description={failed} />
      ) : companies.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No agencies yet"
          description="One is opened the first time you record a transfer with its name, or add it here."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
              <tr>
                <th className="px-5 py-2 font-medium">Agency</th>
                <th className="px-3 py-2 font-medium">Standing</th>
                <th className="px-3 py-2 text-right font-medium">Balance now</th>
                <th className="px-5 py-2 text-right font-medium">Opening balance</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {companies.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50/60">
                  <td className="px-5 py-2.5">
                    <button
                      type="button"
                      onClick={() => setViewing(c)}
                      className="font-medium text-slate-800 hover:text-brand-700"
                    >
                      {c.name}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <Standing balance={c.balance} />
                  </td>
                  <td
                    className={cx(
                      'tnum px-3 py-2.5 text-right font-semibold whitespace-nowrap',
                      c.balance > 0 ? 'text-amber-700' : c.balance < 0 ? 'text-emerald-700' : 'text-slate-500',
                    )}
                  >
                    {/*
                      * Both currencies, because both are owed.
                      *
                      * The rider does not collect $2,290.47 — he collects some
                      * dollars and some pounds, and converting the two into one
                      * figure at today's rate answers a question nobody at the
                      * counter is asking. The combined total stays underneath
                      * as what the account is worth.
                      */}
                    <StandingAmounts balanceUsd={c.balanceUsd} balanceLbp={c.balanceLbp} balance={c.balance} />
                    <span className="block text-[11px] font-normal text-slate-400">
                      {Math.abs(c.balance) < 0.005
                        ? 'nothing to settle'
                        : c.balance > 0
                          ? 'they need this from us'
                          : 'we collect this from them'}
                    </span>
                  </td>
                  <td className="tnum px-5 py-2.5 text-right text-xs text-slate-400">
                    {c.opening_set_at ? (
                      <>
                        {money(c.opening_usd)}
                        {c.opening_lbp > 0 && <span className="block">{lbp(c.opening_lbp)}</span>}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-right whitespace-nowrap">
                    {owner && (
                      <button
                        type="button"
                        onClick={() => setOpening(c)}
                        className="rounded px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
                      >
                        Opening
                      </button>
                    )}
                    {/*
                      * Settling is a voucher like any other — the shop paying
                      * an agency what it is holding for them, or being made
                      * good for what it laid out. It is written from here,
                      * where the balance that says it is due is on screen.
                      */}
                    {tillId && Math.abs(c.balance) >= 0.005 && (
                      <button
                        type="button"
                        onClick={() => setSettling(c)}
                        className="ml-1 rounded px-2 py-1 text-xs font-medium text-brand-700 transition hover:bg-brand-50"
                      >
                        <Wallet size={12} className="inline" /> Settle up
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {naming && (
        <Modal open onClose={() => setNaming(false)} size="sm" title="Add an agency">
          <form onSubmit={add}>
            <Input
              label="Name"
              name="agency"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="OMT, Whish, Western Union…"
              autoFocus
            />
            <ModalActions>
              <Button type="button" variant="secondary" onClick={() => setNaming(false)}>
                Cancel
              </Button>
              <Button type="submit">Add it</Button>
            </ModalActions>
          </form>
        </Modal>
      )}

      {opening && (
        <OpeningDialog
          company={opening}
          onClose={() => setOpening(null)}
          onSaved={() => {
            setOpening(null);
            load();
          }}
        />
      )}

      {settling && (
        <SettleDialog
          company={settling}
          tillId={tillId}
          tillName={tillName}
          onClose={() => setSettling(null)}
          onSettled={() => {
            setSettling(null);
            load();
            onSettled?.();
          }}
        />
      )}

      {viewing && <StatementDialog company={viewing} onClose={() => setViewing(null)} />}
    </Card>
  );
}
