import { useRef, useState } from 'react';
import { Camera, ImageUp, Trash2 } from 'lucide-react';
import { Button } from './ui';
import CameraCapture from './CameraCapture';
import { shrink } from '../lib/shrink';

/**
 * Photograph the seller's ID at the counter.
 *
 * Two ways in, because the counter machine decides which one is possible.
 *
 * The file input's `capture` attribute is a phone feature; on the desktop most
 * shops actually use it does nothing, so the only route was a file picker
 * pointing at photos that had to reach the machine some other way — which in
 * practice meant the ID never got photographed at all. **Use the camera** opens
 * whatever the machine has, webcam included. **Upload a photo** is for a
 * scanner, a phone that already took it, or a shop that keeps them on file.
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
  const [cameraOpen, setCameraOpen] = useState(false);

  async function pick(e) {
    const file = e.target.files?.[0];
    // Let the same file be chosen again after a removal — without this, the
    // input holds the old value and the change event never fires.
    e.target.value = '';
    if (!file) return;

    setError('');
    setBusy(true);
    try {
      onChange(await shrink(file, { maxEdge: 1400 }));
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
            {/*
              * Both offered up front rather than hidden behind one button and a
              * menu. There are exactly two, the right one depends on what is
              * plugged into the machine, and a cashier should not have to open
              * something to find that out.
              */}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => setCameraOpen(true)}
            >
              <Camera size={14} /> {value ? 'Retake' : 'Use the camera'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              loading={busy}
              disabled={disabled}
              onClick={() => fileRef.current?.click()}
            >
              <ImageUp size={14} /> Upload a photo
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
            onChange={pick}
            className="hidden"
            aria-label="Upload a photo of the seller’s ID"
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

      {cameraOpen && (
        <CameraCapture
          onCancel={() => setCameraOpen(false)}
          onTaken={(photo) => {
            onChange(photo);
            setCameraOpen(false);
          }}
        />
      )}
    </div>
  );
}
