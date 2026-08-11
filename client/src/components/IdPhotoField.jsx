import { useRef, useState } from 'react';
import { Camera, ImageUp, Trash2 } from 'lucide-react';
import { Button } from './ui';

/*
 * What the server will take, and roughly what an ID card needs to be readable.
 * A phone camera produces something like 4000px and 4MB; at 1400px the numbers
 * on a card are still legible and the file is a couple of hundred kilobytes,
 * which is the difference between a shop's backup staying small and not.
 */
const MAX_EDGE = 1400;
const QUALITY = 0.75;

/**
 * Redraw the picture smaller before it goes anywhere.
 *
 * Done here rather than on the server because the alternative is uploading four
 * megabytes over a Lebanese connection while somebody waits at the counter, and
 * because the server has no image library — this repo has no dependencies doing
 * that kind of work and adding one for a resize is a poor trade.
 *
 * Always re-encoded as JPEG: a photograph is what this is, and a 12-megapixel
 * PNG straight off a scanner is several times the size for no benefit.
 */
function shrink(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image'));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', QUALITY));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Photograph the seller's ID at the counter.
 *
 * `capture` on the file input means a tablet or a phone opens the camera
 * straight away rather than a file browser, which is how this is actually used:
 * the seller is standing there holding the card. On a desktop the attribute is
 * ignored and it behaves as an ordinary file picker, for a shop with a scanner
 * or a photo already taken.
 *
 * The value is a `data:` URI held in the parent's form state, so the photo goes
 * up with the purchase in one request. Nothing is stored until the purchase is
 * saved — backing out of the dialog leaves nothing behind, which is the right
 * behaviour for somebody's identity document.
 */
export default function IdPhotoField({ value, onChange, disabled = false }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function pick(e) {
    const file = e.target.files?.[0];
    // Let the same file be chosen again after a removal — without this, the
    // input holds the old value and the change event never fires.
    e.target.value = '';
    if (!file) return;

    setError('');
    setBusy(true);
    try {
      onChange(await shrink(file));
    } catch (err) {
      setError(err.message || 'That image could not be used');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">Seller’s ID</span>

      <div className="flex items-start gap-3">
        {value ? (
          <img
            src={value}
            alt="The seller’s ID"
            className="h-20 w-32 shrink-0 rounded-lg object-cover ring-1 ring-slate-200"
          />
        ) : (
          <div className="flex h-20 w-32 shrink-0 items-center justify-center rounded-lg text-xs text-slate-400 ring-1 ring-dashed ring-slate-300">
            no photo
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              loading={busy}
              disabled={disabled}
              onClick={() => fileRef.current?.click()}
            >
              {value ? <ImageUp size={14} /> : <Camera size={14} />}
              {value ? 'Retake' : 'Photograph the ID'}
            </Button>
            {value && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() => onChange(null)}
              >
                <Trash2 size={14} /> Remove
              </Button>
            )}
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={pick}
            className="hidden"
            aria-label="Photograph the seller’s ID"
          />

          {error ? (
            <p className="mt-1.5 text-xs text-red-600">{error}</p>
          ) : (
            /*
             * Said plainly. Asking for somebody's ID is a real thing to ask of
             * them, and both sides of it are worth being honest about: why the
             * shop wants it, and that it is not left lying around afterwards.
             */
            <p className="mt-1.5 text-xs leading-snug text-slate-500">
              Proof of who sold the phone, in case it is ever asked about. Kept with this purchase and
              only openable by whoever may reveal saved passwords.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
