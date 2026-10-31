import { test } from "node:test";
import assert from "node:assert/strict";

import {
  answeredByWorker,
  apply,
  batched,
  bodySize,
  describe,
  duration,
  isApiRequest,
  isEvent,
  kindOf,
  LINGER_MS,
  lines,
  NONE,
  prune,
  requestOf,
  spanOf,
  watch,
  watching,
} from "../../public/js/requests.js";

const base = "http://a1b2c3d4e5f60718.localhost:24680/";
const ID = "ab".repeat(32);
const BLOB = `/api/v1/blobs/${ID}`;

const sent = (key, at, what = {}) => ({ type: "sent", key, at, method: "GET", path: "/api/v1/refs/vault", blob: null, range: null, up: 0, retry: 0, ...what });
const answered = (key, at, status = 200, more = {}) => ({ type: "answered", key, at, status, total: null, length: null, ...more });
const ended = (key, at, outcome = "done") => ({ type: "ended", key, at, outcome });
const all = (events, state = NONE) => events.reduce(apply, state);

// ---------------------------------------------------------------- the count

test("a burst says how many of its requests are done, how many load, and how many wait", () => {
  const three = all([sent("a", 1000), sent("b", 1000), sent("c", 1000)]);
  assert.equal(describe(three, 1000), "Requests: 0 of 3 done · 3 waiting");
  const going = all([answered("a", 1200), answered("b", 1300), ended("b", 1500)], three);
  assert.equal(describe(going, 1500), "Requests: 1 of 3 done · 1 loading · 1 waiting");
});

test("a long wait says how long the oldest has waited; a request loading isn't waiting", () => {
  const state = all([sent("a", 1000), sent("b", 30_000), sent("c", 0), answered("c", 10)]);
  assert.equal(describe(state, 38_400), "Requests: 0 of 3 done · 1 loading · 2 waiting, the longest 37 s");
});

test("failures and cancellations are said, and only when there are any; a request stopped early is done", () => {
  const state = all([sent("a", 0), sent("b", 0), sent("c", 0), sent("d", 0), ended("a", 10), ended("b", 20, "failed"), ended("c", 30, "cancelled"), ended("d", 30, "stopped")]);
  assert.equal(describe(state, 40), "Requests: 2 of 4 done · 1 failed · 1 cancelled");
});

test("the line goes a while after the last request ends, and the next burst counts from zero", () => {
  const done = all([sent("a", 0), ended("a", 100)]);
  assert.equal(describe(done, 100 + LINGER_MS), "Requests: 1 of 1 done");
  assert.equal(describe(done, 101 + LINGER_MS), null);
  assert.equal(describe(apply(done, sent("b", 200 + LINGER_MS)), 200 + LINGER_MS), "Requests: 0 of 1 done · 1 waiting");
});

test("a request sent soon after the last one ended belongs to the same burst; one reported late doesn't end it early", () => {
  const done = all([sent("a", 0), ended("a", 100)]);
  assert.equal(describe(apply(done, sent("b", 500)), 500), "Requests: 1 of 2 done · 1 waiting");
  // The worker's events come in a while after the page's.
  assert.equal(all([sent("c", 50), ended("c", 60)], done).last, 100);
});

test("events of a request not under way change nothing", () => {
  const state = all([sent("a", 0), ended("a", 10)]);
  for (const event of [ended("x", 20), ended("a", 20, "failed"), answered("x", 20), { type: "bytes", key: "x", at: 20, bytes: 5 }, { type: "other", key: "a", at: 20 }]) {
    assert.equal(apply(state, event), state, event.type);
  }
});

test("requests that ended a while ago are dropped from the state", () => {
  const state = all([sent("a", 0), ended("a", 10), sent("b", 20)]);
  assert.deepEqual(prune(state, 11 + LINGER_MS).requests.map((r) => r.key), ["b"]);
  assert.equal(prune(state, 11 + LINGER_MS).sent, 2, "the count stays");
});

// ---------------------------------------------------------------- the list

test("each request has its line: what it reads, and how it goes", () => {
  const span = { blob: ID, path: BLOB, range: { start: 0, end: 1_048_575 } };
  const state = all([
    sent("a", 0, { ...span, label: "Song X" }),
    answered("a", 500, 206, { total: 4 * 1_048_576, length: 1_048_576 }),
    { type: "bytes", key: "a", at: 900, bytes: 524_288 },
    sent("b", 1000, { ...span, label: "Song Y", retry: 2 }),
    sent("c", 1000, { method: "PUT", path: BLOB, blob: ID, up: 2048 }),
    sent("d", 0),
    answered("d", 200),
    ended("d", 200),
    sent("e", 0, { blob: ID, path: BLOB }),
    answered("e", 300, 503),
    ended("e", 300, "failed"),
  ]);
  const shown = lines(state, 3000).lines.map(({ mark, label, detail, how }) => `${mark} ${[label, detail].filter(Boolean).join(" · ")} | ${how}`);
  assert.deepEqual(shown, [
    "↓ Song X · 0–25% of 4.0 MB | 512.0 KB of 1.0 MB · 3.0 s",
    "⧗ Song Y · first 1.0 MB · retry 2 | waiting 2.0 s",
    "⧗ upload · 2.0 KB | waiting 2.0 s",
    "✓ GET refs/vault | 200 ms",
    "✗ blob abababab · all | failed (503)",
  ]);
});

test("a stopped, a cancelled and an odd answer say so", () => {
  const state = all([sent("a", 0), answered("a", 10, 206), { type: "bytes", key: "a", at: 20, bytes: 300 }, ended("a", 30, "stopped"), sent("b", 0), ended("b", 5, "cancelled"), sent("c", 0), answered("c", 40, 404), ended("c", 40)]);
  assert.deepEqual(
    lines(state, 50).lines.map(({ phase, how }) => [phase, how]),
    [
      ["stopped", "stopped after 300 B"],
      ["cancelled", "cancelled"],
      ["done", "40 ms · 404"],
    ],
  );
});

test("the list keeps to its lines: those under way first, then those that ended last, in the order they were sent", () => {
  const state = all([sent("a", 0), sent("b", 1), ended("b", 5), sent("c", 2), ended("c", 9), sent("d", 3), sent("e", 4), ended("e", 6)]);
  const { lines: kept, more } = lines(state, 10, 4);
  assert.deepEqual(kept.map((line) => line.key), ["a", "c", "d"]);
  assert.equal(more, 2);
  assert.deepEqual(lines(state, 10, 5).lines.map((line) => line.key), ["a", "b", "c", "d", "e"], "all fit: no line for more");
  assert.deepEqual(lines(state, 9 + LINGER_MS, 5).lines.map((line) => line.key), ["a", "c", "d"], "those that ended a while ago go");
});

test("which bytes a read asks for", () => {
  const MB = 1_048_576;
  assert.equal(spanOf({ range: null, total: null, length: null }), "all");
  assert.equal(spanOf({ range: null, total: null, length: 3 * MB }), "all 3.0 MB");
  assert.equal(spanOf({ range: { start: 0, end: 32 * MB - 1 }, total: 3 * MB, length: 3 * MB }), "all 3.0 MB");
  assert.equal(spanOf({ range: { start: 0, end: MB / 2 - 1 }, total: 10 * MB, length: null }), "0–5% of 10.0 MB");
  assert.equal(spanOf({ range: { start: 2.5 * MB, end: null }, total: 10 * MB, length: null }), "25–100% of 10.0 MB");
  assert.equal(spanOf({ range: { start: 0, end: MB / 2 - 1 }, total: null, length: null }), "first 512.0 KB");
  assert.equal(spanOf({ range: { start: MB, end: null }, total: null, length: null }), "from 1.0 MB");
  assert.equal(spanOf({ range: { start: MB, end: 2 * MB - 1 }, total: null, length: null }), "1.0 MB–2.0 MB");
});

test("how long a request took", () => {
  assert.deepEqual([0, 40.4, 999, 1000, 2345, 9999, 37_800].map(duration), ["0 ms", "40 ms", "999 ms", "1.0 s", "2.3 s", "10.0 s", "37 s"]);
});

test("what a request is, without a better name", () => {
  assert.equal(kindOf({ method: "GET", path: BLOB, blob: ID }), "blob abababab");
  assert.equal(kindOf({ method: "PUT", path: BLOB, blob: ID }), "upload");
  assert.equal(kindOf({ method: "DELETE", path: BLOB, blob: ID }), "DELETE blobs/abababab");
  assert.equal(kindOf({ method: "PUT", path: "/api/v1/refs/vault", blob: null }), "PUT refs/vault");
});

// ---------------------------------------------------------------- watching requests

test("a request body counts as it is sent", () => {
  assert.equal(bodySize("héllo"), 6);
  assert.equal(bodySize(new Uint8Array(10)), 10);
  assert.equal(bodySize(new Uint8Array(10).buffer), 10);
  assert.equal(bodySize(new Blob(["abc"])), 3);
  assert.equal(bodySize(undefined), 0);
  assert.equal(bodySize({}), 0);
});

test("only the API's requests are watched", () => {
  assert.equal(isApiRequest("/api/v1/me", base), true);
  assert.equal(isApiRequest(new Request(`${base}api/v1/blobs/x`), base), true);
  assert.equal(isApiRequest("/sdk/api.js", base), false);
  assert.equal(isApiRequest("/play/x?salt=y", base), false);
  assert.equal(isApiRequest("https://elsewhere.example/api/v1/me", base), false);
});

test("what a request asks for", () => {
  assert.deepEqual(requestOf(BLOB, { headers: { Range: "bytes=10-19" } }, base), { method: "GET", path: BLOB, blob: ID, range: { start: 10, end: 19 }, up: 0 });
  assert.deepEqual(requestOf(new Request(base + BLOB.slice(1), { method: "PUT", body: "x" }), { body: new Uint8Array(4) }, base), { method: "PUT", path: BLOB, blob: ID, range: null, up: 4 });
  assert.deepEqual(requestOf("/api/v1/refs/vault", undefined, base), { method: "GET", path: "/api/v1/refs/vault", blob: null, range: null, up: 0 });
});

test("what the worker answers is a ranged read of a blob", () => {
  assert.equal(answeredByWorker(BLOB, { headers: { Range: "bytes=0-99" } }, base), true);
  assert.equal(answeredByWorker(new Request(base + BLOB.slice(1), { headers: { Range: "bytes=0-" } }), undefined, base), true);
  assert.equal(answeredByWorker(BLOB, {}, base), false, "a whole read goes to the server");
  assert.equal(answeredByWorker(BLOB, { method: "PUT", headers: { Range: "bytes=0-1" } }, base), false);
  assert.equal(answeredByWorker("/api/v1/refs/vault", { headers: { Range: "bytes=0-1" } }, base), false);
});

/** A body of `parts`, closing after them; `fail`, an error instead. */
const bodyOf = (parts, fail = null) => {
  const queue = [...parts];
  return new ReadableStream({
    pull: (controller) => (queue.length > 0 ? controller.enqueue(queue.shift()) : fail ? controller.error(fail) : controller.close()),
  });
};

/** `watch` of a fetch answering `answer`: { response, events } with the events by type and outcome. */
async function watched(answer, { lasting = true, what = {} } = {}) {
  const events = [];
  let clock = 0;
  const response = await watch(async () => (answer instanceof Error ? Promise.reject(answer) : answer), BLOB, undefined, {
    key: "k",
    what,
    lasting,
    now: () => ++clock,
    emit: (event) => events.push(event),
  });
  const said = () => events.map((e) => (e.type === "ended" ? `ended ${e.outcome}` : e.type === "bytes" ? `bytes ${e.bytes}` : e.type));
  return { response, said, events };
}

test("a blob's read lasts until its body is read through, and tells its bytes as they are read", async () => {
  const headers = { "Content-Range": "bytes 0-5/100", "Content-Length": "6" };
  const { response, said, events } = await watched(new Response(bodyOf([new Uint8Array(4), new Uint8Array(2)]), { status: 206, headers }), { what: { method: "GET" } });
  assert.deepEqual(said(), ["sent", "answered"]);
  assert.deepEqual(events[0], { type: "sent", key: "k", at: 1, method: "GET" });
  assert.deepEqual(events[1], { type: "answered", key: "k", at: 2, status: 206, total: 100, length: 6 });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-5/100");
  assert.equal((await response.arrayBuffer()).byteLength, 6);
  assert.deepEqual(said(), ["sent", "answered", "bytes 4", "bytes 2", "ended done"], "done once all of it came, and only once");
});

test("a read that stops early is stopped; one that breaks off failed; one aborted is cancelled", async () => {
  const stopped = await watched(new Response(bodyOf([new Uint8Array(4), new Uint8Array(2)]), { status: 206 }));
  const reader = stopped.response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.deepEqual(stopped.said(), ["sent", "answered", "bytes 4", "ended stopped"]);

  const broken = await watched(new Response(bodyOf([new Uint8Array(4)], new TypeError("network error")), { status: 206 }));
  await assert.rejects(broken.response.arrayBuffer());
  assert.deepEqual(broken.said(), ["sent", "answered", "bytes 4", "ended failed"]);

  const aborted = await watched(new Response(bodyOf([], new DOMException("aborted", "AbortError")), { status: 206 }));
  await assert.rejects(aborted.response.arrayBuffer());
  assert.deepEqual(aborted.said(), ["sent", "answered", "ended cancelled"]);
});

test("a request whose body isn't a blob's, or isn't the bytes asked for, ends with its answer", async () => {
  const json = await watched(new Response("{}", { status: 201 }), { lasting: false });
  assert.deepEqual(json.said(), ["sent", "answered", "ended done"]);
  await json.response.text();
  assert.deepEqual(json.said(), ["sent", "answered", "ended done", "bytes 2"], "its bytes still count");

  const refused = await watched(new Response("no", { status: 503 }));
  assert.deepEqual(refused.said(), ["sent", "answered", "ended failed"]);
  const empty = await watched(new Response(null, { status: 204 }));
  assert.deepEqual(empty.said(), ["sent", "answered", "ended done"]);
});

test("a request without an answer failed, or was cancelled, and the error goes on", async () => {
  const down = new TypeError("Failed to fetch");
  const events = [];
  const options = { key: "k", what: {}, lasting: true, now: () => 0, emit: (event) => events.push(event) };
  await assert.rejects(watch(() => Promise.reject(down), BLOB, undefined, options), (error) => error === down);
  await assert.rejects(watch(() => Promise.reject(new DOMException("aborted", "AbortError")), BLOB, undefined, options), { name: "AbortError" });
  assert.deepEqual(events.filter((e) => e.type === "ended").map((e) => e.outcome), ["failed", "cancelled"]);
});

test("the watching fetch watches the API's requests, but not what the worker answers while it controls the page", async () => {
  const events = [];
  let controlled = true;
  const fetch = watching(async (input) => new Response(`answer to ${input}`), { base, now: () => 0, emit: (event) => events.push(event), byWorker: () => controlled });
  assert.equal(await (await fetch("/index.html")).text(), "answer to /index.html");
  await (await fetch(BLOB, { headers: { Range: "bytes=0-9" } })).text();
  assert.deepEqual(events, [], "neither the page's files nor what the worker answers");
  controlled = false;
  await (await fetch(BLOB, { headers: { Range: "bytes=0-9" } })).text();
  await (await fetch("/api/v1/me")).text();
  const sends = events.filter((e) => e.type === "sent");
  assert.deepEqual(sends.map((e) => [e.key, e.path, e.retry]), [["page:0", BLOB, 0], ["page:1", "/api/v1/me", 0]]);
  assert.ok(events.every(isEvent));
});

test("a report has one bytes event per request", () => {
  const events = [sent("a", 0), { type: "bytes", key: "a", at: 1, bytes: 3 }, { type: "bytes", key: "b", at: 2, bytes: 1 }].reduce(batched, []);
  assert.deepEqual(batched(events, { type: "bytes", key: "a", at: 5, bytes: 4 }), [sent("a", 0), { type: "bytes", key: "a", at: 5, bytes: 7 }, { type: "bytes", key: "b", at: 2, bytes: 1 }]);
  assert.deepEqual(batched(events, ended("a", 6)).at(-1), ended("a", 6));
});

test("only well-formed events count", () => {
  assert.equal(isEvent(sent("a", 0)), true);
  assert.equal(isEvent({ type: "bytes", key: "a", at: 0, bytes: 1.5 }), false);
  assert.equal(isEvent({ type: "sent", key: 1, at: 0 }), false);
  assert.equal(isEvent({ type: "traffic", key: "a", at: 0 }), false);
  assert.equal(isEvent(null), false);
});
