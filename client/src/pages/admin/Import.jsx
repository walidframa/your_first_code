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
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [formats, setFormats] = useState([]);
  const [fields, setFields] = useState([]);
  const [preview, setPreview] = useState(null);
  const [format, setFormat] = useState('');
  const [mapping, setMapping] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function analyze(text, chosenFormat, chosenMapping) {
    setBusy(true);
    setError('');
    try {
      const [meta, res] = await Promise.all([
        formats.length ? Promise.resolve(null) : api.get('/imports/formats'),
        api.post('/imports/preview', {
          csv: text,
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
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not read that file');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file) {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    if (await analyze(text)) setStep(1);
  }

  async function changeFormat(next) {
    setFormat(next);
    await analyze(csv, next);
  }

  async function changeMapping(field, header) {
    const next = { ...mapping, [field]: header || null };
    setMapping(next);
    await analyze(csv, format, next);
  }

  async function commit() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/imports/commit', { csv, format, mapping });
      setResult(res.data);
      setStep(3);
      toast(`Imported ${res.data.created + res.data.updated} products`);
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep(0);
    setCsv('');
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

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
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
                  We auto-detect Shopify, Square and Lightspeed exports, and map generic CSVs by column name.
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv"
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
                    setCsv(SAMPLE_CSV);
                    setFileName('sample-catalog.csv');
                    if (await analyze(SAMPLE_CSV)) setStep(1);
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
                        field.required && !mapping[field.key] ? 'ring-red-400' : 'ring-slate-300',
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
                <Badge tone="good" icon={CheckCircle2}>
                  {preview.summary.create} new
                </Badge>
                <Badge tone="info">{preview.summary.update} updates</Badge>
                {preview.summary.error > 0 && (
                  <Badge tone="critical" icon={AlertTriangle}>
                    {preview.summary.error} skipped
                  </Badge>
                )}
                {preview.truncated && (
                  <span className="text-xs text-slate-400">Showing the first 100 rows</span>
                )}
              </div>

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
                  Import {preview.summary.create + preview.summary.update} products
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
                  {result.categoriesCreated > 0 && ` · ${result.categoriesCreated} new categories`}
                </p>
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

          {step === 0 && !csv && !busy && !error && (
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
