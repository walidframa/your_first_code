import { useCallback, useEffect, useRef, useState } from 'react';
import { buzzGood } from '../lib/native';
import { isNative } from '../lib/server';
import { ScanLine, X } from 'lucide-react';
import { Button, Modal } from './ui';
import { decodeImage } from '../lib/barcodeRead';

/**
 * Read a barcode off a product with the camera.
 *
 * A counter has a USB scanner; a phone walking the shelves does not, and
 * neither does the owner checking stock at home. Typing a thirteen-digit EAN
 * off a box is slow and gets one digit wrong often enough to matter, which
 * shows up as "we do not stock that" for something sitting on the shelf.
 *
 * Decoded by the browser where it can. `BarcodeDetector` is built into
 * Chromium — Android Chrome, Edge, and the machine on the counter — and is one
 * call.
 *
 * Safari does not have it, and that used to mean no button at all: the phone in
 * the owner's pocket, the one device always with them while they walk the
 * shelves, was the only one that could not scan. So where the browser will not
 * decode, the app does it itself — see lib/barcodeRead.js, which reads the four
 * symbologies this shop's labels and shelves actually carry.
 */
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];

/**
 * Whether scanning is possible here at all.
 *
 * Which now means a camera and nothing else: decoding is no longer the
 * browser's to refuse. `mediaDevices` is missing on plain http, so a shop
 * running this over an insecure connection still gets no button rather than
 * one that opens a permission prompt the browser will never grant.
 */
export function canScan() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export default function BarcodeScanner({ onCancel, onScanned }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  // Kept between frames: the canvas we draw on, and the last code read, which
  // has to be read again before it is believed.
  const canvasRef = useRef(null);
  const lastRef = useRef(null);
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
        'This browser will not open the camera. Type the number instead, or use the scanner on the till.',
      );
      return undefined;
    }

    let live = true;

    /*
     * One question — "what is in this frame?" — answered by whichever of the
     * two can. The browser's own decoder is faster and knows more symbologies,
     * so it is asked first; ours reads the frame off a canvas, which is the
     * only way to get at the pixels Safari will not decode for us.
     */
    const detector =
      typeof globalThis.BarcodeDetector === 'function'
        ? new globalThis.BarcodeDetector({ formats: FORMATS })
        : null;

    const read = async (video) => {
      if (detector) {
        const [hit] = await detector.detect(video);
        return hit?.rawValue || null;
      }

      const canvas = (canvasRef.current ||= document.createElement('canvas'));
      /*
       * Downscaled, and deliberately: a 1280-wide frame is four times the work
       * of a 640-wide one and no easier to read — a barcode that cannot be
       * decoded at 640 is out of focus, not short of pixels.
       */
      const width = Math.min(video.videoWidth || 640, 640);
      const height = Math.round(((video.videoHeight || 480) * width) / (video.videoWidth || 640));
      if (!width || !height) return null;
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(video, 0, 0, width, height);
      return decodeImage(context.getImageData(0, 0, width, height));
    };

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
            const value = await read(videoRef.current);
            if (!value) return;

            /*
             * Twice, agreeing, before it counts.
             *
             * Every symbology here carries its own check digit, so a misread is
             * already unlikely — but the cost of being wrong is the wrong
             * product on somebody's sale, and a second frame costs a fifth of a
             * second.
             */
            if (lastRef.current !== value) {
              lastRef.current = value;
              return;
            }

            clearInterval(timerRef.current);
            timerRef.current = null;
            /*
             * A scan that read, felt rather than only seen.
             *
             * The one moment in this app where a phone can do what a real
             * scanner's beep does — tell somebody the code went in while they
             * are still looking at the shelf rather than at the screen.
             */
            buzzGood();
            setFound(value);
            // Long enough to read the number, short enough not to be a wait.
            setTimeout(() => onScanned(value), 350);
          } catch {
            /* A frame that will not decode is the normal case, not an error. */
          }
        }, 200);
      } catch (err) {
        /*
         * The same failure, told two different ways.
         *
         * "Allow it for this site" is advice about a browser, and inside the
         * installed app there is no site and no address bar to find the setting
         * on — sending somebody there is sending them nowhere. In the app the
         * permission lives in the phone's own Settings, under the app's name.
         */
        const reason =
          err?.name === 'NotAllowedError'
            ? isNative()
              ? 'Front Desk does not have permission to use the camera. Turn it on in the phone’s Settings, under Front Desk.'
              : 'This browser is blocking the camera. Allow it for this site and try again.'
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
