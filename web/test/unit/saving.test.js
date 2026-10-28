import { test } from "node:test";
import assert from "node:assert/strict";

import { IntegrityError } from "../../public/sdk/api.js";
import { counted, readWhole } from "../../public/js/saving.js";

/** A stream of `chunks` (strings), and whether it was cancelled. */
function source(chunks) {
  const state = { cancelled: false };
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
    cancel: () => {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

test("a counted stream passes its bytes on and says how many have gone by", async () => {
  const seen = [];
  const text = await new Response(counted(source(["ab", "cde"]).stream, (bytes) => seen.push(bytes))).text();
  assert.equal(text, "abcde");
  assert.deepEqual(seen, [2, 5]);
});

test("a file is read whole into a Blob of its type", async () => {
  const seen = [];
  const blob = await readWhole({ size: 5, stream: source(["ab", "cde"]).stream }, { size: 5, type: "audio/flac", onProgress: (bytes) => seen.push(bytes) });
  assert.equal(blob.type, "audio/flac");
  assert.equal(await blob.text(), "abcde");
  assert.deepEqual(seen, [2, 5]);
});

test("a read of another size than the entry says is refused, and cancelled", async () => {
  const { stream, state } = source(["abc"]);
  await assert.rejects(readWhole({ size: 3, stream }, { size: 5, type: "audio/flac" }), IntegrityError);
  assert.equal(state.cancelled, true);
});
