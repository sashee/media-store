// The traffic counters (SPEC §7.1): what goes to and comes from the server, as a rate over the last two seconds, and as
// amounts over the last minute and since the app started. Plain functions of data: the samples are { at, down, up },
// `at` in milliseconds; and `metering`, which wraps `fetch` to feed them. The worker reports its own reads.

import { formatBytes } from "../sdk/maintenance.js";

/** The window the rate is averaged over. */
export const WINDOW_MS = 2000;

/** The window the recent amounts are summed over. */
export const MINUTE_MS = 60 * 1000;

/** The samples still in the window of `window` milliseconds ending at `now`. */
export const recent = (samples, now, window = WINDOW_MS) => samples.filter(({ at }) => at > now - window);

/** Bytes received per second over the rate's window ending at `now`. */
export const rate = (samples, now) => recent(samples, now).reduce((sum, { down }) => sum + down, 0) / (WINDOW_MS / 1000);

/** What the samples add up to: { down, up }. */
export const total = (samples) => samples.reduce((sum, { down, up }) => ({ down: sum.down + down, up: sum.up + up }), { down: 0, up: 0 });

/** `amounts` ({ down, up }) with the samples' added. */
export const plus = (amounts, samples) => {
  const more = total(samples);
  return { down: amounts.down + more.down, up: amounts.up + more.up };
};

/** "↓ 1.2 MB/s" */
export const formatRate = (bytesPerSecond) => `↓ ${formatBytes(Math.round(bytesPerSecond))}/s`;

const amounts = ({ down, up }) => `↓ ${formatBytes(down)} ↑ ${formatBytes(up)}`;

/** "Last min ↓ 45.2 MB ↑ 1.2 MB · since start ↓ 320 MB ↑ 8.0 MB": one line on a phone. */
export const formatUsage = ({ minute, started }) => `Last min ${amounts(minute)} · since start ${amounts(started)}`;

/** The size of a request body as it is sent: a string as UTF-8, bytes and Blobs as they are. */
export function bodySize(body) {
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  if (body instanceof Blob) return body.size;
  return Number.isSafeInteger(body?.byteLength) ? body.byteLength : 0;
}

/**
 * Whether the worker answers this fetch, and counts what it costs (sw.js): a ranged read of a blob, which it serves
 * from its cache, or from the server, counting only those bytes. Counted again here, playing would count twice, and
 * the cache's answers as downloads.
 */
export function answeredByWorker(input, init, base) {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input), base);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  return url.origin === new URL(base).origin && method === "GET" && /^\/api\/v1\/blobs\/[0-9a-f]{64}$/.test(url.pathname) && headers.has("range");
}

/**
 * `fetch`, telling `onData({ at, down, up })` what goes up (a request's body, as it is sent) and comes down (a
 * response's body, as it arrives); but not for what the worker answers, which it counts itself (`answeredByWorker`).
 */
export function metering(fetch, { base, now, onData }) {
  return async (input, init) => {
    if (answeredByWorker(input, init, base)) return fetch(input, init);
    const up = bodySize(init?.body);
    if (up > 0) onData({ at: now(), down: 0, up });
    const response = await fetch(input, init);
    if (!response.body) return response;
    const tally = new TransformStream({
      transform(chunk, controller) {
        onData({ at: now(), down: chunk.byteLength, up: 0 });
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(tally), response);
  };
}
