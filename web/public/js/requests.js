// The requests to the server (SPEC §7.1): each one as it goes, and how many a burst of work has sent, so that a slow
// network reads as slow rather than stuck. The page's requests and the worker's (sw.js) are watched alike (`watch`),
// as events, plain data: folded here into what the request counter shows, and into the traffic counter's samples
// (traffic.js), so the two add up.
//
// The events of a request, by its `key`:
// - { type: "sent", key, at, method, path, blob, range, up, retry, label? }: what it asks for (`requestOf`), and the
//   attempts before it;
// - { type: "answered", key, at, status, total, length }: its status, the blob's size from `Content-Range`, and the
//   body's from `Content-Length`;
// - { type: "bytes", key, at, bytes }: some of the body;
// - { type: "ended", key, at, outcome }: "done", "stopped" (read no further), "failed" or "cancelled".

import { formatBytes } from "../sdk/maintenance.js";
import { parseBlobRange, parseContentRange } from "./blob-cache.js";

/** How long a request's line stays after it ends; a pause this long also starts a new count. */
export const LINGER_MS = 3000;

/** A wait shorter than this isn't worth saying. */
const MENTION_WAIT_MS = 2000;

/** The most lines the list of requests takes, "+ n more" included. */
export const MAX_LINES = 6;

const BLOB_PATH = /^\/api\/v1\/blobs\/([0-9a-f]{64})$/;

// ---------------------------------------------------------------- watching requests

/** The size of a request body as it is sent: a string as UTF-8, bytes and Blobs as they are. */
export function bodySize(body) {
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  if (body instanceof Blob) return body.size;
  return Number.isSafeInteger(body?.byteLength) ? body.byteLength : 0;
}

const urlOf = (input, base) => new URL(input instanceof Request ? input.url : String(input), base);

/** Whether a fetch of `input` is a request to the server's API, the ones watched. */
export function isApiRequest(input, base) {
  const url = urlOf(input, base);
  return url.origin === new URL(base).origin && url.pathname.startsWith("/api/");
}

/** What a fetch of `input` with `init` asks for, as its "sent" event says: { method, path, blob, range, up }. */
export function requestOf(input, init, base) {
  const request = input instanceof Request ? input : null;
  const path = urlOf(input, base).pathname;
  const headers = new Headers(init?.headers ?? request?.headers);
  return {
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    path,
    blob: BLOB_PATH.exec(path)?.[1] ?? null,
    range: parseBlobRange(headers.get("range")),
    up: bodySize(init?.body),
  };
}

/**
 * Whether the worker answers this fetch while it controls the page (sw.js): a ranged read of a blob, which it serves
 * from its cache, watching the requests to the server that takes. Watched here too, a read would show twice, and the
 * cache's answers as downloads.
 */
export function answeredByWorker(input, init, base) {
  const request = input instanceof Request ? input : null;
  const url = urlOf(input, base);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  return url.origin === new URL(base).origin && method === "GET" && BLOB_PATH.test(url.pathname) && new Headers(init?.headers ?? request?.headers).has("range");
}

const outcomeOf = (error) => (error?.name === "AbortError" ? "cancelled" : "failed");

/**
 * `fetch(input, init)`, telling `emit` how it goes, as events with `key`; `what` is its "sent" event's content. With
 * `lasting`, a request the server answers with a body lasts until the body is read through, or no further: a blob's
 * bytes, which take a while. Otherwise it ends with its answer, as a body nobody reads would keep it going for ever.
 * The body's bytes are told either way, as they are read.
 */
export async function watch(fetch, input, init, { key, what, lasting, now, emit }) {
  emit({ type: "sent", key, at: now(), ...what });
  const end = (outcome) => emit({ type: "ended", key, at: now(), outcome });
  let response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    end(outcomeOf(error));
    throw error;
  }
  const told = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  const length = Number.isSafeInteger(told) ? told : null;
  const total = parseContentRange(response.headers.get("content-range"))?.total ?? null;
  emit({ type: "answered", key, at: now(), status: response.status, total, length });
  const streaming = lasting && response.ok && response.body !== null;
  if (!streaming) end(response.status >= 500 ? "failed" : "done");
  if (!response.body) return response;

  // Mutable, as the stream's callbacks share it: how much came, and whether the request has ended.
  const reader = response.body.getReader();
  let received = 0;
  let over = !streaming;
  const finish = (outcome) => {
    if (!over) end(outcome);
    over = true;
  };
  const body = new ReadableStream(
    {
      async pull(controller) {
        let next;
        try {
          next = await reader.read();
        } catch (error) {
          finish(outcomeOf(error));
          controller.error(error);
          return;
        }
        if (next.done) {
          finish("done");
          controller.close();
          return;
        }
        received += next.value.byteLength;
        emit({ type: "bytes", key, at: now(), bytes: next.value.byteLength });
        // All of it came: a reader that wants no more needn't read on to the end to say so.
        if (received === length) finish("done");
        controller.enqueue(next.value);
      },
      cancel(reason) {
        finish("stopped");
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, response);
}

/**
 * `fetch`, watching (`watch`) each request to the API, with `emit` told its events; but not what the worker answers
 * while it controls the page (`byWorker()`), which it watches itself.
 */
export function watching(fetch, { base, now, emit, byWorker }) {
  let next = 0;
  return (input, init) => {
    if (!isApiRequest(input, base) || (answeredByWorker(input, init, base) && byWorker())) return fetch(input, init);
    const what = { ...requestOf(input, init, base), retry: 0 };
    return watch(fetch, input, init, { key: `page:${next++}`, what, lasting: what.method === "GET" && what.blob !== null, now, emit });
  };
}

/** `events` with `event` added: bytes go to the last "bytes" event of the request, so a report has one per request. */
export function batched(events, event) {
  const at = event.type === "bytes" ? events.findLastIndex((e) => e.type === "bytes" && e.key === event.key) : -1;
  return at < 0 ? [...events, event] : events.with(at, { ...event, bytes: events[at].bytes + event.bytes });
}

const TYPES = new Set(["sent", "answered", "bytes", "ended"]);

/** Whether `event` is one this module makes: what the worker posts is checked before it counts. */
export const isEvent = (event) =>
  TYPES.has(event?.type) && typeof event.key === "string" && Number.isFinite(event.at) && (event.type !== "bytes" || Number.isSafeInteger(event.bytes));

// ---------------------------------------------------------------- the state

/**
 * Nothing sent yet. `requests` are those under way, and those that ended up to LINGER_MS ago (`prune`); the counts
 * are the burst's, `last` when a request of it was last sent or ended.
 */
export const NONE = { requests: [], sent: 0, done: 0, failed: 0, cancelled: 0, last: -Infinity };

const underWay = (request) => request.outcome === null;

const update = (state, key, change) => ({ ...state, requests: state.requests.map((request) => (request.key === key ? change(request) : request)) });

/** The state once `event` happened. A request sent after a burst ended a while ago starts a new one. */
export function apply(state, event) {
  const request = state.requests.find((r) => r.key === event.key);
  switch (event.type) {
    case "sent": {
      const current = !state.requests.some(underWay) && event.at - state.last > LINGER_MS ? NONE : state;
      const { type: _, at, ...what } = event;
      const added = { label: null, ...what, sentAt: at, status: null, total: null, length: null, bytes: 0, outcome: null, endedAt: null };
      return { ...current, requests: [...current.requests, added], sent: current.sent + 1, last: Math.max(current.last, at) };
    }
    case "answered":
      return request ? update(state, event.key, (r) => ({ ...r, status: event.status, total: event.total, length: event.length })) : state;
    case "bytes":
      return request ? update(state, event.key, (r) => ({ ...r, bytes: r.bytes + event.bytes })) : state;
    case "ended": {
      if (!request || !underWay(request)) return state;
      const counted = event.outcome === "stopped" ? "done" : event.outcome;
      return { ...update(state, event.key, (r) => ({ ...r, outcome: event.outcome, endedAt: event.at })), [counted]: state[counted] + 1, last: Math.max(state.last, event.at) };
    }
    default:
      return state;
  }
}

/** The state without the requests that ended more than LINGER_MS before `now`. */
export const prune = (state, now) => ({ ...state, requests: state.requests.filter((r) => underWay(r) || now - r.endedAt <= LINGER_MS) });

// ---------------------------------------------------------------- what is shown

/** "Requests: 4 of 7 done · 1 loading · 2 waiting, the longest 37 s · 1 failed"; null when there is nothing to show. */
export function describe(state, now) {
  const going = state.requests.filter(underWay);
  if (going.length === 0 && now - state.last > LINGER_MS) return null;
  const waiting = going.filter((r) => r.status === null);
  const longest = waiting.reduce((most, { sentAt }) => Math.max(most, now - sentAt), 0);
  return [
    `Requests: ${state.done} of ${state.sent} done`,
    going.length > waiting.length && `${going.length - waiting.length} loading`,
    waiting.length > 0 && `${waiting.length} waiting${longest >= MENTION_WAIT_MS ? `, the longest ${Math.floor(longest / 1000)} s` : ""}`,
    state.failed > 0 && `${state.failed} failed`,
    state.cancelled > 0 && `${state.cancelled} cancelled`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What a request is, from what it asks for, when the app has no better name for it: "blob 1a2b3c4d", "upload". */
export function kindOf({ method, path, blob }) {
  if (blob && method === "GET") return `blob ${blob.slice(0, 8)}`;
  if (blob && method === "PUT") return "upload";
  const name = path.replace(/^\/api\/v1\//, "");
  return `${method} ${blob ? name.replace(blob, blob.slice(0, 8)) : name}`;
}

const percent = (bytes, total, round) => round((100 * bytes) / total);

/**
 * Which of a blob's bytes a read asks for: "all 8.4 MB", "25–100% of 8.4 MB"; while the blob's size is unknown, by
 * position: "first 512.0 KB", "from 2.0 MB", "2.0 MB–4.0 MB".
 */
export function spanOf({ range, total, length }) {
  const size = total ?? (range === null ? length : null);
  const start = range?.start ?? 0;
  const end = range?.end == null || (size !== null && range.end >= size - 1) ? null : range.end;
  if (start === 0 && end === null) return size === null ? "all" : `all ${formatBytes(size)}`;
  if (size !== null) return `${percent(start, size, Math.floor)}–${end === null ? 100 : percent(end + 1, size, Math.ceil)}% of ${formatBytes(size)}`;
  if (end === null) return `from ${formatBytes(start)}`;
  return start === 0 ? `first ${formatBytes(end + 1)}` : `${formatBytes(start)}–${formatBytes(end + 1)}`;
}

/** "40 ms", "2.3 s", "37 s". */
export const duration = (ms) => (ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 1000)} s`);

const MARKS = { waiting: "⧗", loading: "↓", done: "✓", stopped: "■", failed: "✗", cancelled: "⊘" };

/** How a request goes, or went: "waiting 2.1 s", "3.2 MB of 6.3 MB · 4.0 s", "1.2 MB in 800 ms", "failed (503)". */
function howOf(request, phase, now) {
  const { bytes, length, status, sentAt, endedAt } = request;
  const odd = status !== null && (status < 200 || status > 299) && status;
  switch (phase) {
    case "waiting":
      return `waiting ${duration(now - sentAt)}`;
    case "loading":
      return `${formatBytes(bytes)}${length === null ? "" : ` of ${formatBytes(length)}`} · ${duration(now - sentAt)}`;
    case "done":
      return [bytes > 0 ? `${formatBytes(bytes)} in ${duration(endedAt - sentAt)}` : duration(endedAt - sentAt), odd].filter(Boolean).join(" · ");
    case "stopped":
      return `stopped after ${formatBytes(bytes)}`;
    case "failed":
      return odd ? `failed (${odd})` : "failed";
    default:
      return phase;
  }
}

/**
 * One request's line: { key, phase, mark, label, detail, how }: what it is, which bytes it reads or sends and which
 * attempt it is (null: nothing to say), and how it goes.
 */
export function lineOf(request, now) {
  const phase = request.outcome ?? (request.status === null ? "waiting" : "loading");
  const detail = [request.blob && request.method === "GET" && spanOf(request), request.up > 0 && formatBytes(request.up), request.retry > 0 && `retry ${request.retry}`];
  return { key: request.key, phase, mark: MARKS[phase], label: request.label ?? kindOf(request), detail: detail.filter(Boolean).join(" · ") || null, how: howOf(request, phase, now) };
}

/**
 * The requests to show at `now`, one line each, in the order they were sent: { lines, more }. At most `max` lines,
 * "+ more" included: those under way first, then those that ended last; `more` is how many aren't shown.
 */
export function lines(state, now, max = MAX_LINES) {
  const shown = prune(state, now).requests;
  const room = shown.length > max ? max - 1 : max;
  const picked = new Set([...shown.filter(underWay), ...shown.filter((r) => !underWay(r)).toSorted((a, b) => b.endedAt - a.endedAt)].slice(0, room));
  return { lines: shown.filter((r) => picked.has(r)).map((r) => lineOf(r, now)), more: shown.length - picked.size };
}
