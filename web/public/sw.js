// The Service Worker (SPEC §6): plays tracks, and keeps what was read of them.
//
// - Play URLs (js/library.js), which the <audio> element asks for with Range, are answered by the page that asked:
//   the worker passes the request on and the answer back. The page decrypts; the worker never has the key.
// - The page's ranged reads of blobs, the SDK's reads behind those answers, go through a cache of encrypted bytes
//   (js/blob-cache.js), so seeking, going back and the next track's start don't wait for the network.
//
// Every other request goes to the network as usual.

import { makeBlobCache } from "./js/blob-cache.js";
import { batched, requestOf, watch } from "./js/requests.js";

/**
 * How long a page has to take a play URL on (js/player.js): to say it is working on it, or to answer. Once it has said
 * so, the answer may take as long as the bytes do, e.g. while the cache tries again (js/blob-cache.js).
 */
const ANSWER_TIMEOUT_MS = 10_000;
/** How often the pages hear how this worker's requests to the server go, while some go (the request and traffic counters). */
const REPORT_EVERY_MS = 500;
const BLOB = /^\/api\/v1\/blobs\/([0-9a-f]{64})$/;

// The events of this worker's requests (js/requests.js) the pages haven't heard of yet, and the timer that tells them.
let unreported = [];
let reporting = null;
async function report() {
  reporting = null;
  const events = unreported;
  unreported = [];
  const pages = await self.clients.matchAll({ type: "window" });
  pages.forEach((page) => page.postMessage({ type: "requests", events }));
}
const emit = (event) => {
  unreported = batched(unreported, event);
  reporting ??= setTimeout(report, REPORT_EVERY_MS);
};

// The requests' keys: this worker's own, so those of a worker that takes over don't mix with them.
const worker = crypto.randomUUID().slice(0, 8);
let sent = 0;

/** `fetch(request)`, watched (js/requests.js): the pages hear how it goes. `retry`: the attempts of it before. */
const watched = (request, retry = 0) =>
  watch(fetch, request, undefined, { key: `worker ${worker}:${sent++}`, what: { ...requestOf(request, undefined, self.location.href), retry }, lasting: true, now: Date.now, emit });

const cache = makeBlobCache({
  fetchRange: (id, start, end, signal, retry) =>
    watched(new Request(`/api/v1/blobs/${id}`, { headers: { Range: `bytes=${start}-${end}` }, credentials: "same-origin", signal }), retry),
});

// A new version takes over at once: the page and the worker are the same app, and the worker keeps nothing that matters.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  // A page loaded without the worker (e.g. by a hard reload) asks to be taken over (js/player.js).
  if (event.data?.type === "claim") event.waitUntil(self.clients.claim());
  // A page that locks takes what was read with it.
  if (event.data?.type === "forget") cache.forget();
  // Another track plays, or none: the one left behind isn't read ahead any more.
  if (event.data?.type === "playing") cache.focus(typeof event.data.id === "string" ? event.data.id : null);
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== "GET") return;
  if (url.pathname.startsWith("/play/")) {
    event.respondWith(play(request, event.clientId));
    return;
  }
  const blob = BLOB.exec(url.pathname);
  if (blob && request.headers.has("range")) event.respondWith(cached(request, blob[1]));
});

/** A ranged read of blob `id`: from the cache, or as it is from the server when the cache can't answer it. */
async function cached(request, id) {
  const response = await cache.respond(id, request.headers.get("range")).catch(() => null);
  return response ?? watched(request);
}

const failure = (status, text) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/** A play URL, answered by the page that asked for it (js/player.js). */
async function play(request, clientId) {
  const client = clientId ? await self.clients.get(clientId) : undefined;
  if (!client) return failure(404, "No page to play for");
  const answer = await ask(client, { type: "play", url: request.url, range: request.headers.get("range") });
  if (!answer) return failure(503, "The page didn't answer");
  return new Response(answer.body, { status: answer.status, headers: answer.headers });
}

/**
 * Posts `message` to `client` and waits for its answer: null if, in time, it neither answers nor says on the second
 * port that it is working on it. A page from before that port answers in time or not at all.
 */
function ask(client, message) {
  const channel = new MessageChannel();
  const working = new MessageChannel();
  const answer = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ANSWER_TIMEOUT_MS);
    channel.port1.onmessage = (event) => resolve(event.data);
    working.port1.onmessage = () => clearTimeout(timer);
  });
  client.postMessage(message, [channel.port2, working.port2]);
  return answer.finally(() => {
    channel.port1.close();
    working.port1.close();
  });
}
