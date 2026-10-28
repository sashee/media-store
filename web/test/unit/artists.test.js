import { test } from "node:test";
import assert from "node:assert/strict";

import { ARTISTS, sortArtists } from "../../public/js/artists.js";
import { deletePackage, setSorting } from "../../public/js/packages.js";
import { filesAt, storedTree } from "./stored-tree.js";

const SHA = (n) => n.toString(16).padStart(64, "0");
const track = (fields, extra = {}) => ({ app: { type: "audio/mpeg", tags: { title: "", artist: "", albumArtist: "", album: "", track: null, ...fields } }, ...extra });
const layout = async (tx) => Object.fromEntries(Object.entries(await filesAt(tx, ARTISTS)).map(([path, entry]) => [path, entry.id]));

const library = () =>
  storedTree({
    "uploads/Album/files/01.mp3": track({ artist: "X", album: "Y", title: "One", track: 1 }),
    "uploads/Album/files/02.mp3": track({ artist: "X", album: "Y", title: "Two", track: 2 }, { sha256: SHA(2) }),
    "uploads/Album/files/cover.jpg": { app: { type: "image/jpeg" } },
    "uploads/Album/package.json": {},
    "uploads/Again/files/b.mp3": track({ artist: "X", album: "Y", title: "Two", track: 2 }, { sha256: SHA(2) }),
    "uploads/Again/package.json": {},
  });

test("sorting copies the packages' tracks into artists/, the same entries, and the same bytes once", async () => {
  const before = library();
  const sorted = await sortArtists(before);
  const ids = Object.fromEntries(Object.entries(await filesAt(before, ["uploads"])).map(([path, entry]) => [path, entry.id]));
  assert.deepEqual(await layout(sorted), {
    "X/Y/01 One.mp3": ids["Album/files/01.mp3"],
    "X/Y/02 Two.mp3": ids["Again/files/b.mp3"],
    "X/Y/cover.jpg": ids["Album/files/cover.jpg"],
  });
  const copy = await sorted.entry([...ARTISTS, "X", "Y", "01 One.mp3"]);
  assert.deepEqual(copy.app, (await before.entry(["uploads", "Album", "files", "01.mp3"])).app, "a copy keeps the entry's app data");
  assert.equal(await sortArtists(sorted), sorted, "sorted again, nothing changes");
});

test("a deleted package's copies go, a duplicate it hid comes back, and empty folders go", async () => {
  const sorted = await sortArtists(library());
  const ids = Object.fromEntries(Object.entries(await filesAt(sorted, ["uploads"])).map(([path, entry]) => [path, entry.id]));
  const withoutAgain = await sortArtists(await deletePackage("Again")(sorted));
  assert.deepEqual(await layout(withoutAgain), {
    "X/Y/01 One.mp3": ids["Album/files/01.mp3"],
    "X/Y/02 Two.mp3": ids["Album/files/02.mp3"],
    "X/Y/cover.jpg": ids["Album/files/cover.jpg"],
  });
  const empty = await sortArtists(await deletePackage("Album")(withoutAgain));
  assert.deepEqual(await empty.list(ARTISTS), []);
});

test("what the user sets for a package's files moves their copies", async () => {
  const sorted = await sortArtists(library());
  const set = await setSorting("Album", [{ path: ["01.mp3"], sort: { artist: "Someone" } }, { path: ["gone.mp3"], sort: { album: "Z" } }])(sorted);
  assert.deepEqual((await set.entry(["uploads", "Album", "files", "01.mp3"])).app.sort, { artist: "Someone" });
  const moved = await sortArtists(set);
  assert.deepEqual(Object.keys(await layout(moved)), ["Someone/Y/01 One.mp3", "Someone/Y/cover.jpg", "X/Y/02 Two.mp3"]);
  const back = await setSorting("Album", [{ path: ["01.mp3"], sort: {} }])(moved);
  assert.equal((await back.entry(["uploads", "Album", "files", "01.mp3"])).app.sort, undefined);
  assert.equal(await setSorting("Album", [{ path: ["02.mp3"], sort: {} }])(back), back, "nothing set, nothing written");
});

test("a large library sorts without running out of stack", async () => {
  const files = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`uploads/P${i % 50}/files/${i}.mp3`, track({ artist: `A${i % 300}`, album: `B${i % 7}`, title: `T${i}` })]));
  const sorted = await sortArtists(storedTree(files));
  assert.equal(Object.keys(await filesAt(sorted, ARTISTS)).length, 5000);
});
