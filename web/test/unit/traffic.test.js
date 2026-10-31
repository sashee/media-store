import { test } from "node:test";
import assert from "node:assert/strict";

import { formatRate, formatUsage, MINUTE_MS, plus, rate, recent, sampleOf, total, WINDOW_MS } from "../../public/js/traffic.js";

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

test("the requests' events make the samples: a body going up as it is sent, an answer's coming down", () => {
  assert.deepEqual(sampleOf({ type: "sent", key: "a", at: 5, up: 100 }), { at: 5, down: 0, up: 100 });
  assert.deepEqual(sampleOf({ type: "bytes", key: "a", at: 6, bytes: 30 }), { at: 6, down: 30, up: 0 });
  assert.equal(sampleOf({ type: "sent", key: "b", at: 7, up: 0 }), null);
  assert.equal(sampleOf({ type: "answered", key: "a", at: 8, status: 200 }), null);
  assert.equal(sampleOf({ type: "ended", key: "a", at: 9, outcome: "done" }), null);
});
