import { test } from "node:test";
import assert from "node:assert/strict";

import { begin, emptyRoot, uploads } from "../../public/sdk/tree.js";
import { commonFolder, defaultPackageName, deletePackage, packageDoc, packagePaths, readPackageDoc, savePackage } from "../../public/js/packages.js";

const NOW = Date.UTC(2026, 9, 25, 10, 0, 0);
/** A transaction on an empty tree; nothing here reaches the I/O. */
const fresh = () => begin(emptyRoot(1), {}, NOW);
const blob = (text) => new Blob([text]);
const names = async (tx, path) => (await tx.list(path)).map((entry) => entry.name);

test("a package is named after its torrent, its folder, its album, or the day", () => {
  assert.equal(defaultPackageName({ torrent: { name: "Release (2020) [FLAC]" }, folder: "x", now: NOW }), "Release (2020) [FLAC]");
  assert.equal(defaultPackageName({ folder: "Mutter", tags: [{ album: "Other" }], now: NOW }), "Mutter");
  assert.equal(defaultPackageName({ tags: [{ album: "A" }, { album: "B" }, { album: "B" }, { album: "" }], now: NOW }), "B");
  assert.equal(defaultPackageName({ now: NOW }), "Upload 2026-10-25");
  assert.equal(defaultPackageName({ folder: "a/b", now: NOW }), "ab");
});

test("a folder's files go below it; names are cleaned, and made unique in their folder", () => {
  assert.equal(commonFolder([["Album", "01.flac"], ["Album", "CD2", "01.flac"]]), "Album");
  assert.equal(commonFolder([["Album", "01.flac"], ["Other", "01.flac"]]), null);
  assert.equal(commonFolder([["01.flac"]]), null);
  assert.deepEqual(packagePaths([["Album", "01.flac"], ["Album", "CD2", "01.flac"]]), [["01.flac"], ["CD2", "01.flac"]]);
  assert.deepEqual(packagePaths([["song.mp3"], ["song.mp3"], ["bad\u0001name.mp3"]]), [["song.mp3"], ["song (2).mp3"], ["badname.mp3"]]);
});

test("package.json says what the package is, and only a valid one is read back", () => {
  const doc = packageDoc({ name: "P", source: "torrent", torrent: { name: "T", id: "ab", files: 3, extra: 1 }, files: [{ size: 10 }, { size: 5 }], missing: ["c.flac"], uploaded: NOW });
  assert.deepEqual(doc, {
    version: 1,
    name: "P",
    uploaded: "2026-10-25T10:00:00.000Z",
    updated: "2026-10-25T10:00:00.000Z",
    source: "torrent",
    torrent: { name: "T", id: "ab", files: 3 },
    files: 2,
    bytes: 15,
    missing: ["c.flac"],
  });
  assert.deepEqual(readPackageDoc(new TextEncoder().encode(JSON.stringify(doc))), doc);
  for (const bad of ["not json", "{}", JSON.stringify({ ...doc, version: 2 }), JSON.stringify({ ...doc, missing: null })]) {
    assert.equal(readPackageDoc(new TextEncoder().encode(bad)), null, bad);
  }
});

test("saving a package: its files offloadable at their paths, its documents not, and a name no other package has", async () => {
  const files = [
    { path: ["01 Intro.flac"], source: blob("one"), app: { type: "audio/flac", tags: { title: "Intro" } } },
    { path: ["CD2", "01 Other.flac"], source: blob("two"), app: { type: "audio/flac" } },
  ];
  const doc = packageDoc({ name: "Album", source: "folder", files: files.map(({ source }) => source), uploaded: NOW });
  const once = await savePackage({ name: "Album", files, doc })(fresh());
  const twice = await savePackage({ name: "Album", files: files.slice(0, 1), doc, torrent: new Uint8Array([1, 2]) })(once);
  assert.deepEqual(await names(twice, ["uploads"]), ["Album", "Album (2)"]);
  assert.deepEqual(await names(twice, ["uploads", "Album"]), ["files", "package.json"]);
  assert.deepEqual(await names(twice, ["uploads", "Album (2)"]), ["files", "package.json", "package.torrent"]);
  assert.deepEqual(await names(twice, ["uploads", "Album", "files", "CD2"]), ["01 Other.flac"]);
  assert.deepEqual((await twice.entry(["uploads", "Album", "files", "01 Intro.flac"])).app, files[0].app);
  const saved = JSON.parse(await (await twice.read(["uploads", "Album (2)", "package.json"]).then((b) => new Blob([b]).text())));
  assert.equal(saved.name, "Album (2)", "package.json has the name it got");
  const flags = new Map((await uploads(twice)).map(({ source, offloadable }) => [source, offloadable]));
  assert.equal(flags.get(files[0].source), true);
  assert.equal([...flags].filter(([, offloadable]) => !offloadable).length, 3, "two package.json and a torrent stay in the database");
});

test("completing a package adds to it under its own name; deleting one removes all of it", async () => {
  const doc = packageDoc({ name: "Album", source: "torrent", files: [], uploaded: NOW });
  const first = await savePackage({ name: "Album", files: [{ path: ["a.flac"], source: blob("a"), app: {} }], doc })(fresh());
  const completed = await savePackage({ name: "ignored", into: "Album", files: [{ path: ["b.flac"], source: blob("b"), app: {} }], doc })(first);
  assert.deepEqual(await names(completed, ["uploads"]), ["Album"]);
  assert.deepEqual(await names(completed, ["uploads", "Album", "files"]), ["a.flac", "b.flac"]);
  assert.deepEqual(await names(await deletePackage("Album")(completed), []), ["uploads"]);
  assert.deepEqual(await names(await deletePackage("Album")(completed), ["uploads"]), []);
});
