import { test } from "node:test";
import assert from "node:assert/strict";

import { makeBlobCache, parseBlobRange, parseContentRange } from "../../public/js/blob-cache.js";

const PIECE = 100;
const bytesOf = (length, seed = 0) => Uint8Array.from({ length }, (_, i) => (i * 7 + seed) % 256);

/**
 * A server holding `blobs` (id → bytes) that answers ranges as the backend does, in parts of `part` bytes, recording
 * every request. `hold()` makes its bodies wait until `release()`.
 */
function server(blobs, { part = 30 } = {}) {
  const requests = [];
  const delivered = { bytes: 0 };
  let gate = null;
  const fetchRange = async (id, start, end, signal) => {
    requests.push([id, start, end]);
    const blob = blobs[id];
    if (!blob) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    if (start >= blob.length) return new Response(null, { status: 416 });
    const last = Math.min(end, blob.length - 1);
    let at = start;
    const body = new ReadableStream({
      async pull(controller) {
        if (gate) await gate.promise;
        if (signal.aborted) return controller.error(signal.reason);
        const next = Math.min(at + part, last + 1);
        controller.enqueue(blob.slice(at, next));
        delivered.bytes += next - at;
        at = next;
        if (at > last) controller.close();
      },
    });
    return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${last}/${blob.length}` } });
  };
  return {
    fetchRange,
    requests,
    delivered,
    hold: () => {
      let release;
      gate = { promise: new Promise((resolve) => (release = resolve)) };
      return () => {
        gate = null;
        release();
      };
    },
  };
}

const read = async (response) => new Uint8Array(await response.arrayBuffer());
/** Let fetches that run on their own get on. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("Range and Content-Range headers", () => {
  assert.deepEqual(parseBlobRange("bytes=0-99"), { start: 0, end: 99 });
  assert.deepEqual(parseBlobRange("bytes=100-"), { start: 100, end: null });
  for (const header of [null, "bytes=-5", "bytes=5-1", "bytes=0-1,4-5", "items=0-1"]) assert.equal(parseBlobRange(header), null, header);
  assert.deepEqual(parseContentRange("bytes 0-99/1000"), { start: 0, end: 99, total: 1000 });
  assert.equal(parseContentRange("bytes */1000"), null);
});

test("a read fetches its range rounded out to pieces, and answers with exactly the bytes asked for", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE });
  const response = await cache.respond("a", "bytes=150-349");
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 150-349/1000");
  assert.equal(response.headers.get("content-length"), "200");
  assert.deepEqual(await read(response), blob.subarray(150, 350));
  assert.deepEqual(net.requests, [["a", 100, 399]]);
  assert.deepEqual(cache.contents().a.pieces, [1, 2, 3]);
});

test("what is cached is answered without the server, and only what is missing is fetched", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE });
  await read(await cache.respond("a", "bytes=0-299"));
  assert.deepEqual(await read(await cache.respond("a", "bytes=50-250")), blob.subarray(50, 251));
  assert.equal(net.requests.length, 1, "nothing new for cached bytes");
  assert.deepEqual(await read(await cache.respond("a", "bytes=250-999")), blob.subarray(250, 1000));
  assert.deepEqual(net.requests.slice(1), [["a", 300, 999]], "one request for the missing stretch");
});

test("the last piece is as long as the blob, and a range past the end is the server's to refuse", async () => {
  const blob = bytesOf(250);
  const net = server({ a: blob });
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE });
  assert.deepEqual(await read(await cache.respond("a", "bytes=180-")), blob.subarray(180));
  assert.equal(await cache.respond("a", "bytes=250-"), null);
  assert.equal(await cache.respond("a", "bytes=0-1,5-6"), null, "several ranges go to the server");
  assert.equal(await cache.respond("missing", "bytes=0-9"), null, "so does a blob the server doesn't have");
});

test("a fetch runs to its end even when the read is cancelled: that is the read-ahead", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE });
  const reader = (await cache.respond("a", "bytes=0-")).body.getReader();
  await reader.read();
  await reader.cancel();
  await settle();
  assert.deepEqual(cache.contents().a.pieces, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(await read(await cache.respond("a", "bytes=700-899")), blob.subarray(700, 900));
  assert.equal(net.requests.length, 1);
});

test("another track playing stops this one's read-ahead, and keeps what it has", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob, b: bytesOf(500, 3) });
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE });
  const reader = (await cache.respond("a", "bytes=0-")).body.getReader();
  await reader.read();
  await reader.cancel();
  const release = net.hold();
  cache.focus("b");
  release();
  await settle();
  const kept = cache.contents().a.pieces;
  assert.ok(kept.length > 0 && kept.length < 10, `some pieces kept, not all fetched: ${kept}`);
  assert.ok(net.delivered.bytes < 1000);
  // What it has is still answered, and the rest is fetched when asked for.
  assert.deepEqual(await read(await cache.respond("a", "bytes=0-99")), blob.subarray(0, 100));
  assert.deepEqual(await read(await cache.respond("a", "bytes=900-999")), blob.subarray(900, 1000));
});

test("the track playing keeps reading ahead", async () => {
  const net = server({ a: bytesOf(1000) });
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE });
  const reader = (await cache.respond("a", "bytes=0-")).body.getReader();
  await reader.read();
  await reader.cancel();
  cache.focus("a");
  await settle();
  assert.deepEqual(cache.contents().a.pieces, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("a read waits for the piece already on its way instead of fetching it again", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE });
  await read(await cache.respond("a", "bytes=900-999")); // learns the size
  const release = net.hold();
  // A body fetches when it is read: start reading the long one, which then waits on the held server.
  const first = (await cache.respond("a", "bytes=0-899")).body;
  const firstBytes = read(new Response(first));
  await settle();
  const second = cache.respond("a", "bytes=10-49");
  release();
  assert.deepEqual(await read(await second), blob.subarray(10, 50));
  assert.deepEqual(await firstBytes, blob.subarray(0, 900));
  assert.deepEqual(net.requests, [["a", 900, 999], ["a", 0, 899]]);
});

test("a fetch stops where another one got first, so a seek ahead fetches nothing twice", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob }, { part: 10 });
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE });
  const release = net.hold();
  const playing = cache.respond("a", "bytes=0-");
  release();
  const reader = (await playing).body.getReader();
  await reader.read();
  // Seek to the middle while the first fetch is still near the start.
  const seek = await cache.respond("a", "bytes=500-");
  assert.deepEqual(await read(seek), blob.subarray(500));
  await reader.cancel();
  await settle();
  const fetched = net.requests.map(([, start, end]) => [start, end]);
  assert.equal(fetched[1][0], 500, "the seek fetched from its own place");
  assert.ok(net.delivered.bytes <= 1000 + 2 * 10, `nothing fetched twice, but for what was in flight (${net.delivered.bytes})`);
  assert.deepEqual(cache.contents().a.pieces, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(await read(await cache.respond("a", "bytes=0-999")), blob, "and the bytes are right, from either fetch");
});

test("a long read is fetched in stretches of at most fetchBytes", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE, fetchBytes: 300 });
  assert.deepEqual(await read(await cache.respond("a", "bytes=0-999")), blob);
  assert.deepEqual(net.requests, [["a", 0, 299], ["a", 300, 599], ["a", 600, 899], ["a", 900, 999]]);
});

test("at most maxBlobs blobs are kept, the least recently used going first", async () => {
  const blobs = { a: bytesOf(300, 1), b: bytesOf(300, 2), c: bytesOf(300, 3), d: bytesOf(300, 4) };
  const net = server(blobs);
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE, maxBlobs: 3 });
  for (const id of ["a", "b", "c"]) await read(await cache.respond(id, "bytes=0-299"));
  await read(await cache.respond("a", "bytes=0-9")); // a is used again: b is now the oldest
  await read(await cache.respond("d", "bytes=0-299"));
  assert.deepEqual(Object.keys(cache.contents()).sort(), ["a", "c", "d"]);
});

test("at most maxBytes are kept, the least recently used pieces going first", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE, maxBytes: 500 });
  assert.deepEqual(await read(await cache.respond("a", "bytes=0-999")), blob, "a read longer than the cache still gets everything");
  assert.deepEqual(cache.contents().a.pieces, [5, 6, 7, 8, 9]);
});

test("a fetch that gives up fails the read, and the next read fetches again", async () => {
  const blob = bytesOf(1000);
  let broken = true;
  const net = server({ a: blob });
  const fetchRange = async (...args) => {
    const response = await net.fetchRange(...args);
    if (!broken) return response;
    const reader = response.body.getReader();
    let sent = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (sent >= 150) return controller.error(new TypeError("network error"));
        const { value } = await reader.read();
        sent += value.length;
        controller.enqueue(value);
      },
    });
    return new Response(body, { status: 206, headers: response.headers });
  };
  const cache = makeBlobCache({ fetchRange, pieceSize: PIECE, pauses: [] });
  await assert.rejects(read(await cache.respond("a", "bytes=0-999")), /network error/);
  assert.deepEqual(cache.contents().a.pieces, [0], "what arrived whole is kept");
  broken = false;
  assert.deepEqual(await read(await cache.respond("a", "bytes=0-999")), blob);
});

test("forget empties the cache and stops its fetches", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  const cache = makeBlobCache({ fetchRange: net.fetchRange, pieceSize: PIECE });
  const release = net.hold();
  const pending = cache.respond("a", "bytes=0-");
  release();
  const reader = (await pending).body.getReader();
  cache.forget();
  await assert.rejects(reader.read(), /emptied/);
  assert.deepEqual(cache.contents(), {});
});

/**
 * `net`'s fetchRange, failing as `plan` says, one entry per request: "drop" (a network error), "break" (a body that
 * breaks off after 150 bytes), "short" (one that ends there), "stall" (one that sends nothing until aborted), a status,
 * or nothing (as the server answers).
 */
function failing(net, plan) {
  return async (id, start, end, signal) => {
    const how = plan.shift();
    if (how === "drop") throw new TypeError("Failed to fetch");
    if (typeof how === "number") return new Response("", { status: how });
    if (how === "stall") {
      net.requests.push([id, start, end]);
      const body = new ReadableStream({ start: (controller) => signal.addEventListener("abort", () => controller.error(signal.reason)) });
      return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/1000` } });
    }
    const response = await net.fetchRange(id, start, end, signal);
    if (!how) return response;
    const reader = response.body.getReader();
    let sent = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (sent >= 150) return how === "break" ? controller.error(new TypeError("network error")) : controller.close();
        const { value } = await reader.read();
        sent += value.length;
        controller.enqueue(value);
      },
    });
    return new Response(body, { status: 206, headers: response.headers });
  };
}

const PAUSES = [1, 1];

test("a fetch that breaks off is made again from the piece it was at, and the read doesn't notice", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  const cache = makeBlobCache({ fetchRange: failing(net, ["break"]), pieceSize: PIECE, pauses: PAUSES });
  assert.deepEqual(await read(await cache.respond("a", "bytes=0-999")), blob);
  assert.deepEqual(net.requests, [["a", 0, 999], ["a", 100, 999]], "piece 0 had come whole; piece 1 is fetched again");
});

test("each attempt of a fetch is told how many came before it", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  const fetchRange = failing(net, ["drop", "break"]);
  const retries = [];
  const cache = makeBlobCache({ fetchRange: (id, start, end, signal, retry) => (retries.push(retry), fetchRange(id, start, end, signal)), pieceSize: PIECE, pauses: PAUSES });
  assert.deepEqual(await read(await cache.respond("a", "bytes=0-999")), blob);
  assert.deepEqual(retries, [0, 1, 2]);
});

test("no network, 502–504 and a body that ends early are made again too", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  const cache = makeBlobCache({ fetchRange: failing(net, ["drop", 502, 503, 504, "short"]), pieceSize: PIECE, pauses: [1, 1, 1, 1, 1] });
  cache.focus("a");
  assert.deepEqual(await read(await cache.respond("a", "bytes=0-999")), blob);
  assert.deepEqual(net.requests, [["a", 0, 999], ["a", 100, 999]]);
});

test("a fetch that stalls is made again", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  const cache = makeBlobCache({ fetchRange: failing(net, ["stall"]), pieceSize: PIECE, pauses: PAUSES, stallMs: 30 });
  assert.deepEqual(await read(await cache.respond("a", "bytes=0-999")), blob);
  assert.deepEqual(net.requests, [["a", 0, 999], ["a", 0, 999]]);
});

test("the track playing keeps trying; any other blob gives up after the last pause", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob, b: blob });
  const plan = Array(10).fill("drop");
  const cache = makeBlobCache({ fetchRange: failing(net, plan), pieceSize: PIECE, pauses: PAUSES });
  assert.equal(await cache.respond("b", "bytes=0-999"), null, "the server as it is, then");
  assert.equal(plan.length, 10 - (PAUSES.length + 1));
  cache.focus("a");
  assert.deepEqual(await read(await cache.respond("a", "bytes=0-999")), blob, "after every drop left in the plan");
  assert.equal(plan.length, 0);
});

test("another track playing, or forget, ends the retries", async () => {
  const blob = bytesOf(1000);
  const net = server({ a: blob });
  let attempts = 0;
  const fetchRange = async () => {
    attempts += 1;
    throw new TypeError("Failed to fetch");
  };
  const cache = makeBlobCache({ fetchRange, pieceSize: PIECE, pauses: PAUSES });
  cache.focus("a");
  const reading = cache.respond("a", "bytes=0-999");
  await settle();
  cache.focus("b");
  assert.equal(await reading, null);
  const after = attempts;
  await settle();
  assert.equal(attempts, after, "nothing is tried after");

  cache.focus("a");
  const again = cache.respond("a", "bytes=0-999");
  await settle();
  cache.forget();
  assert.equal(await again, null);
  assert.equal(net.requests.length, 0);
});

test("a refusal isn't made again: a missing blob, a range not asked for", async () => {
  const net = server({});
  let requests = 0;
  const cache = makeBlobCache({ fetchRange: (...args) => (requests++, net.fetchRange(...args)), pieceSize: PIECE, pauses: PAUSES });
  cache.focus("a");
  assert.equal(await cache.respond("a", "bytes=0-99"), null);
  assert.equal(requests, 1);
  const wrong = makeBlobCache({ fetchRange: async () => (requests++, new Response("", { status: 206, headers: { "Content-Range": "bytes 50-99/1000" } })), pieceSize: PIECE, pauses: PAUSES });
  wrong.focus("a");
  assert.equal(await wrong.respond("a", "bytes=0-99"), null);
  assert.equal(requests, 2);
});
