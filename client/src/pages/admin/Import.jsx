import { useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, FileUp, Table2, Upload } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { Badge, Button, Card, EmptyState, Select, cx, money, useToast } from '../../components/ui';

const SAMPLE_CSV = `name,sku,price,cost,stock,category,barcode,supplier
Cold Brew,BEV-020,4.25,1.40,48,Beverages,5012345000301,Blue Bottle Roasters
Almond Croissant,BAK-010,3.95,1.20,24,Bakery,5012345000318,Corner Bakehouse
Canvas Apron,APP-010,28.00,9.50,15,Apparel,5012345000325,Northside Apparel`;

const STEPS = ['Upload', 'Map columns', 'Review', 'Done'];

export default function Import() {
  const toast = useToast();
  const fileRef = useRef(null);

  const [step, setStep] = useState(0);
  /*
   * The uploaded file, in whichever shape it came: `csv` is text, `workbook` is
   * an .xlsx as base64. Held together so every re-analysis — changing the
   * format, remapping a column, picking another sheet — sends the same file
   * back without the shop having to choose it again.
   */
  const [source, setSource] = useState({ csv: '', workbook: '', sheet: '' });
  const [fileName, setFileName] = useState('');
  const [formats, setFormats] = useState([]);
  const [fields, setFields] = useState([]);
  const [preview, setPreview] = useState(null);
  const [format, setFormat] = useState('');
  const [mapping, setMapping] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function analyze(from, chosenFormat, chosenMapping) {
    setBusy(true);
    setError('');
    try {
      const [meta, res] = await Promise.all([
        formats.length ? Promise.resolve(null) : api.get('/imports/formats'),
        api.post('/imports/preview', {
          ...from,
          format: chosenFormat || undefined,
          mapping: chosenMapping || undefined,
        }),
      ]);
      if (meta) {
        setFormats(meta.data.formats);
        setFields(meta.data.fields);
      }
      setPreview(res.data);
      setFormat(res.data.format);
      setMapping(res.data.mapping);
      // The server says which sheet it read, which matters when it chose.
      if (res.data.sheet) setSource((s) => ({ ...s, sheet: res.data.sheet }));
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not read that file');
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** An .xlsx as base64, which is how it travels inside a JSON body. */
  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('That file could not be read'));
      // A data: URI, of which only the part after the comma is wanted.
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(file);
    });
  }

  async function handleFile(file) {
    if (!file) return;

    /*
     * Decided by extension rather than by MIME type: Windows reports .xlsx as
     * half a dozen different types depending on what is installed, and a file
     * copied off a phone often arrives with no type at all.
     */
    const spreadsheet = /\.(xlsx|xlsm)$/i.test(file.name);
    const next = spreadsheet
      ? { csv: '', workbook: await toBase64(file), sheet: '' }
      : { csv: await file.text(), workbook: '', sheet: '' };

    setSource(next);
    setFileName(file.name);
    if (await analyze(next)) setStep(1);
  }

  async function changeFormat(next) {
    setFormat(next);
    await analyze(source, next);
  }

  async function changeMapping(field, header) {
    const next = { ...mapping, [field]: header || null };
    setMapping(next);
    await analyze(source, format, next);
  }

  /** Another tab of the same workbook — the mapping is re-guessed for it. */
  async function changeSheet(name) {
    const next = { ...source, sheet: name };
    setSource(next);
    await analyze(next);
  }

  async function commit() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/imports/commit', { ...source, format, mapping });
      setResult(res.data);
      setStep(3);
      /*
       * Phones are said as phones. "Imported 97 products" after a file of five
       * hundred handsets is true and reads as a failure — the four hundred and
       * three that are missing from it are the other phones of the same
       * ninety-seven models, and nothing on the screen said so.
       */
      toast(
        res.data.handsets > 0
          ? `Imported ${res.data.created + res.data.updated} products and ${res.data.handsets} phones`
          : `Imported ${res.data.created + res.data.updated} products`,
      );
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep(0);
    setSource({ csv: '', workbook: '', sheet: '' });
    setFileName('');
    setPreview(null);
    setResult(null);
    setError('');
  }

  const missingRequired = preview?.missingRequired || [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Import products"
        subtitle="Bring your catalog over from Shopify, Square, Lightspeed or any CSV export"
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-4xl">
          {/* Stepper */}
          <ol className="mb-6 flex items-center gap-2">
            {STEPS.map((label, i) => (
              <li key={label} className="flex flex-1 items-center gap-2">
                <span
                  className={cx(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                    i < step
                      ? 'bg-brand-600 text-white'
                      : i === step
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-200 text-slate-500',
                  )}
                >
                  {i < step ? <CheckCircle2 size={14} /> : i + 1}
                </span>
                <span className={cx('text-sm', i === step ? 'font-medium text-slate-900' : 'text-slate-500')}>
                  {label}
                </span>
                {i < STEPS.length - 1 && <span className="h-px flex-1 bg-slate-200" />}
              </li>
            ))}
          </ol>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Step 1 — upload */}
          {step === 0 && (
            <Card className="p-6">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  handleFile(e.dataTransfer.files[0]);
                }}
                className="flex flex-col items-center rounded-xl border-2 border-dashed border-slate-300 px-6 py-12 text-center"
              >
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                  <FileUp size={22} />
                </div>
                <p className="font-medium text-slate-800">Drop a CSV file here</p>
                <p className="mt-1 max-w-sm text-sm text-slate-500">
                  Excel or CSV. We auto-detect Shopify, Square and Lightspeed exports, and map anything else by
                  column name.
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.tsv,.txt,.xlsx,.xlsm,text/csv"
                  className="hidden"
                  onChange={(e) => handleFile(e.target.files[0])}
                />
                <Button className="mt-4" loading={busy} onClick={() => fileRef.current?.click()}>
                  <Upload size={16} /> Choose file
                </Button>
              </div>

              <div className="mt-5 flex items-center justify-between gap-4 rounded-xl bg-slate-50 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-700">No file handy?</p>
                  <p className="text-xs text-slate-500">Load a small sample catalog to try the flow.</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  onClick={async () => {
                    const sample = { csv: SAMPLE_CSV, workbook: '', sheet: '' };
                    setSource(sample);
                    setFileName('sample-catalog.csv');
                    if (await analyze(sample)) setStep(1);
                  }}
                >
                  Use sample
                </Button>
              </div>
            </Card>
          )}

          {/* Step 2 — mapping */}
          {step === 1 && preview && (
            <Card className="p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-slate-800">{fileName}</p>
                  <p className="text-sm text-slate-500">
                    {preview.summary.total} rows · {preview.headers.length} columns
                  </p>
                </div>
                <div className="flex gap-3">
                  {/*
                    * Only when there is a choice to make. A supplier's workbook
                    * routinely holds the price list, a cover note and last
                    * month's version, and the app cannot know which is which —
                    * but a one-sheet file has nothing to ask about.
                    */}
                  {preview.sheets?.length > 1 && (
                    <div className="w-48">
                      <Select
                        value={preview.sheet || ''}
                        onChange={(e) => changeSheet(e.target.value)}
                        label="Sheet"
                      >
                        {preview.sheets.map((s) => (
                          <option key={s.name} value={s.name}>
                            {s.name} ({s.rows} rows)
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                  <div className="w-56">
                    <Select value={format} onChange={(e) => changeFormat(e.target.value)} label="Source format">
                      {formats.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              </div>

              {preview.detectedFormat !== 'generic' && (
                <div className="mb-4 flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
                  <CheckCircle2 size={15} />
                  Detected a{' '}
                  {formats.find((f) => f.key === preview.detectedFormat)?.label || preview.detectedFormat} export.
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                {fields.map((field) => (
                  <div key={field.key} className="flex items-center gap-3">
                    <label
                      htmlFor={`map-${field.key}`}
                      className="w-36 shrink-0 text-sm text-slate-600"
                    >
                      {field.label}
                      {field.required && <span className="ml-0.5 text-red-500">*</span>}
                    </label>
                    <select
                      id={`map-${field.key}`}
                      value={mapping[field.key] || ''}
                      onChange={(e) => changeMapping(field.key, e.target.value)}
                      className={cx(
                        'h-9 min-w-0 flex-1 rounded-lg bg-white px-2 text-sm ring-1 transition focus:outline-none focus:ring-2 focus:ring-brand-600',
                        field.required && !mapping[field.key] ? 'ring-red-400' : 'ring-edge',
                      )}
                    >
                      <option value="">— not mapped —</option>
                      {preview.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {missingRequired.length > 0 && (
                <p className="mt-4 text-sm text-red-600">
                  Map these before continuing: {missingRequired.join(', ')}
                </p>
              )}

              <div className="mt-6 flex gap-2">
                <Button variant="secondary" onClick={reset}>
                  <ArrowLeft size={16} /> Start over
                </Button>
                <Button
                  className="flex-1"
                  disabled={missingRequired.length > 0}
                  loading={busy}
                  onClick={() => setStep(2)}
                >
                  Review {preview.summary.total} rows
                </Button>
              </div>
            </Card>
          )}

          {/* Step 3 — review */}
          {step === 2 && preview && (
            <Card>
              <div className="flex flex-wrap items-center gap-4 border-b border-slate-100 px-5 py-4">
                {/*
                  * A file of phones is counted in phones.
                  *
                  * "5 new" is true of the rows and useless to the person
                  * reading it — what they are about to import is four handsets
                  * across four models, and that is the pair they will check
                  * against the delivery in front of them.
                  */}
                {preview.serialised ? (
                  <>
                    <Badge tone="good" icon={CheckCircle2}>
                      {preview.summary.handsets} phone{preview.summary.handsets === 1 ? '' : 's'}
                    </Badge>
                    <Badge tone="info">
                      {preview.summary.models} model{preview.summary.models === 1 ? '' : 's'}
                    </Badge>
                    {/* A real catalogue is phones and chargers together, so the
                        count of everything that is not a phone belongs here
                        too — otherwise the file looks half read. */}
                    {preview.summary.plain > 0 && (
                      <Badge tone="neutral">
                        {preview.summary.plain} other product
                        {preview.summary.plain === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </>
                ) : (
                  <>
                    <Badge tone="good" icon={CheckCircle2}>
                      {preview.summary.create} new
                    </Badge>
                    <Badge tone="info">{preview.summary.update} updates</Badge>
                  </>
                )}
                {preview.summary.error > 0 && (
                  <Badge tone="critical" icon={AlertTriangle}>
                    {preview.summary.error} skipped
                  </Badge>
                )}
                {preview.summary.converted > 0 && (
                  <Badge tone="warning">
                    {preview.summary.converted} converted from LBP at{' '}
                    {Number(preview.rate).toLocaleString('en-US')}
                  </Badge>
                )}
                {preview.serialised && (
                  <span className="text-xs text-slate-500">
                    A row with a serial number is one handset; the rest come in as ordinary products
                    with their quantity.
                  </span>
                )}
                {preview.truncated && (
                  <span className="text-xs text-slate-400">
                    The table below shows the first 100 rows; the counts above are the whole file.
                  </span>
                )}
              </div>

              {/*
                * The arithmetic of the file, spelled out.
                *
                * A shop that imports a five-hundred-line spreadsheet and finds
                * ninety-seven products has no way, from the badges alone, to
                * tell a correct grouping from four hundred lost rows. Both are
                * possible and they look identical. So the sentence is written
                * out: this many lines, this many products, and here is where
                * the difference went.
                */}
              {preview.summary.total !== preview.summary.products && (
                <div className="border-b border-slate-100 px-5 py-3">
                  <p className="text-sm text-slate-700">
                    <span className="font-medium">{preview.summary.total} rows</span> in the file
                    come to{' '}
                    <span className="font-medium">
                      {preview.summary.products} product
                      {preview.summary.products === 1 ? '' : 's'}
                    </span>
                    .
                    {preview.serialised && preview.summary.handsets > preview.summary.models && (
                      <>
                        {' '}
                        Handsets of the same model are one product with its phones inside it, so{' '}
                        {preview.summary.handsets} phones become {preview.summary.models} model
                        {preview.summary.models === 1 ? '' : 's'}.
                      </>
                    )}
                  </p>

                  {preview.summary.reasons?.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs text-red-700">
                      {preview.summary.reasons.map((r) => (
                        <li key={r.message}>
                          {r.message} — <span className="font-medium tnum">{r.count}</span> row
                          {r.count === 1 ? '' : 's'}
                          <span className="text-red-400">
                            {' '}
                            ({r.lines.join(', ')}
                            {r.count > r.lines.length ? ' and more' : ''})
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/*
                * The models the handsets fall into, before any of it is
                * written.
                *
                * The condition is read off the model's own name — "USED",
                * "OB" — which is a guess from text and the one thing worth
                * checking with the delivery in front of you. The row table
                * below still lists every phone; this is what the rows *mean*.
                */}
              {preview.serialised && preview.groups?.length > 0 && (
                <div className="border-b border-slate-100 px-5 py-3">
                  <p className="mb-2 text-xs font-medium text-slate-500">
                    What these rows come to
                  </p>
                  <ul className="space-y-1.5">
                    {preview.groups.slice(0, 40).map((g) => (
                      <li key={g.sku} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <span className="font-medium text-slate-800">{g.name}</span>
                        <Badge
                          tone={
                            g.condition === 'new'
                              ? 'good'
                              : g.condition === 'used'
                                ? 'warning'
                                : 'info'
                          }
                        >
                          {g.condition}
                        </Badge>
                        <span className="text-slate-600">
                          {g.units.length} phone{g.units.length === 1 ? '' : 's'}
                        </span>
                        <span className="font-mono text-xs text-slate-400">{g.sku}</span>
                        {g.notes.map((n) => (
                          <span key={n} className="text-xs text-amber-700">
                            {n}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                  {preview.groups.length > 40 && (
                    <p className="mt-2 text-xs text-slate-400">
                      and {preview.groups.length - 40} more
                    </p>
                  )}
                </div>
              )}

              <div className="max-h-[380px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white text-left text-xs text-slate-500 shadow-[0_1px_0_#f1f5f9]">
                    <tr>
                      <th className="px-4 py-2 font-medium">Row</th>
                      <th className="px-3 py-2 font-medium">Product</th>
                      <th className="px-3 py-2 font-medium">SKU</th>
                      <th className="px-3 py-2 text-right font-medium">Price</th>
                      <th className="px-3 py-2 text-right font-medium">Stock</th>
                      <th className="px-4 py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {preview.rows.map((row) => (
                      <tr key={row.line} className={row.action === 'error' ? 'bg-red-50/50' : ''}>
                        <td className="tnum px-4 py-2 text-slate-400">{row.line}</td>
                        <td className="px-3 py-2 text-slate-800">
                          {row.data.name || <span className="text-slate-400">—</span>}
                          {row.errors.length > 0 && (
                            <p className="text-xs text-red-600">{row.errors.join(' · ')}</p>
                          )}
                          {/* What was changed on the way in, said per row —
                              a price converted out of pounds is not an error
                              but it is the thing to check before committing. */}
                          {row.notes?.length > 0 && (
                            <p className="text-xs text-amber-700">{row.notes.join(' · ')}</p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-500">{row.data.sku || '—'}</td>
                        <td className="tnum px-3 py-2 text-right text-slate-700">
                          {row.action === 'error' ? '—' : money(row.data.price)}
                        </td>
                        <td className="tnum px-3 py-2 text-right text-slate-700">
                          {row.action === 'error' ? '—' : row.data.stock}
                        </td>
                        <td className="px-4 py-2">
                          {row.action === 'create' && <Badge tone="good">Create</Badge>}
                          {row.action === 'update' && <Badge tone="info">Update</Badge>}
                          {row.action === 'error' && <Badge tone="critical">Skip</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex gap-2 border-t border-slate-100 px-5 py-4">
                <Button variant="secondary" onClick={() => setStep(1)}>
                  <ArrowLeft size={16} /> Back to mapping
                </Button>
                <Button
                  className="flex-1"
                  loading={busy}
                  disabled={preview.summary.create + preview.summary.update === 0}
                  onClick={commit}
                >
                  {/* A file of phones is committed in phones, for the same
                      reason it is counted in them above. */}
                  {preview.serialised
                    ? `Import ${preview.summary.handsets} phone${preview.summary.handsets === 1 ? '' : 's'}` +
                      (preview.summary.plain > 0 ? ` and ${preview.summary.plain} more` : '')
                    : `Import ${preview.summary.create + preview.summary.update} products`}
                </Button>
              </div>
            </Card>
          )}

          {/* Step 4 — done */}
          {step === 3 && result && (
            <Card className="p-8">
              <div className="text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50">
                  <CheckCircle2 size={24} className="text-brand-600" />
                </div>
                <h2 className="text-lg font-semibold text-slate-900">Import complete</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {result.created} created · {result.updated} updated
                  {result.handsets > 0 &&
                    ` · ${result.handsets} handset${result.handsets === 1 ? '' : 's'} booked in`}
                  {result.categoriesCreated > 0 &&
                    ` · ${result.categoriesCreated} new categor${result.categoriesCreated === 1 ? 'y' : 'ies'}`}
                </p>
                {/* The number the shop started with, next to the number it got.
                    Without it a 250-row file that correctly becomes 12 products
                    looks like 238 rows that went missing. */}
                {result.total > 0 && (
                  <p className="mt-1 text-xs text-slate-400">
                    from {result.total} row{result.total === 1 ? '' : 's'} in the file
                  </p>
                )}
              </div>

              {result.errors.length > 0 && (
                <div className="mt-5 rounded-xl bg-amber-50 px-4 py-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-amber-900">
                    <AlertTriangle size={15} /> {result.errors.length} row
                    {result.errors.length === 1 ? '' : 's'} skipped
                  </p>
                  <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-amber-800">
                    {result.errors.map((e) => (
                      <li key={e.line}>
                        Row {e.line}
                        {e.sku ? ` (${e.sku})` : ''}: {e.messages.join(', ')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-6 flex justify-center gap-2">
                <Button variant="secondary" onClick={reset}>
                  Import another file
                </Button>
                <Button onClick={() => window.location.assign('/admin/products')}>
                  <Table2 size={16} /> View products
                </Button>
              </div>
            </Card>
          )}

          {step === 0 && !source.csv && !source.workbook && !busy && !error && (
            <EmptyState
              className="mt-2"
              title=""
              description="Columns are matched automatically; you can correct any mapping before importing. Existing products are matched by SKU and updated in place."
            />
          )}
        </div>
      </div>
    </div>
  );
}
