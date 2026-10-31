// The worker's cache of encrypted blob bytes (SPEC §6.3): what the page's reads of tracks fetch, kept in memory so that
// seeking, going back and the next track's start don't wait for the network. It sees only ciphertext: the page reads
// blobs through the SDK as always, and the SDK checks what comes back, wherever from.
//
// A blob is cached as pieces of PIECE_SIZE bytes, partially: what has been fetched is there, and every read adds to it.
// A read takes the pieces it needs from the cache, waits for those already on their way, and fetches the rest in one
// request per stretch, as far as the read goes. That fetch runs to its end even if the read is cancelled, which is
// what reads the current track ahead: <audio> asks for the rest of the track. It stops early where another fetch has
// got to first, and when another track plays (`focus`): reading ahead a track left behind fetches for nothing. At most
// `maxBlobs` blobs and `maxBytes` bytes are kept, the least recently used going first.
//
// A fetch that fails in a way that may pass (no network, 502–504, a body that breaks off or stalls) is made again after
// a pause, from the piece it was at: its readers wait meanwhile, so <audio> stalls rather than fails. The track playing
// keeps trying until another plays; any other blob gives up after the last pause.

export const PIECE_SIZE = 256 * 1024;

/** The pauses before each further attempt of a fetch; the track playing goes on at the last. */
export const RETRY_PAUSES_MS = [500, 1000, 2000, 4000, 8000, 10_000];

/** How long a fetch may go without a byte before it counts as stalled, and is made again. */
export const STALL_MS = 20_000;

/** What may pass: no way through to the server, its storage out of reach, a timeout. */
const PASSING = new Set([502, 503, 504]);

/** One stretch of `Range: bytes=a-b` or `bytes=a-`, as { start, end } (end inclusive, null to the end); null otherwise. */
export function parseBlobRange(header) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? "");
  if (!match) return null;
  const [start, end] = [Number(match[1]), match[2] === "" ? null : Number(match[2])];
  return Number.isSafeInteger(start) && (end === null || (Number.isSafeInteger(end) && end >= start)) ? { start, end } : null;
}

/** `Content-Range: bytes a-b/total` as { start, end, total }; null otherwise. */
export function parseContentRange(header) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header ?? "");
  return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : null;
}

const MiB = 1024 * 1024;

class Gone extends Error {
  constructor(message = "The cache was emptied") {
    super(message);
    this.name = "AbortError";
  }
}

/** A failure that may pass: the fetch is made again. A network error (a TypeError) is one too. */
class Passing extends Error {}

/** Waits `ms`, or rejects with the signal's reason when it is aborted first. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/**
 * The cache. `fetchRange(id, start, end, signal, retry)` fetches bytes [start, end] of blob `id` from the server (a
 * Response); `retry` is how many attempts of the same fetch came before. `pauses` and `stallMs` are for retries; no
 * pauses, none.
 * → { respond(id, rangeHeader) → Response | null, focus(id), forget() }. A null response means the cache can't answer
 * this request (another kind of range, a blob that isn't there, the server saying no): the request goes to the server
 * as it is.
 */
export function makeBlobCache({
  fetchRange,
  pieceSize = PIECE_SIZE,
  maxBlobs = 3,
  maxBytes = 100 * MiB,
  fetchBytes = 32 * MiB,
  pauses = RETRY_PAUSES_MS,
  stallMs = STALL_MS,
}) {
  // id → { size, pieces: Map<index, { bytes, used }>, claims: Map<index, deferred>, fetches: Set<AbortController>, used }
  const blobs = new Map();
  // The blob playing now (`focus`): its fetches keep trying.
  let playing = null;
  let clock = 0;
  const tick = () => ++clock;

  const sizeOfPiece = (blob, index) => Math.min(pieceSize, blob.size - index * pieceSize);
  const owned = (blob, index) => blob.pieces.has(index) || blob.claims.has(index);

  function entry(id) {
    if (!blobs.has(id)) {
      blobs.set(id, { size: null, pieces: new Map(), claims: new Map(), fetches: new Set(), used: tick() });
      while (blobs.size > maxBlobs) drop(leastRecent([...blobs].filter(([other]) => other !== id)));
    }
    const blob = blobs.get(id);
    blob.used = tick();
    return blob;
  }

  const leastRecent = (list) => list.reduce((oldest, item) => (oldest === null || item[1].used < oldest[1].used ? item : oldest), null)?.[0];

  function drop(id) {
    const blob = blobs.get(id);
    if (!blob) return;
    blobs.delete(id);
    blob.fetches.forEach((controller) => controller.abort(new Gone()));
    blob.claims.forEach((claim) => claim.reject(new Gone()));
  }

  /** Keeps the bytes under `maxBytes`, dropping the least recently used pieces, of any blob, but never `keep`. */
  function trim(keep) {
    const all = () => [...blobs.values()].flatMap((blob) => [...blob.pieces].map(([index, piece]) => ({ blob, index, piece })));
    let total = all().reduce((sum, { piece }) => sum + piece.bytes.length, 0);
    const candidates = all()
      .filter(({ piece }) => piece !== keep)
      .sort((a, b) => a.piece.used - b.piece.used);
    for (const { blob, index, piece } of candidates) {
      if (total <= maxBytes) break;
      blob.pieces.delete(index);
      total -= piece.bytes.length;
    }
  }

  function claim(blob, index) {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
    promise.catch(() => {}); // a claim nobody waits for may fail unseen
    const deferred = { promise, resolve, reject };
    blob.claims.set(index, deferred);
    return deferred;
  }

  function store(blob, index, bytes) {
    const piece = { bytes, used: tick() };
    blob.pieces.set(index, piece);
    blob.claims.get(index)?.resolve(bytes);
    blob.claims.delete(index);
    trim(piece);
  }

  /**
   * Fetches pieces [first, last] of `blob` (or up to `fetchBytes` of them), storing each as it completes, and stops
   * early at a piece some other fetch has. Made again from the piece it was at after a failure that may pass. Resolves
   * once the server has answered with the bytes asked for; rejects when it didn't, or the fetch gave up first.
   */
  function fetchPieces(id, blob, first, last) {
    const limit = Math.min(last ?? Infinity, first + Math.floor(fetchBytes / pieceSize) - 1);
    const endByte = () => (blob.size === null ? (limit + 1) * pieceSize : Math.min((limit + 1) * pieceSize, blob.size)) - 1;
    const controller = new AbortController();
    blob.fetches.add(controller);
    // The piece being read, and its claim: what waiting readers get when the fetch fails.
    let currentIndex = first;
    let current = claim(blob, first);
    const fail = (error) => {
      current?.reject(error);
      if (current && blob.claims.get(currentIndex) === current) blob.claims.delete(currentIndex);
      current = null;
    };
    let answer;
    const answered = new Promise((resolve, reject) => (answer = { resolve, reject }));
    answered.catch(() => {});

    /** One request, from piece `currentIndex` to the end or to where another fetch got first; `retry` came before. */
    async function attempt(retry) {
      const startByte = currentIndex * pieceSize;
      const stalled = new AbortController();
      const signal = AbortSignal.any([controller.signal, stalled.signal]);
      let timer;
      const watch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stalled.abort(new Passing(`Blob ${id} stalled`)), stallMs);
      };
      watch();
      try {
        const response = await fetchRange(id, startByte, endByte(), signal, retry);
        if (PASSING.has(response.status)) {
          await response.body?.cancel().catch(() => {});
          throw new Passing(`The server answered ${response.status} for a range of blob ${id}`);
        }
        const range = response.status === 206 ? parseContentRange(response.headers.get("content-range")) : null;
        if (!range || range.start !== startByte || (blob.size !== null && range.total !== blob.size)) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`The server answered ${response.status} for a range of blob ${id}`);
        }
        blob.size = range.total;
        answer.resolve(range);
        const reader = response.body.getReader();
        let buffered = [];
        let length = 0;
        const lastIndex = Math.floor(range.end / pieceSize);
        for (;;) {
          const need = sizeOfPiece(blob, currentIndex);
          while (length < need) {
            const { value, done: ended } = await reader.read();
            if (ended) throw new Passing(`Blob ${id} ended early`);
            watch();
            buffered.push(value);
            length += value.length;
          }
          const joined = join(buffered, length);
          store(blob, currentIndex, joined.subarray(0, need).slice());
          buffered = length > need ? [joined.subarray(need)] : [];
          length -= need;
          current = null;
          const next = currentIndex + 1;
          if (next > lastIndex || owned(blob, next) || !blobs.has(id)) {
            await reader.cancel().catch(() => {});
            return;
          }
          currentIndex = next;
          current = claim(blob, next);
        }
      } catch (error) {
        // A stall shows up as the request's abort, with the stall as its reason.
        throw stalled.signal.aborted && !controller.signal.aborted ? stalled.signal.reason : error;
      } finally {
        clearTimeout(timer);
      }
    }

    const done = (async () => {
      for (let failures = 0; ; failures++) {
        try {
          return await attempt(failures);
        } catch (error) {
          const passing = (error instanceof Passing || error instanceof TypeError) && !controller.signal.aborted;
          const patient = playing === id || failures < pauses.length;
          if (!passing || !patient || pauses.length === 0 || !blobs.has(id)) throw error;
          await pause(pauses[Math.min(failures, pauses.length - 1)], controller.signal);
        }
      }
    })()
      .catch((error) => {
        answer.reject(error);
        fail(error);
      })
      .finally(() => {
        controller.abort();
        blob.fetches.delete(controller);
      });

    return { answered, done };
  }

  /** Piece `index` of `blob`: cached, on its way, or fetched now along with the pieces after it, up to `last`. */
  async function piece(id, blob, index, last) {
    const cached = blob.pieces.get(index);
    if (cached) {
      cached.used = tick();
      return cached.bytes;
    }
    if (!blob.claims.has(index)) fetchPieces(id, blob, index, last);
    return blob.claims.get(index).promise;
  }

  async function respond(id, rangeHeader) {
    const range = parseBlobRange(rangeHeader);
    if (!range) return null;
    const blob = entry(id);
    const first = Math.floor(range.start / pieceSize);
    if (blob.size === null) {
      // The size comes with the first answer, and the response needs it.
      const last = range.end === null ? null : Math.floor(range.end / pieceSize);
      if (!owned(blob, first)) {
        const { answered } = fetchPieces(id, blob, first, last);
        if (!(await answered.then(() => true, () => false))) return null;
      } else {
        await blob.claims.get(first)?.promise.catch(() => {});
      }
      if (blob.size === null) return null;
    }
    if (range.start >= blob.size) return null;
    const end = Math.min(range.end ?? blob.size - 1, blob.size - 1);
    const last = Math.floor(end / pieceSize);
    let index = first;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const bytes = await piece(id, blob, index, last);
          const offset = index * pieceSize;
          controller.enqueue(bytes.subarray(Math.max(0, range.start - offset), Math.min(bytes.length, end + 1 - offset)));
          index += 1;
          if (index > last) controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes ${range.start}-${end}/${blob.size}`,
        "Content-Length": String(end + 1 - range.start),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  }

  const forget = () => [...blobs.keys()].forEach(drop);

  /**
   * Blob `id` is the one playing now (null: none is): every other blob's fetches stop, as reading those ahead is for
   * nothing. What they fetched stays, for going back; a read of the rest fetches it again.
   */
  const focus = (id) => {
    playing = id;
    blobs.forEach((blob, other) => {
      if (other !== id) blob.fetches.forEach((controller) => controller.abort(new Gone("Another track plays")));
    });
  };

  /** What is cached, for tests: { id: { size, pieces: [index…] } }. */
  const contents = () => Object.fromEntries([...blobs].map(([id, blob]) => [id, { size: blob.size, pieces: [...blob.pieces.keys()].sort((a, b) => a - b) }]));

  return { respond, focus, forget, contents };
}

function join(parts, length) {
  if (parts.length === 1) return parts[0];
  const joined = new Uint8Array(length);
  parts.reduce((at, part) => (joined.set(part, at), at + part.length), 0);
  return joined;
}
