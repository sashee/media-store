import { test } from "node:test";
import assert from "node:assert/strict";

import { answeredByWorker, bodySize, formatRate, formatUsage, metering, MINUTE_MS, plus, rate, recent, total, WINDOW_MS } from "../../public/js/traffic.js";

const base = "http://a1b2c3d4e5f60718.localhost:24680/";
const BLOB = "/api/v1/blobs/" + "ab".repeat(32);

test("the rate is the bytes received in the last two seconds, per second", () => {
  const now = 100_000;
  const samples = [
    { at: now - WINDOW_MS - 1, down: 1_000_000, up: 0 },
    { at: now - 1500, down: 3000, up: 500 },
    { at: now - 10, down: 1000, up: 0 },
  ];
  assert.deepEqual(recent(samples, now), samples.slice(1));
  assert.equal(rate(samples, now), 2000);
  assert.equal(rate([], now), 0);
});

test("the counter reads as bytes per second", () => {
  assert.equal(formatRate(0), "↓ 0 B/s");
  assert.equal(formatRate(512.4), "↓ 512 B/s");
  assert.equal(formatRate(2048), "↓ 2.0 KB/s");
  assert.equal(formatRate(1.5 * 1024 * 1024), "↓ 1.5 MB/s");
});

test("the last minute adds up what came and went in it, and the amounts since the start keep growing", () => {
  const now = 200_000;
  const samples = [
    { at: now - MINUTE_MS - 1, down: 7, up: 7 },
    { at: now - 30_000, down: 2048, up: 0 },
    { at: now - 10, down: 1024, up: 512 },
  ];
  assert.deepEqual(total(recent(samples, now, MINUTE_MS)), { down: 3072, up: 512 });
  assert.deepEqual(plus({ down: 10, up: 1 }, samples), { down: 3089, up: 520 });
  assert.equal(formatUsage({ minute: { down: 3072, up: 512 }, started: { down: 5 * 1024 * 1024, up: 0 } }), "Last min ↓ 3.0 KB ↑ 512 B · since start ↓ 5.0 MB ↑ 0 B");
});

test("a request body counts as it is sent", () => {
  assert.equal(bodySize("héllo"), 6);
  assert.equal(bodySize(new Uint8Array(10)), 10);
  assert.equal(bodySize(new Uint8Array(10).buffer), 10);
  assert.equal(bodySize(new Blob(["abc"])), 3);
  assert.equal(bodySize(undefined), 0);
  assert.equal(bodySize({}), 0);
});

test("the metering fetch reports what goes up and what comes down, and passes the response on", async () => {
  const seen = [];
  const fetch = metering(
    async (_input, init) => new Response(init?.body ? "stored" : "a longer answer", { status: 201, headers: { "X-Kind": "test" } }),
    { base, now: () => 1, onData: ({ down, up }) => seen.push([down, up]) },
  );
  const response = await fetch("/api/v1/blobs/x", { method: "PUT", body: new Uint8Array(100) });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("X-Kind"), "test");
  assert.equal(await response.text(), "stored");
  assert.deepEqual(seen, [[0, 100], [6, 0]]);

  const empty = await metering(async () => new Response(null, { status: 204 }), { base, now: () => 1, onData: () => assert.fail("nothing came") })("/x");
  assert.equal(empty.status, 204);
});

test("what the worker answers, a ranged read of a blob, is left to its own count", async () => {
  assert.equal(answeredByWorker(BLOB, { headers: { Range: "bytes=0-99" } }, base), true);
  assert.equal(answeredByWorker(new Request(base + BLOB.slice(1), { headers: { Range: "bytes=0-" } }), undefined, base), true);
  assert.equal(answeredByWorker(BLOB, {}, base), false, "a whole read goes to the server");
  assert.equal(answeredByWorker(BLOB, { method: "PUT", headers: { Range: "bytes=0-1" } }, base), false);
  assert.equal(answeredByWorker("/api/v1/refs/vault", { headers: { Range: "bytes=0-1" } }, base), false);
  const fetch = metering(async () => new Response("from the cache"), { base, now: () => 1, onData: () => assert.fail("counted twice") });
  assert.equal(await (await fetch(BLOB, { headers: { Range: "bytes=0-13" } })).text(), "from the cache");
});
