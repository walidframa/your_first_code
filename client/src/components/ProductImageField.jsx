import { useRef, useState } from 'react';
import { ImageUp, X } from 'lucide-react';
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
 */
export default function ProductImageField({ value, onChange, className }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => fileRef.current?.click()} loading={busy}>
              <ImageUp size={14} /> {value ? 'Choose another' : 'Choose a file'}
            </Button>
            {isUpload && (
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange('')}>
                Use a link instead
              </Button>
            )}
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      </div>

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
