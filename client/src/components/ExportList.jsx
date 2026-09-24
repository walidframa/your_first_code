import { useEffect, useMemo, useState } from 'react';
import { FileSpreadsheet, FileText } from 'lucide-react';
import api from '../api';
import { Button, Modal, ModalActions, useToast } from './ui';

/**
 * Take a list away as a file.
 *
 * The screen already knows which rows are wanted — whatever survived the
 * search and the filters — and here the owner ticks which columns, then
 * takes it as Excel or as a PDF. The ticks are remembered per list, because
 * the columns a supplier is sent are the same every month.
 *
 * `columns` are `{ key, label, get(row), align, default }`; `rows` is the
 * array on screen, or a function that fetches the whole filtered set when
 * the screen only holds one page of it.
 */
export default function ExportList({ open, onClose, title, subtitle = null, filename, columns, rows, storageKey }) {
  const toast = useToast();
  const [chosen, setChosen] = useState(() => remembered(storageKey, columns));
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    if (open) setChosen(remembered(storageKey, columns));
  }, [open, storageKey, columns]);

  const picked = useMemo(() => columns.filter((c) => chosen.has(c.key)), [columns, chosen]);

  function toggle(key) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* Private browsing: the choice lasts the session. */
      }
      return next;
    });
  }

  async function take(kind) {
    if (picked.length === 0) return;
    setBusy(kind);
    try {
      const list = typeof rows === 'function' ? await rows() : rows;
      const body = {
        name: filename,
        title,
        subtitle,
        columns: picked.map((c) => ({ label: c.label, align: c.align || 'left' })),
        rows: list.map((row) => picked.map((c) => c.get(row))),
      };
      const res = await api.post(`/exports/${kind}`, body, { responseType: 'blob' });
      const name =
        decodeURIComponent(/filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || '') ||
        `${filename}.${kind}`;
      const url = URL.createObjectURL(new Blob([res.data], { type: res.headers['content-type'] }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      if (kind === 'pdf' && res.headers['x-unsupported-text'] === '1') {
        toast('Some names use letters the PDF cannot draw and came out as "?" — the Excel file keeps them.', 'error');
      } else {
        toast(`${list.length} ${list.length === 1 ? 'row' : 'rows'} exported`);
      }
      onClose();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not make the file', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;

  const count = typeof rows === 'function' ? null : rows.length;

  return (
    <Modal open onClose={onClose} title={`Export ${title.toLowerCase()}`} subtitle={subtitle || undefined}>
      <p className="mb-3 text-sm text-slate-600">
        {count === null ? 'Everything the current search and filters show' : `${count} ${count === 1 ? 'row' : 'rows'} as shown now`}
        . Tick the columns to include.
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3" data-export-columns>
        {columns.map((c) => (
          <label key={c.key} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={chosen.has(c.key)}
              onChange={() => toggle(c.key)}
              className="h-4 w-4 rounded accent-brand-600"
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex gap-3 text-xs">
        <button type="button" className="text-brand-700 hover:underline" onClick={() => setChosen(new Set(columns.map((c) => c.key)))}>
          All columns
        </button>
        <button type="button" className="text-slate-500 hover:underline" onClick={() => setChosen(remembered(null, columns))}>
          The usual ones
        </button>
      </div>
      <ModalActions>
        <Button type="button" variant="secondary" onClick={onClose} disabled={!!busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="flex-1"
          loading={busy === 'pdf'}
          disabled={picked.length === 0 || !!busy}
          onClick={() => take('pdf')}
        >
          <FileText size={16} /> PDF
        </Button>
        <Button
          type="button"
          className="flex-1"
          loading={busy === 'xlsx'}
          disabled={picked.length === 0 || !!busy}
          onClick={() => take('xlsx')}
        >
          <FileSpreadsheet size={16} /> Excel
        </Button>
      </ModalActions>
    </Modal>
  );
}

/** The columns ticked last time, or the list's own defaults. */
function remembered(storageKey, columns) {
  if (storageKey) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (Array.isArray(saved) && saved.length) {
        const known = new Set(columns.map((c) => c.key));
        const kept = saved.filter((k) => known.has(k));
        if (kept.length) return new Set(kept);
      }
    } catch {
      /* Nothing remembered, or nothing readable. */
    }
  }
  return new Set(columns.filter((c) => c.default !== false).map((c) => c.key));
}
