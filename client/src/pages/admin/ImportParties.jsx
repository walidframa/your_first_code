import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileUp, Info, Upload } from 'lucide-react';
import api from '../../api';
import { Badge, Button, Card, Select, cx, money, useToast } from '../../components/ui';

/**
 * Bringing the shop's people over from the system it used before.
 *
 * The catalogue could be imported and the people could not, so a shop arriving
 * with a hundred and eighty-five customers typed them in one at a time before
 * the app was any use for the thing it does most: selling on credit to people
 * it knows.
 *
 * Deliberately the same four steps as the product import, because it is the
 * same job with a different noun and a shop should not have to learn a second
 * screen. What is different is what the review step has to say — see below.
 */

const STEPS = ['Upload', 'Map columns', 'Review', 'Done'];

const NOUN = {
  customer: { one: 'customer', many: 'customers', title: 'customers' },
  supplier: { one: 'supplier', many: 'suppliers', title: 'suppliers' },
};

export default function ImportParties({ partyType }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const noun = NOUN[partyType];

  const [step, setStep] = useState(0);
  const [source, setSource] = useState({ csv: '', workbook: '', sheet: '' });
  const [fileName, setFileName] = useState('');
  const [fields, setFields] = useState([]);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [withBalances, setWithBalances] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function analyse(from, chosenMapping) {
    setBusy(true);
    setError('');
    try {
      const [meta, res] = await Promise.all([
        fields.length ? Promise.resolve(null) : api.get('/imports/parties/fields'),
        api.post('/imports/parties/preview', {
          ...from,
          partyType,
          mapping: chosenMapping || undefined,
        }),
      ]);
      if (meta) setFields(meta.data.fields);
      setPreview(res.data);
      setMapping(res.data.mapping);
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
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(file);
    });
  }

  async function handleFile(file) {
    if (!file) return;
    // By extension rather than MIME type, for the reason the product import
    // gives: Windows reports .xlsx half a dozen ways and a phone reports none.
    const spreadsheet = /\.(xlsx|xlsm)$/i.test(file.name);
    const next = spreadsheet
      ? { csv: '', workbook: await toBase64(file), sheet: '' }
      : { csv: await file.text(), workbook: '', sheet: '' };

    setSource(next);
    setFileName(file.name);
    if (await analyse(next)) setStep(1);
  }

  async function changeMapping(field, header) {
    const next = { ...mapping, [field]: header || null };
    setMapping(next);
    await analyse(source, next);
  }

  async function changeSheet(name) {
    const next = { ...source, sheet: name };
    setSource(next);
    await analyse(next);
  }

  async function commit() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/imports/parties/commit', {
        ...source,
        partyType,
        mapping,
        withBalances,
      });
      setResult(res.data);
      setStep(3);
      toast(`Imported ${res.data.created + res.data.updated} ${noun.many}`);
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

  const summary = preview?.summary;

  return (
    <div className="mx-auto max-w-4xl">
      <ol className="mb-6 flex items-center gap-2">
        {STEPS.map((label, i) => (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={cx(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                i < step ? 'bg-brand-600 text-white' : i === step ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-500',
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

      {/* ------------------------------------------------------------ upload */}
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
            <p className="font-medium text-slate-800">Drop your {noun.title} file here</p>
            <p className="mt-1 max-w-md text-sm text-slate-500">
              Excel or CSV, straight out of your old system. An accounts export works as it comes — headings
              and one row per currency are read as what they are.
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
        </Card>
      )}

      {/* ----------------------------------------------------------- mapping */}
      {step === 1 && preview && (
        <Card className="p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium text-slate-800">{fileName}</p>
              <p className="text-sm text-slate-500">
                {summary.rows} rows · {preview.headers.length} columns
              </p>
            </div>
            {preview.sheets?.length > 1 && (
              <div className="w-48">
                <Select value={preview.sheet || ''} onChange={(e) => changeSheet(e.target.value)} label="Sheet">
                  {preview.sheets.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name} ({s.rows} rows)
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {fields
              .filter((f) => !f.customerOnly || partyType === 'customer')
              .map((field) => (
                <div key={field.key} className="flex items-center gap-3">
                  <label htmlFor={`pmap-${field.key}`} className="w-32 shrink-0 text-sm text-slate-600">
                    {field.label}
                    {field.required && <span className="text-red-500"> *</span>}
                  </label>
                  <Select
                    id={`pmap-${field.key}`}
                    value={mapping[field.key] || ''}
                    onChange={(e) => changeMapping(field.key, e.target.value)}
                  >
                    <option value="">— not in the file —</option>
                    {preview.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
          </div>

          {!mapping.name && (
            <p className="mt-4 text-sm text-red-600">
              Say which column holds the name — nothing can be imported without it.
            </p>
          )}

          <div className="mt-6 flex justify-between">
            <Button variant="secondary" onClick={reset}>
              Start over
            </Button>
            <Button disabled={!mapping.name} loading={busy} onClick={() => setStep(2)}>
              Review {summary.parties} {noun.many}
            </Button>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------ review */}
      {step === 2 && preview && (
        <Card className="p-6">
          {/*
            * Rows in, people out.
            *
            * They are different numbers whenever the old system kept a balance
            * per currency, and showing only the second next to a file the shop
            * knows the length of reads as lines lost. Both are said.
            */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Rows in the file', summary.rows],
              ['New', summary.create],
              ['Already here', summary.update],
              ['With a balance', summary.withBalance],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="tnum text-lg font-semibold text-slate-900">{value}</p>
              </div>
            ))}
          </div>

          {/*
            * What it all comes to, before it is written.
            *
            * The figure that makes a wrong number visible: one supplier
            * carrying an old-lira balance a thousand times everybody else's
            * looks perfectly ordinary on its own row and turns the total
            * inside out. Shown in both currencies as well as combined, because
            * that is where such a thing shows up.
            */}
          {summary.withBalance > 0 && (
            <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span className="text-slate-500">These {noun.many} come to</span>
              <span className="tnum font-semibold text-slate-900">{money(summary.total)}</span>
              <span className="tnum text-slate-500">
                {money(summary.totalUsd)}
                {summary.totalLbp !== 0 && <> + {summary.totalLbp.toLocaleString()} LL</>}
              </span>
              <span className="text-xs text-slate-500">
                {summary.total >= 0
                  ? partyType === 'customer'
                    ? 'owed to the shop'
                    : 'the shop owes them'
                  : partyType === 'customer'
                    ? 'owed by the shop'
                    : 'they owe the shop'}
              </span>
            </div>
          )}

          {summary.rows !== summary.parties && (
            <p className="mt-3 flex items-start gap-2 text-sm text-slate-600">
              <Info size={15} className="mt-0.5 shrink-0 text-slate-400" />
              <span>
                {summary.rows} rows come to {summary.parties} {noun.many}. Headings are not people, and a{' '}
                {noun.one} with a dollar balance and a pound balance is one {noun.one} with two rows.
              </span>
            </p>
          )}

          {/*
            * Everything the import could not carry, before it is committed
            * rather than after. A row quietly dropped is found months later
            * from a balance that never agreed.
            */}
          {preview.skipped.length > 0 && (
            <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3">
              <p className="text-sm font-medium text-amber-900">
                {preview.skipped.length} not imported — no name in the file
              </p>
              <ul className="mt-1 space-y-0.5 text-sm text-amber-800">
                {preview.skipped.map((s) => (
                  <li key={s.code} className="tnum">
                    {s.code}
                    {(s.usd !== 0 || s.lbp !== 0) && (
                      <> — carrying {s.usd !== 0 && money(s.usd)} {s.lbp !== 0 && `${s.lbp.toLocaleString()} LL`}</>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.problems > 0 && (
            <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3">
              <p className="text-sm font-medium text-amber-900">
                {summary.problems} {summary.problems === 1 ? 'figure was' : 'figures were'} left out
              </p>
              <ul className="mt-1 space-y-0.5 text-sm text-amber-800">
                {preview.parties
                  .filter((p) => p.problems.length)
                  .flatMap((p) => p.problems.map((m) => ({ name: p.name, m })))
                  .map(({ name, m }) => (
                    <li key={`${name}-${m}`}>
                      <span className="font-medium">{name}</span> — {m}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-xl bg-slate-50 px-4 py-3">
            <input
              type="checkbox"
              checked={withBalances}
              onChange={(e) => setWithBalances(e.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span className="text-sm text-slate-700">
              Bring their balances over as well
              <span className="block text-xs text-slate-500">
                Written once, as an opening balance on each statement. Leave this off to import names and phone
                numbers only and enter the {summary.withBalance} balances by hand.
              </span>
            </span>
          </label>

          <div className="mt-5 max-h-96 overflow-auto rounded-xl ring-1 ring-edge">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Phone</th>
                  <th className="px-3 py-2 text-right font-medium">USD</th>
                  <th className="px-3 py-2 text-right font-medium">LBP</th>
                  <th className="px-3 py-2 font-medium"> </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {preview.parties.map((p) => (
                  <tr key={p.code || p.name} className="border-t border-edge">
                    <td className="px-3 py-1.5 text-slate-800">{p.name}</td>
                    <td className="px-3 py-1.5 text-slate-500">{p.phone}</td>
                    <td className="tnum px-3 py-1.5 text-right text-slate-700">{p.usd !== 0 && money(p.usd)}</td>
                    <td className="tnum px-3 py-1.5 text-right text-slate-700">
                      {p.lbp !== 0 && p.lbp.toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5">
                      {p.action === 'update' && <Badge tone="neutral">already here</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.truncated && (
            <p className="mt-2 text-xs text-slate-500">
              Showing the first 100. All {summary.parties} will be imported.
            </p>
          )}

          <div className="mt-6 flex justify-between">
            <Button variant="secondary" onClick={() => setStep(1)}>
              Back to columns
            </Button>
            <Button loading={busy} onClick={commit}>
              Import {summary.parties} {noun.many}
            </Button>
          </div>
        </Card>
      )}

      {/* -------------------------------------------------------------- done */}
      {step === 3 && result && (
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="text-brand-600" size={22} />
            <div>
              <p className="font-medium text-slate-900">
                {result.created} added, {result.updated} updated
              </p>
              <p className="text-sm text-slate-500">
                {result.balances > 0
                  ? `${result.balances} opening ${result.balances === 1 ? 'balance' : 'balances'} written.`
                  : 'No balances were written.'}
              </p>
            </div>
          </div>

          {result.skipped?.length > 0 && (
            <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium text-amber-900">
                {result.skipped.length} could not be imported — no name against the account
              </p>
              <ul className="mt-1 space-y-0.5">
                {result.skipped.map((s) => (
                  <li key={s.code} className="tnum">
                    {s.code}
                    {(s.usd !== 0 || s.lbp !== 0) && (
                      <> — {s.usd !== 0 && money(s.usd)} {s.lbp !== 0 && `${s.lbp.toLocaleString()} LL`}</>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.problems?.length > 0 && (
            <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium text-amber-900">Figures that were left out</p>
              <ul className="mt-1 space-y-0.5">
                {result.problems.map((p) => (
                  <li key={`${p.name}-${p.problem}`}>
                    <span className="font-medium">{p.name}</span> — {p.problem}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-6">
            <Button variant="secondary" onClick={reset}>
              Import another file
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
