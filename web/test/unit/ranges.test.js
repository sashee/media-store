// Serving a track over HTTP with ranges (ranges.js): the header's grammar, and the responses, from a stand-in read over
// plain bytes. The browser test plays real encrypted reads through the worker.

import { test } from "node:test";
import assert from "node:assert/strict";

import { IntegrityError } from "../../public/sdk/api.js";
import { parseRange, rangeResponse } from "../../public/js/ranges.js";

const SIZE = 1000;
const content = Uint8Array.from({ length: SIZE }, (_, i) => (i * 13) % 251);

/** A read over `bytes`, recording what it was asked for, the way readBlob answers: { size, stream }. */
function reader(bytes, { size = bytes.length } = {}) {
  const reads = [];
  const cancelled = [];
  const read = async ({ from, to }) => {
    reads.push([from, to]);
    const stream = new ReadableStream({
      pull: (controller) => {
        controller.enqueue(bytes.slice(from, to));
        controller.close();
      },
      cancel: () => cancelled.push([from, to]),
    });
    return { size, stream };
  };
  return { read, reads, cancelled };
}

const bodyOf = async (response) => new Uint8Array(await response.arrayBuffer());

test("a Range header becomes the bytes it asks for, all of them, or unsatisfiable", () => {
  const cases = [
    [null, 1000, null],
    ["bytes=0-", 1000, { from: 0, to: 1000 }],
    ["bytes=0-0", 1000, { from: 0, to: 1 }],
    ["bytes=100-199", 1000, { from: 100, to: 200 }],
    ["bytes=900-5000", 1000, { from: 900, to: 1000 }],
    ["bytes=999-", 1000, { from: 999, to: 1000 }],
    ["bytes=-100", 1000, { from: 900, to: 1000 }],
    ["bytes=-5000", 1000, { from: 0, to: 1000 }],
    ["Bytes=5-9", 1000, { from: 5, to: 10 }],
    [" bytes=5-9 ", 1000, { from: 5, to: 10 }],
    ["bytes=0-99999999999999999999999", 1000, { from: 0, to: 1000 }],
    ["bytes=1000-", 1000, "unsatisfiable"],
    ["bytes=5000-6000", 1000, "unsatisfiable"],
    ["bytes=99999999999999999999999-", 1000, "unsatisfiable"],
    ["bytes=-0", 1000, "unsatisfiable"],
    ["bytes=0-", 0, "unsatisfiable"],
    ["bytes=-10", 0, "unsatisfiable"],
    // ignored, so all of it is sent
    ["bytes=200-100", 1000, null],
    ["bytes=0-1,5-6", 1000, null],
    ["bytes=-", 1000, null],
    ["items=0-1", 1000, null],
    ["bytes=0x10-", 1000, null],
    ["bytes=1.5-", 1000, null],
    ["", 1000, null],
  ];
  for (const [header, size, expected] of cases) assert.deepEqual(parseRange(header, size), expected, `${header} of ${size}`);
});

test("a range is a 206 with its bytes, and only those are read", async () => {
  for (const [header, from, to] of [
    ["bytes=0-", 0, SIZE],
    ["bytes=0-1", 0, 2],
    ["bytes=500-509", 500, 510],
    ["bytes=-100", SIZE - 100, SIZE],
  ]) {
    const { read, reads } = reader(content);
    const response = await rangeResponse(header, { size: SIZE, type: "audio/ogg" }, read);
    assert.equal(response.status, 206, header);
    assert.deepEqual(Object.fromEntries(response.headers), {
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": String(to - from),
      "content-range": `bytes ${from}-${to - 1}/${SIZE}`,
      "content-type": "audio/ogg",
    });
    assert.deepEqual(await bodyOf(response), content.subarray(from, to), header);
    assert.deepEqual(reads, [[from, to]]);
  }
});

test("no range, or one that is ignored, is a 200 with the whole track; an unsatisfiable one a 416 with nothing read", async () => {
  for (const header of [null, "bytes=0-1,4-5"]) {
    const { read } = reader(content);
    const response = await rangeResponse(header, { size: SIZE, type: "audio/mpeg" }, read);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(SIZE));
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(await bodyOf(response), content);
  }
  const { read, reads } = reader(content);
  const response = await rangeResponse(`bytes=${SIZE}-`, { size: SIZE, type: "audio/mpeg" }, read);
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), `bytes */${SIZE}`);
  assert.deepEqual(reads, [], "nothing is read for it");
});

test("a track whose size isn't its entry's is an integrity error, and its read is cancelled", async () => {
  const { read, cancelled } = reader(content, { size: SIZE + 1 });
  await assert.rejects(rangeResponse("bytes=0-9", { size: SIZE, type: "audio/ogg" }, read), IntegrityError);
  assert.deepEqual(cancelled, [[0, 10]]);
});
