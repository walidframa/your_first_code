import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import api from '../api';
import { Button, Input, Modal, ModalActions, Select, money, useToast } from './ui';

/**
 * What a validity card actually does when it sells.
 *
 * The customer pays for days. Behind the counter, a whole recharge card is
 * scratched to deliver them, and the credit that card carries lands on the
 * shop's own line to be resold by the dollar. Both of those used to be typed in
 * afterwards, which is how a credit balance becomes a number nobody trusts.
 *
 * Linked by hand rather than guessed: only the shop knows which card it really
 * uses for a 30-day top-up, and guessing would quietly spend the wrong stock.
 */
export default function LinkValidity({ card, cards, carriers, onClose, onSaved }) {
  const toast = useToast();
  const [linkedId, setLinkedId] = useState(String(card.linked_card_id || ''));
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
  const linked = choices.find((c) => String(c.id) === linkedId);

  /*
   * Picking the card fills the credit in.
   *
   * The card knows what it carries, and the shop takes back most of it — so the
   * card's own figure is the right starting point and the shop trims it to what
   * it really keeps. Left to be typed from nothing it gets left at zero, and a
   * validity card with zero credit against it sells the days and moves no
   * money at all, which is the one thing this dialog exists to prevent.
   */
  function pickCard(id) {
    setLinkedId(id);
    const chosen = choices.find((c) => String(c.id) === id);
    if (chosen?.credits_included > 0 && !Number(recovered)) {
      setRecovered(String(chosen.credits_included));
    }
    if (chosen && !walletId && carriers.length) {
      // The carrier whose name the card starts with, when there is one.
      const guess = carriers.find((w) => chosen.name.toLowerCase().startsWith(w.name.toLowerCase()));
      if (guess) setWalletId(String(guess.id));
    }
  }

  // Configured to do nothing: the days are sold and no credit moves.
  const movesNoCredit = !(Number(recovered) > 0 && walletId);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.put(`/products/${card.id}`, {
        ...card,
        linked_card_id: linkedId ? Number(linkedId) : null,
        credit_recovered: Number(recovered) || 0,
        credit_wallet_id: walletId ? Number(walletId) : null,
      });
      toast(`${card.name} linked`);
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
        <Select
          label="Card scratched to deliver it"
          name="linkedCard"
          value={linkedId}
          onChange={(e) => pickCard(e.target.value)}
        >
          <option value="">Nothing — just the days</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · costs {money(c.cost)}
              {c.credits_included > 0 ? ` · carries ${money(c.credits_included)}` : ''}
            </option>
          ))}
        </Select>

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
             * Said against what the card actually holds, because that is the
             * number this one has to sit under — you cannot take back more
             * credit than the card put on the customer's line.
             */
            hint={
              linked?.credits_included > 0
                ? `Out of the ${money(linked.credits_included)} it carries`
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
          {linked && (
            <>
              , spends <strong>{money(linked.cost)}</strong> of {linked.name}
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
          * The failure this dialog is for.
          *
          * Picking the card and leaving the credit at nothing looks finished —
          * the link is set, the row reads as configured — and then every sale
          * moves no credit at all and the carrier balance sits at zero while
          * the shop wonders what it did wrong. Said before it can happen.
          */}
        {movesNoCredit && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            <TriangleAlert size={13} className="mt-px shrink-0" />
            <span>
              No credit will reach a carrier balance. Selling this sells the days
              {linked ? ' and scratches the card' : ''} and nothing more — fill in how much comes
              back, and onto which balance, if that is not what you want.
            </span>
          </p>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <ModalActions>
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button className="flex-1" loading={busy} onClick={save}>
          Save the link
        </Button>
      </ModalActions>
    </Modal>
  );
}
