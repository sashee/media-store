import { test } from "node:test";
import assert from "node:assert/strict";

import { DISLIKES, dislike, isDisliked, readDislikes, undislike } from "../../public/js/dislikes.js";
import { NOW, storedTree } from "./stored-tree.js";

const SHA = (n) => n.toString(16).padStart(64, "0");
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));

test("dislikes.json is read with care: anything odd is no dislike", () => {
  assert.deepEqual(readDislikes(null), []);
  assert.deepEqual(readDislikes(encode({ version: 2, tracks: [{ sha256: SHA(1) }] })), [], "a newer version");
  assert.deepEqual(readDislikes(new TextEncoder().encode("not json")), []);
  const read = readDislikes(encode({ version: 1, tracks: [{ sha256: SHA(1), title: "One", artist: 3, disliked: "2026-10-28T10:00:00.000Z" }, { sha256: "short" }, null] }));
  assert.deepEqual(read, [{ sha256: SHA(1), title: "One", artist: "", disliked: "2026-10-28T10:00:00.000Z" }]);
  assert.ok(isDisliked(read, SHA(1)));
  assert.ok(!isDisliked(read, SHA(2)));
  assert.ok(!isDisliked(read, undefined));
});

test("disliking notes the bytes once, the newest first; taking it back removes them", async () => {
  const tx = storedTree({ "uploads/P/files/one.mp3": { sha256: SHA(1) } });
  const one = await dislike({ sha256: SHA(1), title: "One", artist: "X" }, NOW)(tx);
  const two = await dislike({ sha256: SHA(2), title: "Two" }, NOW + 1000)(one);
  const read = async (t) => readDislikes(await t.read(DISLIKES));
  assert.deepEqual((await read(two)).map((d) => [d.sha256, d.title, d.artist]), [[SHA(2), "Two", ""], [SHA(1), "One", "X"]]);
  assert.equal((await read(two))[1].disliked, new Date(NOW).toISOString());
  assert.equal(await dislike({ sha256: SHA(1), title: "Again" }, NOW + 2000)(two), two, "the same bytes again: nothing changes");

  const back = await undislike(SHA(1))(two);
  assert.deepEqual((await read(back)).map((d) => d.sha256), [SHA(2)]);
  assert.equal(await undislike(SHA(9))(back), back, "not disliked: nothing changes");
});
