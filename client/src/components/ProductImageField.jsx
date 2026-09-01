import { useRef, useState } from 'react';
import { ImageUp, Search, X } from 'lucide-react';
import api from '../api';
import { shrink } from '../lib/shrink';
import { Button, Input } from './ui';

/**
 * A picture for a product, from wherever the picture actually is.
 *
 * A URL was the only way, which assumes the shop already has the photograph on
 * the internet somewhere. For a phone shop it is on the computer at the
 * counter — a photo of the actual second-hand handset on the actual shelf,
 * taken on somebody's phone and copied across. Typing a URL for that means
 * first finding somewhere to host it, which is a project, so the field stayed
 * empty and the grid stayed grey.
 *
 * So: paste a link, or choose a file. Both end up in the same column, because
 * a chosen file is shrunk and stored as a data URI rather than uploaded — this
 * app has no file store, and adding one for product thumbnails would mean a
 * second thing to back up beside the database that already holds everything.
 *
 * 600 pixels and quality 0.7, which is about 30–60 KB. Enough for a tile on a
 * touch screen and for the printed label, small enough that a hundred of them
 * do not make the catalogue slow to load — every one of these travels with the
 * product list on every register that opens.
 *
 * And a third way, for when both of the others answer badly: go and look. A
 * shop typing in a catalogue has neither a URL nor a photograph of a phone case
 * it has not unpacked yet, and what it does have is the name. So the name is
 * the query, the server does the fetching, and what comes back lands in the
 * same column as the other two — see server/src/lib/productPhotos.js. Offered
 * as a row of candidates rather than applied straight off, because a name is a
 * weak search and the shop is the one who can tell.
 */
export default function ProductImageField({ value, source, onChange, name = '', className }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /* `null` is "not looking"; an array is the answer, empty included. */
  const [candidates, setCandidates] = useState(null);
  const [query, setQuery] = useState('');
  const [looking, setLooking] = useState(false);
  const [taking, setTaking] = useState('');

  async function look(term) {
    const wanted = String(term ?? query ?? '').trim() || name.trim();
    if (!wanted) {
      setError('Give the product a name first, and this can search for it.');
      return;
    }

    setQuery(wanted);
    setError('');
    setLooking(true);
    try {
      const { data } = await api.get('/products/photos/search', { params: { q: wanted } });
      setCandidates(data.candidates);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not look for pictures just now.');
    } finally {
      setLooking(false);
    }
  }

  /*
   * The picture is fetched by the server, not by this browser.
   *
   * What the row is showing is a link to somebody else's site; what the product
   * column holds is the picture itself. The server is where the size ceiling
   * and the rules about what may be fetched at all live, so it is the one that
   * goes and gets it.
   */
  async function take(candidate) {
    setTaking(candidate.url);
    setError('');
    try {
      const { data } = await api.post('/products/photos/fetch', candidate);
      onChange(data.image_url, data.image_source);
      setCandidates(null);
    } catch (err) {
      setError(err.response?.data?.error || 'That one could not be used — try another.');
    } finally {
      setTaking('');
    }
  }

  async function choose(event) {
    const file = event.target.files?.[0];
    // Cleared immediately so choosing the same file twice in a row still fires.
    event.target.value = '';
    if (!file) return;

    setError('');
    if (!file.type.startsWith('image/')) {
      return setError('That is not a picture.');
    }

    setBusy(true);
    try {
      onChange(await shrink(file, { maxEdge: 600, quality: 0.7 }));
    } catch (err) {
      setError(err.message || 'That picture could not be read.');
    } finally {
      setBusy(false);
    }
  }

  // A data URI is a chosen file; anything else is a link somebody pasted. The
  // difference decides what the text box is allowed to show, because putting
  // forty thousand characters of base64 in an input is unreadable and
  // unscrollable.
  const isUpload = typeof value === 'string' && value.startsWith('data:');

  return (
    <div className={className}>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">Picture</span>

      <div className="flex items-start gap-3">
        {value ? (
          <div className="relative shrink-0">
            <img
              src={value}
              alt=""
              className="h-20 w-20 rounded-xl object-cover ring-1 ring-slate-200"
              // A pasted link that does not resolve should not leave a broken
              // image icon sitting in the form pretending to be a picture.
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
            <button
              type="button"
              onClick={() => onChange('')}
              className="absolute -top-1.5 -right-1.5 rounded-full bg-slate-900 p-1 text-white shadow hover:bg-slate-700"
              aria-label="Remove the picture"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-300 ring-1 ring-slate-200 ring-inset">
            <ImageUp size={22} />
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-2">
          {isUpload ? (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              A picture from this computer, stored with the product.
            </p>
          ) : (
            <Input
              value={value || ''}
              onChange={(e) => onChange(e.target.value)}
              placeholder="https://…"
              aria-label="Picture address"
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => fileRef.current?.click()} loading={busy}>
              <ImageUp size={14} /> {value ? 'Choose another' : 'Choose a file'}
            </Button>
            <Button type="button" size="sm" variant="secondary" loading={looking} onClick={() => look()}>
              <Search size={14} /> Find one
            </Button>
            {isUpload && (
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange('')}>
                Use a link instead
              </Button>
            )}
          </div>

          {/* Where a found one came from — which a Creative Commons licence asks
              the shop to keep beside it, and which answers "where did this come
              from?" about the one that turns out to be wrong. */}
          {source && candidates === null && (
            <p className="truncate text-xs text-slate-400" title={source}>
              {source}
            </p>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      </div>

      {candidates !== null && (
        <div className="mt-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <div className="flex items-end gap-2">
            <Input
              label="Looking for"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              /* Enter searches again, and must never submit the half-filled
                 product behind this. */
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  look(e.target.value);
                }
                if (e.key === 'Escape') setCandidates(null);
              }}
            />
            <Button type="button" size="sm" className="mb-0.5" loading={looking} onClick={() => look()}>
              Search
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mb-0.5"
              onClick={() => setCandidates(null)}
            >
              Cancel
            </Button>
          </div>

          {candidates.length === 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              The picture libraries had nothing for that. Try fewer words, or the brand and model on
              their own.
            </p>
          ) : (
            <>
              <ul className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {candidates.map((c) => (
                  <li key={c.url} className="shrink-0">
                    <button
                      type="button"
                      onClick={() => take(c)}
                      disabled={Boolean(taking)}
                      title={[c.title, c.provider, c.licence].filter(Boolean).join(' · ')}
                      className={candidateTile(taking === c.url)}
                    >
                      <img src={c.url} alt={c.title || ''} className="h-full w-full object-cover" />
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                Matched on the name alone, so look before picking one. Where it came from is kept on
                the product.
              </p>
            </>
          )}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={choose}
        className="hidden"
        // `capture` is deliberately absent: on a phone this then offers the
        // camera as well as the gallery, which is what somebody photographing
        // a handset on the shelf actually wants.
      />
    </div>
  );
}

/** A candidate's tile, ringed while the server is fetching that one. */
function candidateTile(active) {
  return [
    'h-20 w-20 overflow-hidden rounded-xl bg-white ring-1 transition',
    'hover:ring-2 hover:ring-brand-600 disabled:opacity-50',
    active ? 'ring-2 ring-brand-600' : 'ring-slate-200',
  ].join(' ');
}
