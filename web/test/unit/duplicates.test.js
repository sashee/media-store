import { test } from "node:test";
import assert from "node:assert/strict";

import { duplicates, wasted } from "../../public/js/duplicates.js";

const SHA = (n) => n.toString(16).padStart(64, "0");
const file = (path, id, sha256, size = 100) => ({ path: path.split("/"), entry: { kind: "file", name: path.split("/").at(-1), id, salt: "s", size, sha256 } });

test("copies of an entry share its blob and aren't duplicates", () => {
  const files = [
    file("uploads/P/files/one.mp3", "a", SHA(1)),
    file("artists/X/Y/01 One.mp3", "a", SHA(1)),
    file("lists/likes/X - One.mp3", "a", SHA(1)),
    { path: ["uploads"], entry: { kind: "dir", name: "uploads", id: "d" } },
  ];
  assert.deepEqual(duplicates(files), []);
});

test("the same bytes in two blobs are a duplicate, each blob with the paths that reach it", () => {
  const files = [
    file("uploads/P/files/one.mp3", "a", SHA(1), 300),
    file("artists/X/Y/01 One.mp3", "a", SHA(1), 300),
    file("uploads/Q/files/one.mp3", "b", SHA(1), 300),
    file("lists/likes/X - One.mp3", "c", SHA(1), 300),
    file("uploads/Q/files/two.mp3", "d", SHA(2), 50),
    file("uploads/R/files/two.mp3", "e", SHA(2), 50),
    { path: ["uploads", "old.bin"], entry: { kind: "file", name: "old.bin", id: "f", size: 9 } },
  ];
  const found = duplicates(files);
  assert.deepEqual(found.map(({ sha256 }) => sha256), [SHA(1), SHA(2)], "the most wasteful first");
  assert.deepEqual(found[0].blobs, [
    { id: "a", paths: ["uploads/P/files/one.mp3", "artists/X/Y/01 One.mp3"] },
    { id: "b", paths: ["uploads/Q/files/one.mp3"] },
    { id: "c", paths: ["lists/likes/X - One.mp3"] },
  ]);
  assert.equal(wasted(found[0]), 600);
  assert.equal(wasted(found[1]), 50);
});
