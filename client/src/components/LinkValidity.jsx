import { useState } from 'react';
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
          onChange={(e) => setLinkedId(e.target.value)}
        >
          <option value="">Nothing — just the days</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · costs {money(c.cost)}
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
            hint="What the customer sends to your line"
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
