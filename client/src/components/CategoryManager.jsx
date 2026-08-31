import { useEffect, useState } from 'react';
import { Check, Pencil, Plus, Tags, Trash2, X } from 'lucide-react';
import api from '../api';
import { Button, EmptyState, Input, Modal, ModalActions, Skeleton, useToast } from './ui';

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
      await work();
      await load();
      onChanged?.();
      return true;
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
