import { useEffect, useState } from 'react';
import { Check, Pencil, Plus, Tags, Trash2, X } from 'lucide-react';
import api from '../api';
import { Button, EmptyState, Input, Modal, ModalActions, Skeleton, useToast } from './ui';
import { useConfirm } from './ConfirmProvider';

/**
 * The shelves the catalogue is sorted onto.
 *
 * Categories used to appear only as a dropdown on the product form and could be
 * made but never unmade, so a shop a year in has "Accessories", "accessories"
 * and "Acessories" and no way to tidy them. Renaming is the fix for most of
 * that, and it is safe: a product points at the row, not at the word.
 *
 * Each row carries how many products are on it, because that is the number that
 * decides whether it can go — and it is the number nobody has when they are
 * looking at a bare list of names.
 */
export default function CategoryManager({ onClose, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  // The one being deleted while it still holds products, awaiting a yes.
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const res = await api.get('/products/categories');
    setRows(res.data.categories);
  }

  useEffect(() => {
    load();
  }, []);

  /** Every change reloads the list and tells the page behind, which shows counts. */
  async function run(work) {
    setBusy(true);
    setError('');
    try {
      /* The response, not just "it worked" — switching a shelf to IMEI answers
         with what it changed, and the toast is worth nothing without it. */
      const res = await work();
      await load();
      onChanged?.();
      return res ?? true;
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e) {
    e.preventDefault();
    if (!adding.trim()) return;
    const name = adding.trim();
    if (await run(() => api.post('/products/categories', { name }))) {
      setAdding('');
      toast(`Added ${name}`);
    }
  }

  /*
   * Whether this shelf gets a chip on the register.
   *
   * A tick rather than a screen of its own: it is one fact about a category and
   * this is the list of categories. Sent on its own so it does not wait on the
   * name being edited — the common use is going down the list ticking three of
   * forty, and having to open each one to rename it first would be the same
   * chore this exists to end.
   */
  async function setOnRegister(c, on) {
    const saved = await run(() =>
      api.patch(`/products/categories/${c.id}`, { name: c.name, onRegister: on }),
    );
    /* `run` reloads the list on success, so the only thing left to undo is a
       tick the server did not accept. */
    if (!saved) {
      setRows((prev) => prev.map((r) => (r.id === c.id ? { ...r, on_register: on ? 0 : 1 } : r)));
    }
  }

  /*
   * Whether this shelf holds handsets.
   *
   * Said once about the shelf, not two hundred times about the products on it.
   * Ticking it switches everything already there to IMEI tracking and makes it
   * the starting position for anything filed there afterwards.
   *
   * Unlike the tick beside it, this one asks first — and does not move until
   * the server has answered. It clears the stock count on every product it
   * touches, because a handset with no number on record is not tracked, and a
   * box that goes green before that has happened is a box that has understated
   * what it just did.
   */
  async function setTracksUnits(c, on) {
    if (on) {
      const agreed = await confirm({
        title: `Is ${c.name} a shelf of handsets?`,
        body:
          `Everything on it will be tracked by IMEI, and anything filed there later starts that ` +
          `way too. The stock counts on those ${c.product_count} product` +
          `${c.product_count === 1 ? '' : 's'} are cleared — a handset with no number on record is ` +
          'not tracked, so you book them in by their numbers instead.',
        confirmLabel: 'Track this shelf by IMEI',
        cancelLabel: 'Leave it counted',
      });
      if (!agreed) return;
    }

    const saved = await run(() =>
      api.patch(`/products/categories/${c.id}`, { name: c.name, tracksUnits: on }),
    );
    if (!saved) return;

    const switched = saved.data?.switched || [];
    if (on) {
      const cleared = switched.reduce((sum, p) => sum + (p.cleared || 0), 0);
      toast(
        switched.length === 0
          ? `${c.name} is a handset shelf — nothing on it needed switching`
          : `${switched.length} switched to IMEI${cleared ? `, ${cleared} counted units cleared` : ''}`,
      );
    } else {
      // Nothing is untracked on the way back off, so say so rather than let a
      // shop assume its handsets went back to being counted.
      toast(`New products on ${c.name} will be counted — what is there stays tracked`);
    }
    onChanged?.();
  }

  async function rename(id) {
    if (!draft.trim()) return setEditingId(null);
    if (await run(() => api.patch(`/products/categories/${id}`, { name: draft.trim() }))) {
      setEditingId(null);
      toast('Renamed');
    }
  }

  /*
   * Deleting one that is empty is unremarkable and happens on the spot. One
   * that still holds products asks first — the server refuses it either way,
   * and the refusal comes back with the count so the question can be a real
   * question rather than "are you sure".
   */
  async function remove(category, force = false) {
    const done = await run(() =>
      api.delete(`/products/categories/${category.id}${force ? '?force=true' : ''}`),
    );
    if (done) {
      setConfirming(null);
      toast(force && category.product_count > 0 ? 'Deleted — those products have no category now' : 'Deleted');
    } else if (category.product_count > 0) {
      setConfirming(category);
      setError('');
    }
  }

  if (confirming) {
    return (
      <Modal open onClose={() => setConfirming(null)} title={`Delete “${confirming.name}”?`}>
        <p className="text-sm text-slate-600">
          {confirming.product_count} product{confirming.product_count === 1 ? '' : 's'}{' '}
          {confirming.product_count === 1 ? 'is' : 'are'} in it. They stay in the catalogue and keep
          selling — they simply end up with no category, which you can set again later.
        </p>
        <ModalActions>
          <Button variant="secondary" className="flex-1" onClick={() => setConfirming(null)}>
            Keep it
          </Button>
          <Button variant="danger" className="flex-1" loading={busy} onClick={() => remove(confirming, true)}>
            <Trash2 size={15} /> Delete anyway
          </Button>
        </ModalActions>
      </Modal>
    );
  }

  /**
   * Add whatever of the standard list is missing.
   *
   * The server decides what "missing" means, matching without regard to case —
   * a shop that already has "chargers" must not end up with a second shelf
   * called "Chargers" and its stock split across the two.
   */
  async function addStarter() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/products/categories/starter');
      const { added } = res.data;
      toast(
        added.length
          ? `Added ${added.length} categor${added.length === 1 ? 'y' : 'ies'}`
          : 'You already have all of them',
      );
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add those');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Categories" subtitle="How the catalogue is sorted">
      <form onSubmit={add} className="flex items-end gap-2">
        <Input
          label="Add a category"
          name="newCategory"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="e.g. Chargers"
          className="flex-1"
        />
        <Button type="submit" loading={busy} disabled={!adding.trim()}>
          <Plus size={16} /> Add
        </Button>
      </form>

      {/*
       * The list most phone shops end up typing by hand, offered rather than
       * imposed. A brand-new shop gets these already; this is for the one that
       * has been running six months on an empty category list because filling
       * one in is sixteen trips through the box above.
       */}
      <button
        type="button"
        onClick={addStarter}
        disabled={busy}
        className="mt-2 text-sm font-medium text-brand-700 underline-offset-2 transition hover:underline disabled:opacity-50"
      >
        Add the usual ones for a phone shop
      </button>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 max-h-80 overflow-y-auto">
        {!rows ? (
          <Skeleton className="h-40" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Tags}
            title="No categories yet"
            description="Add one above, or let an import create them from a supplier's file."
          />
        ) : (
          <ul className="divide-y divide-rule">
            {rows.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-2">
                {editingId === c.id ? (
                  <>
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') rename(c.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      // The name is already there and about to be replaced, so
                      // the cursor arrives with it selected.
                      autoFocus
                      onFocus={(e) => e.target.select()}
                      className="h-9 flex-1 rounded-lg bg-white px-3 text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
                    />
                    <Button size="sm" loading={busy} onClick={() => rename(c.id)} aria-label="Save the name">
                      <Check size={15} />
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditingId(null)}
                      aria-label="Cancel"
                    >
                      <X size={15} />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 truncate text-sm text-slate-800">{c.name}</span>
                    <span className="shrink-0 text-xs text-slate-400">
                      {c.product_count} product{c.product_count === 1 ? '' : 's'}
                    </span>
                    <label
                      className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-slate-500"
                      title="Show this category as a filter on the register"
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(c.on_register)}
                        /*
                         * Ticked here and now, then saved.
                         *
                         * It used to wait for the round trip, and it was
                         * `disabled` while it waited — so the box a shop had
                         * just clicked went dead and stayed unticked, which
                         * reads exactly like a button that does nothing. It is
                         * one bit against a local server; showing it and then
                         * putting it back if the save fails is honest and
                         * instant, and going down a list of forty ticking four
                         * should not have four pauses in it.
                         */
                        onChange={(e) => {
                          const on = e.target.checked;
                          setRows((prev) =>
                            prev.map((r) => (r.id === c.id ? { ...r, on_register: on ? 1 : 0 } : r)),
                          );
                          setOnRegister(c, on);
                        }}
                        className="size-4 accent-brand-600"
                      />
                      On register
                    </label>
                    {/*
                      * A phone shop's phone shelf, said once.
                      *
                      * Every handset wants tracking by IMEI, every one added
                      * next month wants it too, and a shop ticking a box per
                      * product will miss the one that later goes missing.
                      */}
                    <label
                      className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-slate-500"
                      title="Everything on this shelf is tracked by IMEI"
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(c.tracks_units)}
                        aria-label={`Track ${c.name} by IMEI`}
                        onChange={(e) => setTracksUnits(c, e.target.checked)}
                        className="size-4 accent-brand-600"
                      />
                      Handsets (IMEI)
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingId(c.id);
                        setDraft(c.name);
                        setError('');
                      }}
                      aria-label={`Rename ${c.name}`}
                    >
                      <Pencil size={15} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy}
                      onClick={() => remove(c)}
                      aria-label={`Delete ${c.name}`}
                      className="text-slate-400 hover:text-red-600"
                    >
                      <Trash2 size={15} />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ModalActions>
        <Button className="flex-1" onClick={onClose}>
          Done
        </Button>
      </ModalActions>
    </Modal>
  );
}
