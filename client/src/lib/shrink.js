/**
 * Redraw a picture smaller before it goes anywhere.
 *
 * Done in the browser rather than on the server because the alternative is
 * uploading four megabytes over a Lebanese connection while somebody waits at
 * the counter, and because the server has no image library — this repo has no
 * dependencies doing that kind of work and adding one for a resize is a poor
 * trade.
 *
 * Always re-encoded as JPEG: a photograph is what this is, and a 12-megapixel
 * PNG straight off a scanner is several times the size for no benefit.
 *
 * `maxEdge` is the caller's, because how small is small enough depends on what
 * the picture is for — the numbers on an ID have to stay readable, while a card
 * shown at thumbnail size never needs more than a few hundred pixels.
 */
export function shrink(file, { maxEdge = 1400, quality = 0.75 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image'));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
