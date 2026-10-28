// Saving a file to the device (SPEC §7.1): read whole and decrypted here, as everything is, into a Blob, which the
// browser keeps out of the page's memory (on disk when it is large), then offered to the browser as a download. In
// the Android app, whose WebView can't save a blob: URL itself, the app's download bridge takes the same link.

import { IntegrityError } from "../sdk/api.js";

/** `stream`, passed through, telling `onProgress` how many bytes have gone by. */
export function counted(stream, onProgress) {
  let bytes = 0;
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        onProgress(bytes);
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * A file read whole, as a Blob of MIME type `type`. `opened` is the read's { size, stream }, whose size must be `size`:
 * the entry's. `onProgress(bytes)` hears how much has been read.
 */
export async function readWhole(opened, { size, type, onProgress = () => {} }) {
  if (opened.size !== size) {
    await opened.stream.cancel();
    throw new IntegrityError(`a file of ${opened.size} bytes where its entry says ${size}`);
  }
  return new Response(counted(opened.stream, onProgress), { headers: { "Content-Type": type } }).blob();
}

/** How long a download's blob: URL is kept: a browser may read it only once the click is done. */
const KEEP_URL_MS = 60 * 1000;

/** Offers `blob` to the browser as a download called `name`. */
export function offer(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), KEEP_URL_MS);
}
