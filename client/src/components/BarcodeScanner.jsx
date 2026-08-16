import { useCallback, useEffect, useRef, useState } from 'react';
import { ScanLine, X } from 'lucide-react';
import { Button, Modal } from './ui';

/**
 * Read a barcode off a product with the camera.
 *
 * A counter has a USB scanner; a phone walking the shelves does not, and
 * neither does the owner checking stock at home. Typing a thirteen-digit EAN
 * off a box is slow and gets one digit wrong often enough to matter, which
 * shows up as "we do not stock that" for something sitting on the shelf.
 *
 * Decoded by the browser rather than by a library. `BarcodeDetector` is built
 * into Chromium — which is Android Chrome, Edge and the desktop the shop runs
 * on — and pulling in a decoder would add a large dependency to an app that
 * has deliberately written its own spreadsheet reader and its own PDF writer
 * rather than take one. Where it is missing, mostly Safari and Firefox, the
 * dialog says so plainly instead of showing a camera that will never find
 * anything: a scanner that silently does nothing is worse than no scanner,
 * because somebody will stand there holding a box up to it.
 */
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];

/** Whether this browser can decode at all, asked once rather than per render. */
export function canScan() {
  return typeof globalThis.BarcodeDetector === 'function';
}

export default function BarcodeScanner({ onCancel, onScanned }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  // What was read last, held for a beat so the shop sees the number that was
  // taken rather than a dialog that vanishes.
  const [found, setFound] = useState('');

  const stop = useCallback(() => {
    clearInterval(timerRef.current);
    timerRef.current = null;
    for (const track of streamRef.current?.getTracks() || []) track.stop();
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!canScan()) {
      setError(
        'This browser cannot read barcodes with the camera. Chrome on Android or on the counter machine can — otherwise type the number, or use the scanner on the till.',
      );
      return undefined;
    }

    let live = true;
    const detector = new globalThis.BarcodeDetector({ formats: FORMATS });

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // The back camera on a phone; ignored by a webcam, which has one.
          video: { facingMode: 'environment', width: { ideal: 1280 } },
          audio: false,
        });
        if (!live) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);

        /*
         * Polled rather than run every frame. A barcode does not appear and
         * vanish inside 200ms, and decoding sixty times a second on a cheap
         * phone heats it up and drains it for nothing.
         */
        timerRef.current = setInterval(async () => {
          if (!videoRef.current || videoRef.current.readyState < 2) return;
          try {
            const [hit] = await detector.detect(videoRef.current);
            if (!hit?.rawValue) return;
            clearInterval(timerRef.current);
            timerRef.current = null;
            setFound(hit.rawValue);
            // Long enough to read the number, short enough not to be a wait.
            setTimeout(() => onScanned(hit.rawValue), 350);
          } catch {
            /* A frame that will not decode is the normal case, not an error. */
          }
        }, 200);
      } catch (err) {
        const reason =
          err?.name === 'NotAllowedError'
            ? 'This browser is blocking the camera. Allow it for this site and try again.'
            : err?.name === 'NotFoundError'
              ? 'No camera on this machine — type the number instead.'
              : err?.name === 'NotReadableError'
                ? 'Something else is using the camera. Close it and try again.'
                : 'The camera could not be opened — type the number instead.';
        setError(reason);
      }
    })();

    return () => {
      live = false;
      stop();
    };
  }, [onScanned, stop]);

  return (
    <Modal
      open
      onClose={onCancel}
      size="sm"
      title="Scan a barcode"
      subtitle={found ? `Read ${found}` : 'Hold the barcode inside the frame'}
    >
      {error ? (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">{error}</div>
      ) : (
        <div className="relative overflow-hidden rounded-xl bg-slate-900">
          {/* `playsInline` or an iPhone takes the video full-screen and the
              framing guide below stops meaning anything. */}
          <video
            ref={videoRef}
            playsInline
            muted
            aria-label="Camera looking for a barcode"
            className="h-56 w-full object-cover"
          />

          {/*
            * Something to aim with. A barcode read at any angle works, but a
            * person given no frame holds the box too close, which is the one
            * thing that stops it decoding.
            */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div
              className={`h-20 w-4/5 rounded-lg border-2 transition ${
                found ? 'border-emerald-400' : 'border-white/70'
              }`}
            />
          </div>

          {!ready && (
            <p className="absolute inset-x-0 bottom-3 text-center text-xs text-white/80">
              Opening the camera…
            </p>
          )}
          {found && (
            <p className="absolute inset-x-0 bottom-3 text-center text-sm font-semibold text-emerald-300">
              {found}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onCancel}>
          <X size={15} /> Close
        </Button>
      </div>
    </Modal>
  );
}

/** The button that opens it, so every search field asks the same way. */
export function ScanButton({ onClick, label = 'Scan a barcode with the camera', className }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={
        className ||
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700'
      }
    >
      <ScanLine size={18} />
    </button>
  );
}
