import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, RotateCcw, X } from 'lucide-react';
import { Button, Modal, ModalActions } from './ui';

/**
 * Take a photograph with the camera on this machine.
 *
 * The counter machine is usually a desktop with a webcam clipped to the
 * monitor, and on a desktop the file input's `capture` attribute does nothing
 * at all — it is a phone feature. So the shop's choice was a file picker
 * pointing at photos they had to get onto the machine some other way, which in
 * practice meant the ID never got photographed.
 *
 * The stream is stopped on every exit — taking the shot, cancelling, the dialog
 * unmounting. A camera light left on after somebody's identity document has
 * been photographed is not a small thing to get wrong.
 */
export default function CameraCapture({ onCancel, onTaken }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  // The shot, held for a look before it is kept — an ID photographed at an
  // angle nobody can read is worse than none, because it looks done.
  const [shot, setShot] = useState(null);

  const stop = useCallback(() => {
    for (const track of streamRef.current?.getTracks() || []) track.stop();
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setError('');
    setShot(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // The back camera on anything that has two; ignored on a webcam, which
        // only has the one.
        video: { facingMode: 'environment', width: { ideal: 1920 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setReady(true);
    } catch (err) {
      /*
       * Named rather than "could not open the camera", because the three causes
       * need three different things from the person reading it: allow it, plug
       * one in, or close whatever else is using it.
       */
      const reason =
        err?.name === 'NotAllowedError'
          ? 'This browser is blocking the camera. Allow it for this site and try again.'
          : err?.name === 'NotFoundError'
            ? 'No camera on this machine. Use “Upload a photo” instead.'
            : err?.name === 'NotReadableError'
              ? 'Something else is using the camera. Close it and try again.'
              : 'The camera could not be opened. Use “Upload a photo” instead.';
      setError(reason);
    }
  }, []);

  useEffect(() => {
    start();
    return stop;
  }, [start, stop]);

  function take() {
    const video = videoRef.current;
    if (!video?.videoWidth) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    // Already the right side of a resize: the frame is whatever the camera
    // gives, and an ID has to stay readable, so this matches what `shrink`
    // does for an uploaded file.
    setShot(canvas.toDataURL('image/jpeg', 0.75));
    stop();
  }

  return (
    <Modal open onClose={onCancel} title="Photograph the ID" size="lg">
      <div className="overflow-hidden rounded-xl bg-slate-900">
        {shot ? (
          <img src={shot} alt="The photograph just taken" className="max-h-[52vh] w-full object-contain" />
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            className="max-h-[52vh] w-full object-contain"
            aria-label="What the camera is looking at"
          />
        )}
      </div>

      {error ? (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : (
        <p className="mt-3 text-xs text-slate-500">
          Fill the frame with the card and hold it still. Check you can read the numbers before
          keeping it.
        </p>
      )}

      <ModalActions>
        <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
          <X size={15} /> Cancel
        </Button>
        {shot ? (
          <>
            <Button type="button" variant="secondary" onClick={start}>
              <RotateCcw size={15} /> Again
            </Button>
            <Button type="button" className="flex-1" onClick={() => onTaken(shot)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button type="button" className="flex-1" disabled={!ready || Boolean(error)} onClick={take}>
            <Camera size={15} /> Take the photo
          </Button>
        )}
      </ModalActions>
    </Modal>
  );
}
