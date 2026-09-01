import { useState } from 'react';
import { Plus, TriangleAlert, X } from 'lucide-react';
import api from '../api';
import { Button, Input, Modal, ModalActions, Select, money, useToast } from './ui';

/**
 * What a validity card actually does when it sells.
 *
 * The customer pays for days. Behind the counter, whole recharge cards are
 * scratched to deliver them, and the credit those cards carry lands on the
 * shop's own line to be resold by the dollar. Both of those used to be typed in
 * afterwards, which is how a credit balance becomes a number nobody trusts.
 *
 * Linked by hand rather than guessed: only the shop knows which cards it really
 * uses for a 30-day top-up, and guessing would quietly spend the wrong stock.
 *
 * **Cards, plural.** This asked for exactly one, and that is not how the shop
 * works — a 180-day package is often delivered by scratching two, sometimes two
 * of the same denomination, because the carrier sells the denominations it
 * sells and the package is priced against a total. A shop with a two-card
 * package had to name one here and take the other off the books by hand on
 * every single sale, which is precisely the bookkeeping this dialog exists to
 * do away with. One card is now simply a list of one.
 */
export default function LinkValidity({ card, cards, carriers, onClose, onSaved }) {
  const toast = useToast();
  /*
   * A row per card scratched: `{ cardId, quantity }`, with the id as a string
   * because that is what a `<select>` hands back.
   *
   * Seeded from the saved list, falling back to the old single link so a shop
   * that has not been migrated yet — or a card list drawn before the server
   * started sending the new field — still opens showing what it had.
   */
  const [rows, setRows] = useState(() => {
    const saved = card.scratch_cards?.length
      ? card.scratch_cards
      : card.linked_card_id
        ? [{ cardId: card.linked_card_id, quantity: 1 }]
        : [];
    return saved.map((r) => ({ cardId: String(r.cardId), quantity: String(r.quantity ?? 1) }));
  });
  const [recovered, setRecovered] = useState(String(card.credit_recovered || ''));
  const [walletId, setWalletId] = useState(String(card.credit_wallet_id || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /*
   * Anything that is not itself a validity card. A validity card delivering
   * another validity card would recurse, and nothing about that is a sale
   * anybody meant to make.
   */
  const choices = cards.filter((c) => !c.validity_days && c.id !== card.id);
  const chosen = rows
    .map((r) => ({ ...r, card: choices.find((c) => String(c.id) === r.cardId) }))
    .filter((r) => r.card);

  /** What the shop spends to deliver one, across every card on the list. */
  const spent = chosen.reduce((sum, r) => sum + (Number(r.card.cost) || 0) * (Number(r.quantity) || 0), 0);
  /** And what those cards carry between them, which the credit sits under. */
  const carried = chosen.reduce(
    (sum, r) => sum + (Number(r.card.credits_included) || 0) * (Number(r.quantity) || 0),
    0,
  );

  const setRow = (index, patch) =>
    setRows((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  /**
   * Picking a card fills the credit in, the first time.
   *
   * The cards know what they carry and the shop takes back most of it, so their
   * own total is the right starting point and the shop trims it to what it
   * really keeps. Left to be typed from nothing it gets left at zero, and a
   * validity card with zero credit against it sells the days and moves no money
   * at all — which is the one thing this dialog exists to prevent.
   */
  function pick(index, id) {
    const next = rows.map((r, i) => (i === index ? { ...r, cardId: id } : r));
    setRows(next);

    const picked = choices.find((c) => String(c.id) === id);
    if (!picked) return;

    if (!Number(recovered)) {
      const total = next.reduce((sum, r) => {
        const c = choices.find((x) => String(x.id) === r.cardId);
        return sum + (Number(c?.credits_included) || 0) * (Number(r.quantity) || 0);
      }, 0);
      if (total > 0) setRecovered(String(round2(total)));
    }
    if (!walletId && carriers.length) {
      // The carrier whose name the card starts with, when there is one.
      const guess = carriers.find((w) => picked.name.toLowerCase().startsWith(w.name.toLowerCase()));
      if (guess) setWalletId(String(guess.id));
    }
  }

  /* The same card twice is a count, so a card already listed is not offered. */
  const available = (index) =>
    choices.filter((c) => !rows.some((r, i) => i !== index && r.cardId === String(c.id)));

  // Configured to do nothing: the days are sold and no credit moves.
  const movesNoCredit = !(Number(recovered) > 0 && walletId);
  const blank = rows.some((r) => !r.cardId);

  async function save() {
    setBusy(true);
    setError('');
    try {
      const { data } = await api.put(`/products/${card.id}`, {
        ...card,
        scratch_cards: rows
          .filter((r) => r.cardId)
          .map((r) => ({ cardId: Number(r.cardId), quantity: Number(r.quantity) || 1 })),
        /*
         * The old single column, kept in step for as long as it exists. Nothing
         * reads it any more — the list is the one answer — but leaving it
         * pointing at a card that is no longer on the list would be a second,
         * wrong answer sitting in the row waiting to be believed.
         */
        linked_card_id: null,
        credit_recovered: Number(recovered) || 0,
        credit_wallet_id: walletId ? Number(walletId) : null,
      });
      toast(`${data.product?.name || card.name} linked`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={card.name} subtitle="What selling one of these does">
      <div className="space-y-3">
        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">
            Cards scratched to deliver it
          </span>

          {rows.length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-500">
              Nothing — selling this sells the days and takes no card off the shelf.
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map((row, index) => (
                <li key={index} className="flex items-start gap-2">
                  {/*
                    * The width is on the wrapper, not on the field.
                    *
                    * Both `Input` and `Select` put their own `w-full` on the
                    * element a className lands on, so asking one of them for
                    * `w-20` puts two widths on one element and leaves which one
                    * wins to whatever order Tailwind happened to emit them in.
                    * That is not hypothetical — it is why this row first drew
                    * as a sliver of a dropdown beside a full-width number box.
                    */}
                  <div className="min-w-0 flex-1">
                    <Select
                      aria-label={`Card ${index + 1} scratched`}
                      name={`scratchedCard${index}`}
                      value={row.cardId}
                      onChange={(e) => pick(index, e.target.value)}
                    >
                      <option value="">Choose a card…</option>
                      {available(index).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · costs {money(c.cost)}
                          {c.credits_included > 0 ? ` · carries ${money(c.credits_included)}` : ''}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="w-20 shrink-0">
                    <Input
                      aria-label={`How many of card ${index + 1}`}
                      type="number"
                      min="1"
                      step="1"
                      value={row.quantity}
                      onChange={(e) => setRow(index, { quantity: e.target.value })}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setRows((list) => list.filter((_, i) => i !== index))}
                    aria-label={`Remove card ${index + 1}`}
                    className="shrink-0 rounded-lg p-2.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                  >
                    <X size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mt-2"
            disabled={blank || rows.length >= choices.length}
            onClick={() => setRows((list) => [...list, { cardId: '', quantity: '1' }])}
          >
            <Plus size={14} /> {rows.length ? 'Another card' : 'Add a card'}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Credit that comes back"
            name="creditRecovered"
            type="number"
            min="0"
            step="0.01"
            value={recovered}
            onChange={(e) => setRecovered(e.target.value)}
            placeholder="e.g. 6"
            /*
             * Said against what the cards actually hold between them, because
             * that is the number this one has to sit under — you cannot take
             * back more credit than the cards put on the customer's line.
             */
            hint={
              carried > 0
                ? `Out of the ${money(carried)} they carry`
                : 'What the customer sends to your line'
            }
          />
          <Select
            label="Onto which balance"
            name="creditWallet"
            value={walletId}
            onChange={(e) => setWalletId(e.target.value)}
          >
            <option value="">Nowhere</option>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>

        {/*
          * Said back in plain words, because the whole point is that three
          * things happen on one press and the shop should know which three.
          */}
        <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-600">
          Selling one takes <strong>{money(card.price)}</strong> from the customer
          {chosen.length > 0 && (
            <>
              , scratches{' '}
              <strong>
                {chosen
                  .map((r) => (Number(r.quantity) > 1 ? `${r.quantity} × ${r.card.name}` : r.card.name))
                  .join(' + ')}
              </strong>{' '}
              at {money(spent)}
            </>
          )}
          {Number(recovered) > 0 && walletId && (
            <>
              , and puts <strong>{money(Number(recovered))}</strong> of credit on{' '}
              {carriers.find((c) => String(c.id) === walletId)?.name}
            </>
          )}
          . Nothing to type in afterwards.
        </p>

        {/*
          * The credit cannot exceed what the cards put on the line.
          *
          * Not refused — a shop may know something this arithmetic does not —
          * but said, because the usual cause is a second card added to the list
          * without the credit being brought up to match it, and the symptom is
          * a carrier balance that drifts up by a few dollars a day.
          */}
        {carried > 0 && Number(recovered) > carried && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            <TriangleAlert size={13} className="mt-px shrink-0" />
            <span>
              That is more credit than these cards carry ({money(carried)}). Check the count on each
              card if it should be less.
            </span>
          </p>
        )}

        {/*
          * The failure this dialog is for.
          *
          * Picking the cards and leaving the credit at nothing looks finished —
          * the link is set, the row reads as configured — and then every sale
          * moves no credit at all and the carrier balance sits at zero while
          * the shop wonders what it did wrong. Said before it can happen.
          */}
        {movesNoCredit && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            <TriangleAlert size={13} className="mt-px shrink-0" />
            <span>
              No credit will reach a carrier balance. Selling this sells the days
              {chosen.length ? ' and scratches the cards' : ''} and nothing more — fill in how much
              comes back, and onto which balance, if that is not what you want.
            </span>
          </p>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <ModalActions>
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button className="flex-1" loading={busy} disabled={blank} onClick={save}>
          Save the link
        </Button>
      </ModalActions>
    </Modal>
  );
}

/** Money adds up in cents, not in floats. */
function round2(n) {
  return Math.round(n * 100) / 100;
}
