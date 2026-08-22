import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, LifeBuoy } from 'lucide-react';
import api from '../api';
import { Card, Skeleton } from './ui';
import { useT } from '../context/LanguageContext';
import { when } from '../lib/when';

/** `POST /api/products/12` reads better to a shopkeeper as "Changed products". */
function readable(change) {
  const parts = change.path.replace(/^\/api\//, '').split('/');
  const area = (parts[0] || '').replace(/-/g, ' ');
  const verb = { POST: 'Added to', PUT: 'Changed', PATCH: 'Changed', DELETE: 'Removed from' }[
    change.method
  ];
  // A refused attempt is part of the record too — arguably the more interesting
  // part, and a log that quietly dropped it would be the vendor's account of
  // the visit rather than the shop's.
  const refused = change.status >= 400 ? ' (refused)' : '';
  return `${verb || change.method} ${area}${refused}`;
}

function Visit({ visit }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <li className="border-t border-slate-100 py-2 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-start gap-2 text-left"
      >
        <Chevron size={16} className="mt-0.5 shrink-0 text-slate-400" />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-slate-900">{visit.operator}</span>
          <span className="text-slate-500"> — {when(visit.started_at)}</span>
          {visit.reason && <span className="block text-sm text-slate-600">{visit.reason}</span>}
        </span>
        <span className="shrink-0 text-sm text-slate-500">
          {visit.changes.length === 1
            ? t('1 change')
            : t('{count} changes', { count: visit.changes.length })}
        </span>
      </button>

      {open && (
        <ul className="mt-2 ms-6 space-y-1 text-sm text-slate-600">
          {visit.changes.length === 0 && <li>{t('They looked, and changed nothing.')}</li>}
          {visit.changes.map((change, at) => (
            <li key={at} className="flex justify-between gap-3">
              <span>{readable(change)}</span>
              <span className="shrink-0 text-slate-400">{when(change.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Who has been into this shop from outside it, and what they did.
 *
 * The shop's copy of the record, on the shop's own screen. A log the vendor
 * held alone would be worth nothing to the shopkeeper it exists to reassure —
 * and worth nothing to the vendor either, since the whole value of it is that
 * somebody else can check.
 */
export default function SupportVisits() {
  const [visits, setVisits] = useState(null);
  const t = useT();

  const load = useCallback(
    () =>
      api
        .get('/support/visits')
        .then((res) => setVisits(res.data.visits))
        .catch(() => setVisits([])),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  // A shop that has never been visited does not need a panel explaining that
  // nobody has visited it.
  if (visits && visits.length === 0) return null;

  return (
    <Card className="p-5">
      <div className="flex items-start gap-2">
        <LifeBuoy size={16} className="mt-0.5 shrink-0 text-violet-600" />
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{t('Support visits')}</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {t('When the people who sold you this app came in, and what they changed')}
          </p>
        </div>
      </div>

      <ul className="mt-4">
        {!visits ? (
          <Skeleton className="h-16" />
        ) : (
          visits.map((visit) => <Visit key={visit.id} visit={visit} />)
        )}
      </ul>
    </Card>
  );
}
