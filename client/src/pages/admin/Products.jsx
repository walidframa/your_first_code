import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  Archive,
  ArchiveRestore,
  History,
  Package,
  Pencil,
  Plus,
  Search,
  Smartphone,
  Tag,
  Tags,
  Upload,
} from 'lucide-react';
import api from '../../api';
import BarcodeField from '../../components/BarcodeField';
import MoneyInput from '../../components/MoneyInput';
import PageHeader from '../../components/PageHeader';
import ItemActivity from '../../components/ItemActivity';
import CategoryManager from '../../components/CategoryManager';
import ProductImageField from '../../components/ProductImageField';
import BundleEditor from '../../components/BundleEditor';
import ColumnPicker from '../../components/ColumnPicker';
import { useColumns } from '../../lib/tableColumns';
import { useWindowedRows } from '../../lib/windowedRows';
import UnitsPanel from '../../components/UnitsPanel';
import { useSettings, lbp } from '../../context/SettingsContext';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  ModalActions,
  ProductThumb,
  Select,
  Skeleton,
  StockBadge,
  cx,
  money,
  useToast,
} from '../../components/ui';
import { useNavigate } from 'react-router';
import BarcodeScanner, { ScanButton, canScan } from '../../components/BarcodeScanner';

/* The last option in the category list, which opens a box rather than picking. */
const NEW_CATEGORY = '__new__';

const emptyForm = {
  name: '',
  sku: '',
  barcodes: [],
  price: '',
  cost: '',
  wholesale_price: '',
  stock: '',
  reorder_point: '5',
  category_id: '',
  supplier: '',
  image_url: '',
  tracks_units: false,
  is_sim: false,
};

function ProductModal({ product, categories, allProducts, onClose, onSaved, onCategories }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState(
    product
      ? {
          name: product.name,
          sku: product.sku,
          barcodes: product.barcodes || (product.barcode ? [product.barcode] : []),
          price: product.price,
          cost: product.cost,
          // Null is "no trade price", and the box for it is empty rather than
          // showing a zero the shop never typed.
          wholesale_price: product.wholesale_price ?? '',
          stock: product.stock,
          reorder_point: product.reorder_point ?? 5,
          category_id: product.category_id || '',
          supplier: product.supplier || '',
          image_url: product.image_url || '',
          tracks_units: Boolean(product.tracks_units),
          is_sim: Boolean(product.is_sim),
        }
      : emptyForm,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmConvert, setConfirmConvert] = useState(null);

  /*
   * Naming a new shelf, from inside the product going onto it.
   *
   * `null` is "not asking"; a string is the name being typed, empty included —
   * which is why it is not simply falsy-checked.
   */
  const [namingCategory, setNamingCategory] = useState(null);
  const [addingCategory, setAddingCategory] = useState(false);

  async function addCategory() {
    const name = namingCategory.trim();
    if (!name) return;
    setAddingCategory(true);
    try {
      const { data } = await api.post('/products/categories', { name });
      // Straight onto the product, because that is what it was made for.
      setForm((f) => ({ ...f, category_id: String(data.category.id) }));
      setNamingCategory(null);
      onCategories?.();
      toast(`${data.category.name} added`);
    } catch (err) {
      /*
       * The commonest answer by far is that it already exists — said here
       * rather than as a red banner over the whole form, because it is about
       * this one box and the fix is to pick the existing one.
       */
      toast(err.response?.data?.error || 'Could not add that category', 'error');
    } finally {
      setAddingCategory(false);
    }
  }

  async function convertAndSave() {
    setConfirmConvert(null);
    setSaving(true);
    try {
      await api.put(`/products/${product.id}`, {
        ...form,
        price: Number(form.price),
        cost: Number(form.cost) || 0,
        reorder_point: Number(form.reorder_point) || 0,
        category_id: form.category_id || null,
        tracks_units: true,
        convertStock: true,
      });
      toast('Now tracked by IMEI — book the handsets in next');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  /*
   * What this product is made of, if anything. Held beside the form rather
   * than inside it because it is saved through its own endpoint — the recipe
   * is a relationship between products, not a column on one.
   */
  const [bundle, setBundle] = useState([]);

  /**
   * Saving, and what happens next.
   *
   * `andLabel` is the reason a product is usually being created at all: a box
   * arrived, it is going on the shelf, and the things in it need labels before
   * they get there. The count carries over — what was typed into the stock box
   * is how many are on the bench — and is editable on the label screen, because
   * what came in and what goes on the shelf are not always the same number.
   */
  async function submit(e, andLabel = false) {
    e.preventDefault();
    setError('');
    setSaving(true);
    const payload = {
      ...form,
      price: Number(form.price),
      cost: Number(form.cost) || 0,
      wholesale_price: form.wholesale_price === '' ? null : Number(form.wholesale_price),
      stock: Number(form.stock) || 0,
      reorder_point: Number(form.reorder_point) || 0,
      category_id: form.category_id || null,
      tracks_units: form.tracks_units,
      // A product that is not serialised cannot be a SIM.
      is_sim: form.tracks_units && form.is_sim,
    };
    try {
      const saved = product
        ? (await api.put(`/products/${product.id}`, payload)).data.product
        : (await api.post('/products', payload)).data.product;

      /*
       * The recipe goes second, and only when there is one or there was one —
       * a brand-new ordinary product has no need of an empty PUT, and an
       * existing bundle emptied on screen has to be told it is empty now.
       */
      const id = saved?.id ?? product?.id;
      if (id && (bundle.length > 0 || product)) {
        await api.put(`/products/${id}/bundle`, {
          components: bundle.map((c) => ({
            productId: c.productId,
            quantity: Number(c.quantity) || 0,
          })),
        });
      }
      toast(product ? 'Product updated' : 'Product created');
      onSaved();
      if (andLabel && id) navigate(`/admin/labels?product=${id}&qty=${Number(form.stock) || 1}`);
    } catch (err) {
      /*
       * Switching an existing product to IMEI tracking clears its stock count,
       * because a quantity has no handsets behind it. The server refuses until
       * that is confirmed rather than destroying a count on a click.
       */
      if (err.response?.data?.needsConvert) {
        setConfirmConvert(err.response.data);
      } else {
        setError(err.response?.data?.error || 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={product ? 'Edit product' : 'New product'} size="lg">
      {confirmConvert && (
        <div className="mb-3 rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
          <p className="text-sm font-medium text-amber-900">
            {confirmConvert.stock} in stock — that count will be cleared
          </p>
          <p className="mt-1 text-sm text-amber-800">
            A quantity has no handsets behind it. Clear it, then book the phones in by their IMEIs so
            the stock is the actual devices on the shelf.
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirmConvert(null)}>
              Keep it as a quantity
            </Button>
            <Button size="sm" onClick={convertAndSave} loading={saving}>
              Clear it and track by IMEI
            </Button>
          </div>
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Name" value={form.name} onChange={set('name')} required autoFocus className="col-span-2" />
          <Input label="SKU" value={form.sku} onChange={set('sku')} required />
          <div className="col-span-2">
            <BarcodeField
              value={form.barcodes}
              onChange={(barcodes) => setForm((f) => ({ ...f, barcodes }))}
            />
          </div>
          {/* Either currency: a supplier quotes in pounds as often as in
              dollars, and the division belongs here rather than in somebody's
              head at the counter. Dollars are still what gets stored. */}
          <MoneyInput
            label="Price"
            name="price"
            value={form.price}
            onChange={(v) => setForm((f) => ({ ...f, price: v }))}
          />
          <MoneyInput
            label="Cost"
            name="cost"
            value={form.cost}
            onChange={(v) => setForm((f) => ({ ...f, cost: v }))}
          />
          {/*
            * What the trade pays, for the shops that buy from this one.
            *
            * Left blank for most of a catalogue, which is what "there isn't a
            * trade price" looks like. Not a percentage off the shelf price: a
            * fixed markup is exactly what it is not — some lines carry the shop
            * and some go out at barely over cost to keep a customer.
            */}
          <MoneyInput
            label="Wholesale price"
            name="wholesale_price"
            value={form.wholesale_price}
            onChange={(v) => setForm((f) => ({ ...f, wholesale_price: v }))}
            hint="What another shop pays. Leave empty if there is no wholesale price."
          />
          <Input
            label="Stock on hand"
            type="number"
            step="1"
            value={form.tracks_units ? '' : form.stock}
            onChange={set('stock')}
            disabled={form.tracks_units}
            hint={form.tracks_units ? 'Counted from the handsets booked in' : undefined}
          />
          <Input
            label="Reorder point"
            type="number"
            step="1"
            min="0"
            value={form.reorder_point}
            onChange={set('reorder_point')}
            hint="Flag as low at or below this"
          />
          {/*
            * The shelf this goes on, and a way to name a new one without
            * leaving the product.
            *
            * A shop typing in its first delivery of a thing it has never
            * stocked meets both at once — the product and the shelf it belongs
            * on — and sending them to another screen to make the shelf means
            * abandoning the half-typed product and starting again. The last
            * option in the list opens a box instead.
            */}
          <div>
            <Select
              id="category_id"
              label="Category"
              value={form.category_id}
              onChange={(e) => {
                if (e.target.value === NEW_CATEGORY) {
                  setNamingCategory('');
                  return;
                }
                setForm((f) => ({ ...f, category_id: e.target.value }));
              }}
            >
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value={NEW_CATEGORY}>+ New category…</option>
            </Select>

            {namingCategory !== null && (
              <div className="mt-2 flex items-end gap-2">
                <Input
                  label="New category"
                  value={namingCategory}
                  onChange={(e) => setNamingCategory(e.target.value)}
                  autoFocus
                  placeholder="Chargers"
                  /* Enter makes the category, and must never submit the
                     half-filled product behind it. */
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCategory();
                    }
                    if (e.key === 'Escape') setNamingCategory(null);
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  className="mb-0.5"
                  loading={addingCategory}
                  disabled={!namingCategory.trim()}
                  onClick={addCategory}
                >
                  Add
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mb-0.5"
                  onClick={() => setNamingCategory(null)}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
          {/*
            * Phones are sold one identified handset at a time; screen
            * protectors are not. The choice is per product so both live in one
            * catalogue.
            */}
          <label className="col-span-2 flex items-start gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
            <input
              type="checkbox"
              checked={form.tracks_units}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  tracks_units: e.target.checked,
                  // A SIM that is not counted one at a time is not a SIM.
                  is_sim: e.target.checked ? f.is_sim : false,
                }))
              }
              className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600"
            />
            <span>
              <span className="block text-sm font-medium text-slate-800">Track each one by IMEI</span>
              <span className="block text-xs text-slate-500">
                For phones and anything with a serial. Stock is then the handsets booked in, and each
                carries its own cost.
              </span>
            </span>
          </label>

          {/*
            * Always offered, and it turns IMEI tracking on by itself.
            *
            * A SIM is a serialised thing by definition — there is no such thing
            * as "four SIMs" without saying which four numbers — so this used to
            * appear only once the box above was ticked. That made it invisible
            * to anybody who did not already know that a SIM is a kind of
            * serialised product, which is everybody: the SIM screen says "tick
            * Sold as a SIM" and there was no such tick to be found.
            */}
          <label className="col-span-2 flex items-start gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
            <input
              type="checkbox"
              checked={form.is_sim}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  is_sim: e.target.checked,
                  // Ticking this makes it serialised, because it is.
                  tracks_units: e.target.checked ? true : f.tracks_units,
                }))
              }
              className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600"
            />
            <span>
              <span className="block text-sm font-medium text-slate-800">Sold as a SIM</span>
              <span className="block text-xs text-slate-500">
                Booked in and sold by the phone number on the card, from the SIM cards screen and the
                register. Ticking this counts them one by one, the same as IMEI.
              </span>
            </span>
          </label>

          <Input label="Supplier" value={form.supplier} onChange={set('supplier')} />
          <ProductImageField
            value={form.image_url}
            onChange={(v) => setForm((f) => ({ ...f, image_url: v }))}
            className="col-span-2"
          />

          {/* Serialised products are one identified handset each — a recipe
              made of them would have to say which IMEI, which it cannot. */}
          {!form.tracks_units && (
            <BundleEditor
              productId={product?.id}
              value={bundle}
              onChange={setBundle}
              products={allProducts}
            />
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions className="flex-wrap">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          {/* Straight from here to the labels, with the count already on it. */}
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            loading={saving}
            onClick={(e) => submit(e, true)}
            title="Save, then print labels for the quantity in stock"
          >
            <Tag size={15} /> Save &amp; label
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            {product ? 'Save changes' : 'Create product'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

export default function Products() {
  const toast = useToast();
  const { rate, toLbp } = useSettings();
  const [products, setProducts] = useState(null);
  const [categories, setCategories] = useState([]);
  const [managingCategories, setManagingCategories] = useState(false);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(undefined);
  const [activityFor, setActivityFor] = useState(null);
  const [scanning, setScanning] = useState(false);
  const navigate = useNavigate();
  const [unitsFor, setUnitsFor] = useState(null);

  const loadCategories = useCallback(async () => {
    const { data } = await api.get('/products/categories');
    setCategories(data.categories);
  }, []);

  const load = useCallback(async () => {
    const [productsRes, categoriesRes] = await Promise.all([
      api.get('/products'),
      api.get('/products/categories'),
    ]);
    setProducts(productsRes.data.products);
    setCategories(categoriesRes.data.categories);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleArchive(product) {
    if (product.active) await api.delete(`/products/${product.id}`);
    else await api.put(`/products/${product.id}`, { active: true });
    toast(product.active ? `${product.name} archived` : `${product.name} restored`);
    load();
  }

  /*
   * The columns, and what each one puts in a cell.
   *
   * Declared in one list rather than as matching rows of <th> and <td>, because
   * the two drifting apart is how a table ends up with the margin under the
   * heading for stock. The reader picks which of them to show — see
   * lib/tableColumns for why that is kept on the device.
   *
   * `fixed` is for the two nobody may hide: the product itself, and the buttons
   * that act on it. A table of prices with no names against them is not a table
   * of anything.
   */
  const COLUMNS = [
    {
      key: 'product',
      band: 'Item',
      label: 'Product',
      fixed: true,
      pad: true,
      /*
       * Capped, because a table lays itself out by giving the slack to whatever
       * can use it and a product name can always use more. Left to itself the
       * name took a third of the window and pushed stock and margin off the
       * right-hand edge — the two figures somebody opens this screen to read.
       * The name truncates; the numbers cannot.
       */
      width: 'w-[17rem] max-w-[17rem]',
      cell: (p) => (
        <div className="flex items-center gap-2 sm:gap-3">
          <ProductThumb product={p} size="sm" />
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate font-medium text-slate-800">
              {p.name}
              {!p.active && <Badge tone="neutral">Archived</Badge>}
            </p>
            <p className="text-xs text-slate-400">
              {p.sku}
              {p.supplier ? ` · ${p.supplier}` : ''}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'category',
      band: 'Item',
      label: 'Category',
      width: 'w-32',
      cell: (p) => <span className="text-slate-500">{p.category_name || '—'}</span>,
    },
    /*
     * How many are here, read before any of the money.
     *
     * It was the last column, and last is where a wide table clips: on a laptop
     * the five price columns pushed stock off the right-hand edge, so the one
     * figure somebody opens the catalogue to check was the one they had to
     * scroll for. The money is detail — it belongs after the count, not in
     * front of it.
     */
    {
      key: 'stock',
      width: 'whitespace-nowrap',
      band: 'Stock',
      label: 'Stock',
      cell: (p) =>
        /* A card cannot be out of stock, and saying so on every one of them
           would bury the products that genuinely are. */
        p.wallet_id ? (
          <Badge tone="brand">Card · {p.wallet_name}</Badge>
        ) : (
          <StockBadge stock={p.stock} reorderPoint={p.reorder_point} />
        ),
    },
    {
      key: 'price',
      width: 'whitespace-nowrap',
      band: 'Prices',
      label: 'Price',
      align: 'right',
      /*
       * The pound figure beside the dollar rather than beneath it. Stacked, it
       * wrapped — "9,612,000 LL" does not fit a price column — and every row in
       * the catalogue became two rows tall to carry a number nobody prices in.
       * `whitespace-nowrap` is the point: it may push the column wider, it may
       * not fold the row.
       */
      cell: (p) => (
        <span className="whitespace-nowrap">
          <span className="font-medium text-slate-800">{money(p.price)}</span>
          {rate > 0 && <span className="ml-1.5 text-xs text-slate-400">{lbp(toLbp(p.price))}</span>}
        </span>
      ),
    },
    {
      key: 'wholesale',
      width: 'whitespace-nowrap',
      band: 'Prices',
      label: 'Wholesale',
      align: 'right',
      // Blank rather than a dash-and-a-zero: most of a catalogue has no
      // wholesale price, and a column of dashes reads as a column of missing data.
      cell: (p) =>
        p.wholesale_price === null || p.wholesale_price === undefined ? (
          <span className="text-slate-300">—</span>
        ) : (
          <span className="text-slate-700">{money(p.wholesale_price)}</span>
        ),
    },
    {
      key: 'cost',
      width: 'whitespace-nowrap',
      band: 'Prices',
      label: 'Cost',
      align: 'right',
      cell: (p) => <span className="text-slate-600">{money(p.cost)}</span>,
    },
    {
      key: 'avgCost',
      width: 'whitespace-nowrap',
      band: 'Prices',
      label: 'Average cost',
      align: 'right',
      /*
       * What the shelf actually cost, across every delivery — $10 one month and
       * $9 the next is $9.50 a unit, and that is the figure a margin means
       * anything against. Blank when nothing has been received on a purchase
       * invoice, because a number called "average" that nobody averaged is
       * worse than nothing.
       */
      cell: (p) =>
        p.avg_cost === null || p.avg_cost === undefined ? (
          <span className="text-slate-300" title="Nothing received on a purchase invoice yet">
            —
          </span>
        ) : (
          <span
            className={cx(
              'font-medium',
              // Worth a glance: the last delivery cost more than the shelf
              // average, so the margin is thinner than the catalogue says.
              p.last_cost > p.avg_cost ? 'text-amber-700' : 'text-slate-700',
            )}
            title={
              p.last_cost
                ? `Last paid ${money(p.last_cost)}${p.last_cost_ref ? ` on ${p.last_cost_ref}` : ''}`
                : undefined
            }
          >
            {money(p.avg_cost)}
          </span>
        ),
    },
    {
      key: 'margin',
      width: 'whitespace-nowrap',
      band: 'Prices',
      label: 'Margin',
      align: 'right',
      /*
       * Against the average where there is one, and against the typed cost
       * otherwise. A margin worked out from what somebody last typed, while
       * stock bought at two prices is still on the shelf, is a number that
       * flatters or frightens for no reason.
       */
      cell: (p) => {
        const basis = p.avg_cost ?? p.cost;
        const margin = p.price > 0 ? ((p.price - basis) / p.price) * 100 : 0;
        return (
          <span className="text-slate-500" title={p.avg_cost ? 'Against the average cost' : undefined}>
            {margin.toFixed(0)}%
          </span>
        );
      },
    },
    {
      key: 'actions',
      band: null,
      label: 'Actions',
      fixed: true,
      pad: true,
      align: 'right',
      /*
       * Icons alone, and the labels moved into `title` and `aria-label`.
       *
       * Four buttons with words on them were a fifth of the window, and the
       * columns they pushed off the right-hand edge — average cost, margin —
       * are the ones somebody opens this screen to compare. A row of icons at
       * the end of a table row is the one place a shopkeeper does not need
       * words: they are in the same order on every row, and they are the only
       * things here that can be pressed.
       */
      cell: (p) => (
        <div className="flex justify-end gap-0.5">
          {/* Serialised products are managed by handset, so the shortcut goes
              where the work actually is. */}
          {p.tracks_units ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setUnitsFor(p)}
              aria-label={`Handsets of ${p.name}`}
              title="Book in and track each IMEI"
            >
              <Smartphone size={15} />
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setActivityFor(p.id)}
            aria-label={`Activity for ${p.name}`}
            title="Sales, deliveries and cost changes"
          >
            <History size={15} />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setEditing(p)}
            aria-label={`Edit ${p.name}`}
            title="Edit this product"
          >
            <Pencil size={15} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => toggleArchive(p)}
            aria-label={p.active ? `Archive ${p.name}` : `Restore ${p.name}`}
          >
            {p.active ? <Archive size={14} /> : <ArchiveRestore size={14} />}
          </Button>
        </div>
      ),
    },
  ];
  const cols = useColumns('products', COLUMNS);

  /*
   * The heading bands, worked out from whichever columns are actually showing.
   *
   * Derived rather than declared, because the reader can hide any column that
   * is not fixed — a band written down as three columns wide is a band that
   * spans the wrong things the moment somebody hides one of them, and the
   * heading silently stops sitting over its own numbers.
   */
  const bands = [];
  cols.visible.forEach((c, i) => {
    const previous = i > 0 ? cols.visible[i - 1].band ?? null : undefined;
    const band = c.band ?? null;
    if (band !== previous) {
      bands.push({ name: band, span: 1 });
      /* Marks the column a rule is drawn down, so the two heading rows and the
         body all break in the same places. */
      c.bandStart = i > 0;
    } else {
      bands[bands.length - 1].span += 1;
      c.bandStart = false;
    }
  });

  const visible = (products || []).filter((p) => {
    const term = search.trim().toLowerCase();
    const matchesSearch =
      !term ||
      p.name.toLowerCase().includes(term) ||
      p.sku.toLowerCase().includes(term) ||
      (p.barcodes || []).some((code) => code.includes(term));
    return matchesSearch && (showArchived ? true : p.active);
  });

  /*
   * Only the rows in the window get rendered. A catalogue this size is tens of
   * thousands of elements otherwise, and the screen goes sticky under the
   * scroll. See lib/windowedRows.js.
   */
  const rows = useWindowedRows({ count: visible.length });

  /*
   * The search's own totals. Worked out from the rows on screen rather than
   * asked of the server, so it can never disagree with the list underneath it.
   */
  const found = (() => {
    let units = 0;
    let cost = 0;
    let retail = 0;
    let noCost = 0;
    for (const p of visible) {
      const stock = Number(p.stock) || 0;
      units += stock;
      retail += (Number(p.price) || 0) * stock;
      if (p.cost === null || p.cost === undefined) noCost += 1;
      else cost += Number(p.cost) * stock;
    }
    const round2 = (n) => Math.round(n * 100) / 100;
    return { units, cost: round2(cost), retail: round2(retail), noCost };
  })();

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Products"
        subtitle="Your catalog"
        actions={
          <>
            {/* Beside Import, because a supplier's file is the other thing
                that creates categories and this is where they get tidied. */}
            <Button variant="secondary" onClick={() => setManagingCategories(true)}>
              <Tags size={16} /> Categories
            </Button>
            <Link to="/admin/import">
              <Button variant="secondary">
                <Upload size={16} /> Import
              </Button>
            </Link>
            <Button onClick={() => setEditing(null)}>
              <Plus size={16} /> New product
            </Button>
          </>
        }
      />

      {/*
        * The table gets the window.
        *
        * The page used to scroll as a whole, which meant the search box and the
        * filters scrolled off the top and the screen wasted its last inch on
        * padding below a list that had already run out of room. Now the card
        * fills the height, the controls stay put, and the only thing that
        * scrolls is the rows — which is the only thing there is more of.
        */}
      <div className="min-h-0 flex-1 p-4 sm:p-6">
        <Card className="flex h-full flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
            <div className="relative min-w-[12rem] flex-1">
              <Search
                size={16}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, SKU or barcode…"
                className="h-9 w-full rounded-lg bg-slate-100 pr-3 pl-9 text-sm ring-1 ring-transparent transition focus:bg-white focus:ring-brand-600 focus:outline-none"
              />
            </div>

            {/* Walking the shelves with a phone: point it at the box rather
                than typing thirteen digits off it. */}
            {canScan() && <ScanButton onClick={() => setScanning(true)} />}
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-brand-600"
              />
              Show archived
            </label>

            {/* Beside the search rather than in the header: it is a choice
                about the table underneath, made while looking at it. */}
            <ColumnPicker
              table="products"
              columns={COLUMNS}
              hidden={cols.hidden}
              onChange={cols.setHidden}
            />
          </div>

          {/*
            * What the search just added up to.
            *
            * "How many batteries have I got, and what are they worth?" is a
            * stocktaking question, and the answer was a column of numbers to
            * add up by eye — or an export. Typing the word is already the
            * whole query; this is just the total of what came back.
            *
            * Cost, not price: what is on the shelf is money the shop has spent
            * and not yet got back, which is the figure a stocktake is about.
            * A product with no cost recorded is counted in the quantity and
            * said out loud below, rather than quietly valued at nothing.
            */}
          {products && search.trim() && visible.length > 0 && (
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-slate-100 bg-slate-50 px-5 py-2.5 text-sm">
              <span className="text-slate-500">
                <span className="tnum font-semibold text-slate-800">{visible.length}</span>{' '}
                {visible.length === 1 ? 'product' : 'products'} matching “{search.trim()}”
              </span>
              <span className="text-slate-500">
                <span className="tnum font-semibold text-slate-800">{found.units}</span> in stock
              </span>
              <span className="text-slate-500">
                worth <span className="tnum font-semibold text-slate-800">{money(found.cost)}</span> at
                cost
              </span>
              {found.retail > 0 && (
                <span className="text-slate-400">
                  · {money(found.retail)} at the shelf price
                </span>
              )}
              {found.noCost > 0 && (
                <span className="text-amber-700">
                  · {found.noCost} with no cost recorded, so the value is short
                </span>
              )}
            </div>
          )}

          {!products ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No products"
              description={search ? 'Nothing matches your search.' : 'Add a product or import your catalog.'}
              action={
                <Link to="/admin/import">
                  <Button variant="secondary">
                    <Upload size={16} /> Import a CSV
                  </Button>
                </Link>
              }
            />
          ) : (
            <div ref={rows.scrollRef} className="min-h-0 flex-1 overflow-auto">
              <table className="w-full text-sm">
                {/*
                  * Two rows of heading, because the columns are three different
                  * kinds of fact about one product and reading them as one flat
                  * row means working that out afresh every time. What it is,
                  * what it costs and sells for, how many are here — said once
                  * across the top, so the eye can go to the band it wants and
                  * then to the column.
                  *
                  * Sticky, because a catalogue is two thousand rows and a
                  * heading that scrolls away leaves a wall of numbers with
                  * nothing to say which is the cost and which is the margin.
                  */}
                {/*
                  * Both rows are pinned, not the `thead`.
                  *
                  * Sticky on the section works in some browsers and quietly
                  * does not in others, and the way it fails is a row of the
                  * catalogue sliding up *between* the two heading rows —
                  * legible enough to look deliberate and wrong enough to make
                  * the column above it mean nothing. Pinning the cells is the
                  * form that holds everywhere. The band row is a fixed height
                  * so the row beneath it knows exactly where to stop.
                  */}
                <thead className="z-10 text-left text-xs text-slate-500">
                  <tr className="border-b border-slate-100">
                    {bands.map((b, i) => (
                      <th
                        key={b.name ?? `gap-${i}`}
                        colSpan={b.span}
                        className={cx(
                          'sticky top-0 z-20 h-7 bg-white px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase',
                          b.name === null && 'right-0 z-30',
                          /* A rule between bands, not around them: it separates
                             without drawing a box the data does not live in. */
                          i > 0 && 'border-l border-slate-100',
                        )}
                      >
                        {b.name}
                      </th>
                    ))}
                  </tr>
                  <tr className="border-b border-slate-200">
                    {cols.visible.map((c) => (
                      <th
                        key={c.key}
                        className={cx(
                          'sticky top-7 z-20 bg-white px-2.5 pt-0.5 pb-2 font-medium',
                          c.width,
                          c.align === 'right' && 'text-right',
                          c.pad && 'sm:pl-5',
                          c.bandStart && 'border-l border-slate-100',
                          c.key === 'actions' && 'right-0 z-30',
                        )}
                      >
                        {c.head ?? c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {/*
                    * Two spacers holding open the rows that are not rendered,
                    * so the scrollbar is the length of the whole catalogue and
                    * the position in it means what it looks like it means.
                    */}
                  {rows.padTop > 0 && (
                    <tr aria-hidden="true" style={{ height: rows.padTop }}>
                      <td colSpan={cols.visible.length} />
                    </tr>
                  )}
                  {visible.slice(rows.start, rows.end).map((p, i) => (
                    <tr
                      key={p.id}
                      /* The first rendered row is the one measured; see the
                         hook for why the height is measured and not declared. */
                      ref={i === 0 ? rows.measureRow : undefined}
                      className={cx('group/row hover:bg-slate-50/60', !p.active && 'opacity-55')}
                    >
                      {cols.visible.map((c) => (
                        <td
                          key={c.key}
                          /* Tighter than it was: a catalogue is read by
                             scanning down it, and every row that does not fit
                             is a row somebody has to scroll for. */
                          className={cx(
                            'px-2.5 py-1.5',
                            c.width,
                            c.align === 'right' && 'tnum text-right',
                            c.pad && 'sm:pl-5',
                            c.bandStart && 'border-l border-slate-100',
                            /* Pinned to the right edge. A wide catalogue scrolls
                               sideways, and buttons that scroll out of the
                               window are buttons nobody can press without first
                               working out that the table moves. */
                            c.key === 'actions' &&
                              'sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.15)] group-hover/row:bg-slate-50',
                          )}
                        >
                          {c.cell(p)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {rows.padBottom > 0 && (
                    <tr aria-hidden="true" style={{ height: rows.padBottom }}>
                      <td colSpan={cols.visible.length} />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {editing !== undefined && (
        <ProductModal
          product={editing}
          categories={categories}
          allProducts={products || []}
          onClose={() => setEditing(undefined)}
          /* Just the shelves, not the whole catalogue: a category named inside
             the dialog must appear in its list without the products behind it
             reloading under the form somebody is still filling in. */
          onCategories={loadCategories}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}

      {scanning && (
        <BarcodeScanner
          onCancel={() => setScanning(false)}
          onScanned={(code) => {
            setScanning(false);
            // Into the box, which already matches on barcode as well as name
            // and SKU — so a scan narrows the list the way typing would.
            setSearch(code);
          }}
        />
      )}

      {activityFor && (
        <ItemActivity
          productId={activityFor}
          onClose={() => setActivityFor(null)}
          /* An invoice is opened where it can be read, printed and corrected —
             the documents screen already does all three, and lands on the one
             asked for by number. */
          onOpenDocument={(row) =>
            navigate(`/admin/documents?number=${encodeURIComponent(row.reference)}`)
          }
          /* Only reached when the server did not send the sale's id — the
             Sales screen finds it by the number on the row. */
          onOpenSale={(row) => navigate(`/admin/orders?number=${encodeURIComponent(row.reference)}`)}
        />
      )}

      {managingCategories && (
        <CategoryManager onClose={() => setManagingCategories(false)} onChanged={load} />
      )}

      {unitsFor && (
        <Modal
          open
          onClose={() => setUnitsFor(null)}
          title={unitsFor.name}
          subtitle="Each handset, and what became of it"
          size="lg"
        >
          <UnitsPanel product={unitsFor} onChanged={load} />
        </Modal>
      )}
    </div>
  );
}
