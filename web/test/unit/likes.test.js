import { test } from "node:test";
import assert from "node:assert/strict";

import { trackOf } from "../../public/js/library.js";
import { isLiked, LIKES, like, likeName, newestFirst, notInPackages, onlyLiked, repointed, repointLikes, unlike } from "../../public/js/likes.js";
import { allPackages } from "../../public/js/packages.js";
import { NOW, storedTree } from "./stored-tree.js";

const SHA = (n) => n.toString(16).padStart(64, "0");

test("a like is named after the track's artist and title", () => {
  const track = (title, app, name = "x/01 Song.flac") => ({ name, title, ...(app ? { app } : {}) });
  assert.equal(likeName(track("Song", { tags: { artist: "AC/DC" } }), []), "AC∕DC - Song.flac");
  assert.equal(likeName(track("Song", { tags: { artist: "", albumArtist: "VA" } }), []), "VA - Song.flac");
  assert.equal(likeName(track("Song"), ["Song.flac"]), "Song (2).flac");
});

test("likes, newest first", () => {
  const likes = [
    { name: "b", modified: "2026-10-24T00:00:00.000Z" },
    { name: "a", modified: "2026-10-25T00:00:00.000Z" },
    { name: "c", modified: "2026-10-24T00:00:00.000Z" },
  ];
  assert.deepEqual(newestFirst(likes).map((l) => l.name), ["a", "b", "c"]);
});

test("liking copies the track's entry, once, at the time it was liked; unliking removes it", async () => {
  const tx = storedTree({
    "artists/X/Y/01 One.mp3": { app: { type: "audio/mpeg", tags: { title: "One", artist: "X" } }, sha256: SHA(1) },
    "uploads/P/files/one.mp3": { app: { type: "audio/mpeg", tags: { title: "One", artist: "X" } }, sha256: SHA(1) },
    "uploads/P/files/two.mp3": { sha256: SHA(2) },
  });
  const [entry] = await tx.list(["artists", "X", "Y"]);
  const liked = await like(trackOf(entry, ["artists", "X", "Y"]), NOW)(tx);
  const likes = await liked.list(LIKES);
  assert.deepEqual(likes.map((l) => [l.name, l.id, l.modified]), [["X - One.mp3", entry.id, new Date(NOW).toISOString()]]);
  assert.deepEqual(likes[0].app, entry.app);
  assert.ok(isLiked(likes, SHA(1)));

  const [other] = (await tx.list(["uploads", "P", "files"])).filter((e) => e.name === "one.mp3");
  assert.equal(await like(trackOf(other, ["uploads", "P", "files"]), NOW + 1)(liked), liked, "the same bytes from elsewhere are liked already");
  const unliked = await unlike(SHA(1))(liked);
  assert.deepEqual(await unliked.list(LIKES), []);
});

test("likes whose bytes no package has any more", async () => {
  const tx = storedTree({ "uploads/P/files/one.mp3": { sha256: SHA(1) }, "uploads/Q/files/a/two.mp3": { sha256: SHA(2) } });
  const packages = await allPackages(tx.list);
  assert.deepEqual(packages.map((p) => [p.name, p.files.map((f) => f.path.join("/"))]), [["P", ["one.mp3"]], ["Q", ["a/two.mp3"]]]);
  const likes = [{ name: "a", sha256: SHA(1) }, { name: "b", sha256: SHA(3) }];
  assert.deepEqual(notInPackages(likes, packages).map((l) => l.name), ["b"]);
});

test("a like whose blob no package has takes a package's copy of its bytes, keeping its name and time", async () => {
  // As after a package was deleted and uploaded again: the like still has the old blob, the package a new one.
  const tx = storedTree({
    "uploads/P/files/one.mp3": { sha256: SHA(1) },
    "lists/likes/X - One.mp3": { sha256: SHA(1), modified: "2026-10-20T10:00:00.000Z" },
    "lists/likes/X - Gone.mp3": { sha256: SHA(9) },
  });
  const [copy] = await tx.list(["uploads", "P", "files"]);
  const moved = await repointLikes(tx);
  const likes = await moved.list(LIKES);
  const one = likes.find((l) => l.name === "X - One.mp3");
  assert.deepEqual([one.id, one.salt, one.modified, one.sha256], [copy.id, copy.salt, "2026-10-20T10:00:00.000Z", SHA(1)]);
  assert.notEqual(likes.find((l) => l.name === "X - Gone.mp3").id, copy.id, "bytes no package has stay where they are");
  assert.deepEqual(repointed(likes, await allPackages(moved.list)), [], "done once, nothing more to do");
});

test("a like whose blob a package still has stays, and a moved like takes the first package's copy", async () => {
  const tx = storedTree({ "uploads/A/files/one.mp3": { sha256: SHA(1) }, "uploads/B/files/one.mp3": { sha256: SHA(1) } });
  const [inB] = await tx.list(["uploads", "B", "files"]);
  const liked = await like(trackOf(inB, ["uploads", "B", "files"]), NOW)(tx);
  assert.deepEqual(repointed(await liked.list(LIKES), await allPackages(liked.list)), [], "B still has its blob");

  const [inA] = await tx.list(["uploads", "A", "files"]);
  const orphan = [{ ...(await liked.list(LIKES))[0], id: "f".repeat(64) }];
  assert.deepEqual(repointed(orphan, await allPackages(liked.list)).map(({ entry }) => entry.id), [inA.id]);
});

test("only the liked tracks, in their order", () => {
  const tracks = [{ name: "a", sha256: SHA(1) }, { name: "b", sha256: SHA(2) }, { name: "c", sha256: SHA(3) }, { name: "d" }];
  assert.deepEqual(onlyLiked(tracks, [{ sha256: SHA(3) }, { sha256: SHA(1) }, {}]).map((t) => t.name), ["a", "c"]);
  assert.deepEqual(onlyLiked(tracks, []), []);
});
