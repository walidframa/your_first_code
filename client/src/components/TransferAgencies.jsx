import { useCallback, useEffect, useState } from 'react';
import { Building2, Scale, Wallet } from 'lucide-react';
import api from '../api';
import { lbp } from '../context/SettingsContext';
import MoneyInput from './MoneyInput';
import { Badge, Button, Card, EmptyState, Input, Modal, ModalActions, Skeleton, cx, money, useToast } from './ui';

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
          <MoneyInput label="In pounds" name="openingLbp" value={lbpAmount} onChange={setLbpAmount} currency="LBP" />
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Setting it again replaces the old figure rather than adding to it, so a correction moves the
          balance by the difference and every transfer since stays where it is.
        </p>
        {company.opening_set_at && (
          <p className="mt-1 text-xs text-slate-400">Last set {company.opening_set_at}</p>
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

export default function TransferAgencies({ onSettle, refreshKey = 0 }) {
  const toast = useToast();
  const [companies, setCompanies] = useState(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [opening, setOpening] = useState(null);
  const [viewing, setViewing] = useState(null);

  const load = useCallback(() => {
    api
      .get('/transfers/companies')
      .then((res) => setCompanies(res.data.companies))
      .catch(() => setCompanies([]));
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

      {companies.length === 0 ? (
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
                <th className="px-3 py-2 text-right font-medium">Balance</th>
                <th className="px-5 py-2 text-right font-medium">Opening</th>
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
                      'tnum px-3 py-2.5 text-right font-semibold',
                      c.balance > 0 ? 'text-amber-700' : c.balance < 0 ? 'text-emerald-700' : 'text-slate-500',
                    )}
                  >
                    {money(Math.abs(c.balance))}
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
                    <button
                      type="button"
                      onClick={() => setOpening(c)}
                      className="rounded px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
                    >
                      Opening
                    </button>
                    {/*
                      * Settling is a voucher like any other — the shop paying
                      * an agency what it is holding for them, or being made
                      * good for what it laid out. It opens the voucher desk
                      * with both ends already filled in.
                      */}
                    {onSettle && Math.abs(c.balance) >= 0.005 && (
                      <button
                        type="button"
                        onClick={() => onSettle(c)}
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

      {viewing && <StatementDialog company={viewing} onClose={() => setViewing(null)} />}
    </Card>
  );
}
