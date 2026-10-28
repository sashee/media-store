import { test } from "node:test";
import assert from "node:assert/strict";

import { aheadBytes, nearEnd, NEXT_START_BYTES, reportingErrors } from "../../public/js/player.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a read that fails is reported, and fails the stream", async () => {
  const errors = [];
  const failing = new ReadableStream({ pull: (controller) => controller.error(new TypeError("network error")) });
  await assert.rejects(new Response(reportingErrors(failing, (message) => errors.push(message))).arrayBuffer(), /network error/);
  assert.deepEqual(errors, ["network error"]);
});

test("the player going away while a read waits is no error: its bytes are dropped", async () => {
  const errors = [];
  let deliver;
  // Its bytes come after the cancel, as a network read's would; by then its own stream is closed.
  const late = (controller, resolve) => () => {
    try {
      controller.enqueue(new Uint8Array([1]));
    } catch {
      // closed by the cancel
    }
    resolve();
  };
  const slow = new ReadableStream({ pull: (controller) => new Promise((resolve) => (deliver = late(controller, resolve))) });
  const reader = reportingErrors(slow, (message) => errors.push(message)).getReader();
  const pending = reader.read();
  await tick();
  await reader.cancel(new DOMException("seeked", "AbortError"));
  deliver?.();
  assert.deepEqual(await pending, { done: true, value: undefined });
  await tick();
  assert.deepEqual(errors, []);
});

test("an abort from the reading side, the SDK's when its read is cancelled, isn't reported either", async () => {
  const errors = [];
  const aborted = new ReadableStream({ pull: (controller) => controller.error(new DOMException("cancelled", "AbortError")) });
  await assert.rejects(new Response(reportingErrors(aborted, (message) => errors.push(message))).arrayBuffer());
  assert.deepEqual(errors, []);
});

test("bytes pass through as they come, and the end closes it", async () => {
  const source = new Response(new Uint8Array([1, 2, 3])).body;
  assert.deepEqual(new Uint8Array(await new Response(reportingErrors(source, () => assert.fail("no error"))).arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test("the next track's share is a fifth of its file, at least its start, at most one fetch of the worker's", () => {
  const MiB = 1024 * 1024;
  assert.equal(aheadBytes(40 * MiB), 8 * MiB, "a CD track: about a fifth of its length");
  assert.equal(aheadBytes(MiB), NEXT_START_BYTES, "a short one: its start");
  assert.equal(aheadBytes(400 * MiB), 32 * MiB, "a long hi-res one: one fetch");
});

test("the share is due once a track is 30 s or less from its end, and only with a known length", () => {
  assert.equal(nearEnd(100, 200), false);
  assert.equal(nearEnd(170, 200), true);
  assert.equal(nearEnd(0, 20), true, "a short track: at once");
  assert.equal(nearEnd(0, NaN), false, "the length not known yet");
  assert.equal(nearEnd(0, Infinity), false, "a stream has no end");
});
