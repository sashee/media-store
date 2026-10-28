import { test } from "node:test";
import assert from "node:assert/strict";

import { NO_TAGS } from "../../public/js/tags.js";
import { albumGroups, discOfPath, packageTargets, regroup, shownTarget, sortLibrary, sortTarget, treeChanges, UNKNOWN_ARTIST } from "../../public/js/sorting.js";

const tags = (fields = {}) => ({ ...NO_TAGS, ...fields });
const target = (fields, path, packageName = "Package") => shownTarget(sortTarget({ tags: tags(fields), path, packageName }));

test("tags decide: album artist before artist, the track number two digits wide", () => {
  assert.equal(target({ title: "Sonne", artist: "Rammstein", album: "Mutter", track: 2 }, ["x.flac"]), "Rammstein / Mutter / 02 Sonne.flac");
  assert.equal(target({ title: "Song", artist: "Guest", albumArtist: "Various Artists", album: "Hits", track: 12 }, ["a.mp3"]), "Various Artists / Hits / 12 Song.mp3");
});

test("a multi-disc album puts the disc first, by its tags or its folder", () => {
  assert.equal(target({ title: "A", artist: "X", album: "Y", track: 1, disc: 1, discTotal: 2 }, ["a.flac"]), "X / Y / 1-01 A.flac");
  assert.equal(target({ title: "B", artist: "X", album: "Y", track: 3 }, ["CD2", "b.flac"]), "X / Y / 2-03 B.flac");
  assert.equal(target({ title: "C", artist: "X", album: "Y", track: 3, disc: 1 }, ["c.flac"]), "X / Y / 03 C.flac", "disc 1 of an album of one disc");
  assert.equal(discOfPath(["Album", "Disc 3", "x.mp3"]), 3);
  assert.equal(discOfPath(["Album", "x.mp3"]), null);
});

test("without tags: the folders and the file name, then the package's name and an unknown artist", () => {
  assert.equal(target({}, ["Rammstein", "Mutter", "02 - Sonne.flac"]), "Rammstein / Mutter / 02 Sonne.flac");
  assert.equal(target({}, ["Mutter", "CD1", "1. Mein Herz brennt.mp3"]), `${UNKNOWN_ARTIST} / Mutter / 1-01 Mein Herz brennt.mp3`);
  assert.equal(target({}, ["track.wav"], "My upload"), `${UNKNOWN_ARTIST} / My upload / track.wav`);
  assert.equal(target({ track: 7 }, ["05 Other.wav"]), `${UNKNOWN_ARTIST} / Package / 07 Other.wav`, "the tag's number wins");
});

test("slashes in tags read the same and can't make a folder", () => {
  const { artist, name } = sortTarget({ tags: tags({ artist: "AC/DC", album: "Back in Black", title: "Hells Bells / Shoot", track: 1 }), path: ["x.mp3"], packageName: "p" });
  assert.equal(artist, "AC∕DC");
  assert.equal(name, "01 Hells Bells ∕ Shoot.mp3");
});

test("what the user set wins over the tags and the folders", () => {
  const sorted = sortTarget({ tags: tags({ artist: "Wrong", album: "Album", title: "T", track: 1 }), path: ["x.mp3"], packageName: "P", sort: { artist: "Right/Here" } });
  assert.equal(shownTarget(sorted), "Right∕Here / Album / 01 T.mp3");
});

const file = (path, fields = {}, sort = {}) => ({ path, tags: tags(fields), sort });
const shown = (targets) => targets.map(shownTarget);

test("a package's untagged tracks get the artist and album their folder's tagged tracks agree on", () => {
  const files = [
    file(["Album", "01 One.mp3"], { artist: "X", album: "Y", title: "One", track: 1 }),
    file(["Album", "02 Two.mp3"]),
    file(["Album", "CD2", "01 Three.mp3"], { albumArtist: "X" }),
    file(["Singles", "a.mp3"], { artist: "A" }),
    file(["Singles", "b.mp3"], { artist: "B" }),
    file(["Singles", "c.mp3"]),
  ];
  assert.deepEqual(shown(packageTargets({ packageName: "P", files })), [
    "X / Y / 01 One.mp3",
    "X / Y / 02 Two.mp3",
    "X / Y / 2-01 Three.mp3",
    "A / Singles / a.mp3",
    "B / Singles / b.mp3",
    `${UNKNOWN_ARTIST} / Singles / c.mp3`,
  ]);
});

test("albums are grouped in the order they come; setting one keeps only what differs from the tags", () => {
  const files = [file(["01.mp3"], { artist: "X", album: "Y" }), file(["02.mp3"]), file(["other", "03.mp3"], { artist: "Z", album: "W" })];
  const targets = packageTargets({ packageName: "P", files });
  assert.deepEqual(albumGroups(targets), [{ artist: "X", album: "Y", tracks: 2 }, { artist: "Z", album: "W", tracks: 1 }]);

  const set = regroup({ packageName: "P", files, group: { artist: "X", album: "Y" }, to: { artist: "Someone", album: "Y" } });
  assert.deepEqual(set.map((f) => f.sort), [{ artist: "Someone" }, { artist: "Someone" }, {}]);
  assert.deepEqual(shown(packageTargets({ packageName: "P", files: set })).slice(0, 2), ["Someone / Y / 01.mp3", "Someone / Y / 02.mp3"]);

  const back = regroup({ packageName: "P", files: set, group: { artist: "Someone", album: "Y" }, to: { artist: "", album: "" } });
  assert.deepEqual(back.map((f) => f.sort), [{}, {}, {}], "empty fields go back to the tags'");
  assert.deepEqual(regroup({ packageName: "P", files, group: { artist: "Z", album: "W" }, to: { artist: "Z", album: "W/2" } })[2].sort, { album: "W/2" });
});

const ID = (n) => n.toString(16).padStart(64, "0");
/** A stored file entry: `name`, its SHA-256 from `bytes`, its `app`. */
const stored = (name, bytes, app = {}) => ({ kind: "file", name, id: ID(Math.floor(Math.random() * 1e9)), salt: "0".repeat(32), size: 1, sha256: ID(bytes), modified: "2026-10-24T00:00:00.000Z", app });
const audio = (name, bytes, fields = {}, sort) => stored(name, bytes, { type: "audio/mpeg", tags: tags(fields), ...(sort ? { sort } : {}) });
const pkg = (name, files) => ({ name, files: files.map(([path, entry]) => ({ path: path.split("/"), entry: { ...entry, name: path.split("/").at(-1) } })) });
const layout = (wanted) => wanted.map(({ path, entry }) => [path.join(" / "), entry.sha256.replace(/^0+/, "")]);

test("the library sorted: copies of the tracks, the same bytes once, names made unique, covers next to them", () => {
  const packages = [
    pkg("B package", [
      ["01 Song.mp3", audio("", 1, { artist: "X", album: "Y", title: "Song", track: 1 })],
      ["dup.mp3", audio("", 2, { artist: "X", album: "Y", title: "Again", track: 2 })],
      ["Folder.jpg", stored("", 9, { type: "image/jpeg" })],
    ]),
    pkg("A package", [
      ["CD1/01.mp3", audio("", 2, { artist: "X", album: "Y", title: "Again", track: 2 })],
      ["CD1/02.mp3", audio("", 3, { artist: "X", album: "Y", title: "Song", track: 1 })],
      ["CD1/cover.png", stored("", 7, { type: "image/png" })],
      ["front.jpg", stored("", 8, { type: "image/jpeg" })],
      ["notes.txt", stored("", 6, { type: "text/plain" })],
      ["list.m3u", stored("", 5, { type: "audio/x-mpegurl" })],
    ]),
  ];
  assert.deepEqual(layout(sortLibrary(packages)), [
    ["X / Y / 1-02 Again.mp3", "2"],
    ["X / Y / 1-01 Song.mp3", "3"],
    ["X / Y / 01 Song.mp3", "1"],
    ["X / Y / cover.png", "7"],
  ]);
});

test("a package's set sorting and its unknown files", () => {
  const packages = [pkg("P", [["a.mp3", audio("", 1, {}, { artist: "Me", album: "Mine" })], ["b.mp3", audio("", 2)], ["sub/cover.jpg", stored("", 3, { type: "image/jpeg" })]])];
  assert.deepEqual(layout(sortLibrary(packages)), [["Me / Mine / a.mp3", "1"], [`${UNKNOWN_ARTIST} / P / b.mp3`, "2"]], "a cover in another folder isn't the album's");
});

test("the changes from one tree to another: whole folders out, only what differs in", () => {
  const entry = (n, extra = {}) => ({ kind: "file", id: ID(n), salt: "0".repeat(32), modified: "2026-10-24T00:00:00.000Z", ...extra });
  const dir = { kind: "dir" };
  const current = [
    { path: ["X"], entry: dir },
    { path: ["X", "Y"], entry: dir },
    { path: ["X", "Y", "01.mp3"], entry: entry(1) },
    { path: ["X", "Y", "02.mp3"], entry: entry(2) },
    { path: ["X", "Y", "03.mp3"], entry: entry(3) },
    { path: ["X", "Old"], entry: dir },
    { path: ["X", "Old", "01.mp3"], entry: entry(4) },
    { path: ["Gone"], entry: dir },
    { path: ["Gone", "Z"], entry: dir },
    { path: ["Gone", "Z", "01.mp3"], entry: entry(5) },
    { path: ["stray.txt"], entry: entry(6) },
  ];
  const wanted = [
    { path: ["X", "Y", "01.mp3"], entry: entry(1) },
    { path: ["X", "Y", "02.mp3"], entry: entry(2, { app: { sort: { album: "Y" } } }) },
    { path: ["X", "New", "01.mp3"], entry: entry(7) },
  ];
  const { remove, put } = treeChanges(current, wanted);
  assert.deepEqual(remove, [["X", "Y", "03.mp3"], ["X", "Old"], ["Gone"], ["stray.txt"]]);
  assert.deepEqual(put.map(({ path }) => path.join("/")), ["X/Y/02.mp3", "X/New/01.mp3"]);
  assert.deepEqual(treeChanges(wanted, wanted), { remove: [], put: [] });
});
