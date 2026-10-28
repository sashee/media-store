import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { filesInFolder, fromInput, picked, planUpload, stored } from "../../public/js/upload-plan.js";

const te = new TextEncoder();
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
};
function encode(value) {
  if (typeof value === "number") return te.encode(`i${value}e`);
  if (typeof value === "string") return encode(te.encode(value));
  if (value instanceof Uint8Array) return concat([te.encode(`${value.length}:`), value]);
  if (Array.isArray(value)) return concat([te.encode("l"), ...value.map(encode), te.encode("e")]);
  return concat([te.encode("d"), ...Object.keys(value).sort().flatMap((k) => [encode(k), encode(value[k])]), te.encode("e")]);
}
function torrentOf(name, files, pieceLength = 64) {
  const stream = concat(files.map((f) => f.bytes));
  const pieces = [];
  for (let at = 0; at < stream.length; at += pieceLength) pieces.push(new Uint8Array(createHash("sha1").update(stream.subarray(at, at + pieceLength)).digest()));
  return encode({ info: { name, "piece length": pieceLength, pieces: concat(pieces), files: files.map((f) => ({ length: f.bytes.length, path: f.path })) } });
}

const bytesOf = (length, seed) => Uint8Array.from({ length }, (_, i) => (i * 13 + seed * 5 + Math.floor(i / 40)) % 256);
const types = { flac: "audio/flac", mp3: "audio/mpeg", jpg: "image/jpeg", txt: "text/plain" };
/** A picked file, as picked() makes one. */
function pick(path, bytes) {
  const name = path.at(-1);
  return { name, size: bytes.length, type: types[name.split(".").pop()] ?? "", path, source: name, read: async (start, end) => bytes.slice(start, end) };
}
const rows = (plan) => plan.rows.map((row) => [row.path.join("/"), row.status, row.file?.name ?? null, row.tags === null ? "no tags" : "tags"]);

test("files picked one by one: all of them, flat, with tags read for the audio ones", async () => {
  const plan = await planUpload({ files: [pick(["b.mp3"], bytesOf(100, 1)), pick(["a.jpg"], bytesOf(10, 2)), pick(["b.mp3"], bytesOf(50, 3))] });
  assert.equal(plan.source, "files");
  assert.equal(plan.folder, null);
  assert.deepEqual(rows(plan), [["b.mp3", "new", "b.mp3", "tags"], ["a.jpg", "new", "a.jpg", "no tags"], ["b (2).mp3", "new", "b.mp3", "tags"]]);
  assert.ok(plan.rows.every(stored));
});

test("a folder: its files below it, keeping their folders", async () => {
  const plan = await planUpload({ files: [pick(["Album", "CD1", "01.flac"], bytesOf(100, 1)), pick(["Album", "cover.jpg"], bytesOf(10, 2))] });
  assert.equal(plan.source, "folder");
  assert.equal(plan.folder, "Album");
  assert.deepEqual(rows(plan).map(([path]) => path), ["CD1/01.flac", "cover.jpg"]);
});

test("with a torrent: its paths, what it confirms, what is missing, and what is left out", async () => {
  const intro = bytesOf(300, 1);
  const song = bytesOf(260, 2);
  const torrent = torrentOf("Album", [{ path: ["CD1", "01 Intro.flac"], bytes: intro }, { path: ["CD1", "02 Song.flac"], bytes: song }, { path: ["notes.txt"], bytes: bytesOf(30, 3) }]);
  const progress = [];
  const plan = await planUpload({ files: [pick(["track1.flac"], intro), pick(["extra.mp3"], bytesOf(77, 4))], torrent, onProgress: (text) => progress.push(text) });
  assert.equal(plan.source, "torrent");
  assert.equal(plan.torrent.name, "Album");
  assert.equal(plan.torrent.files, 3);
  assert.equal(plan.into, null);
  assert.deepEqual(rows(plan), [
    ["CD1/01 Intro.flac", "checked", "track1.flac", "tags"],
    ["CD1/02 Song.flac", "missing", null, "tags"],
    ["notes.txt", "missing", null, "no tags"],
    ["extra.mp3", "unused", "extra.mp3", "tags"],
  ]);
  assert.deepEqual(plan.rows.filter(stored).map((row) => row.path.join("/")), ["CD1/01 Intro.flac"]);
  assert.ok(progress.includes("Reading the torrent"));
  assert.ok(progress.some((text) => text.startsWith("Checking files against the torrent")));
});

test("a torrent a package already holds completes that package, and what it has isn't stored again", async () => {
  const intro = bytesOf(300, 1);
  const song = bytesOf(260, 2);
  const torrent = torrentOf("Album", [{ path: ["01 Intro.flac"], bytes: intro }, { path: ["02 Song.flac"], bytes: song }]);
  let asked = null;
  const findPackage = async (id) => {
    asked = id;
    return { name: "Album", present: new Set(["01 Intro.flac"]) };
  };
  const plan = await planUpload({ files: [pick(["a.flac"], intro), pick(["b.flac"], song)], torrent, findPackage });
  assert.match(asked, /^[0-9a-f]{40}$/);
  assert.equal(plan.into, "Album");
  assert.deepEqual(rows(plan).map(([path, status]) => [path, status]), [["01 Intro.flac", "present"], ["02 Song.flac", "checked"]]);
});

// ---------------------------------------------------------------- picking

const folderHandle = (name, entries) => ({ kind: "directory", name, values: async function* () { yield* entries; } });
const fileHandle = (name, text) => ({ kind: "file", name, getFile: async () => new File([text], name) });

test("a folder picked with showDirectoryPicker gives its files with their paths, from the folder's name down", async () => {
  const album = folderHandle("Album", [fileHandle("cover.jpg", "c"), folderHandle("CD2", [fileHandle("01 Two.flac", "b")]), fileHandle("01 One.flac", "a")]);
  const found = await filesInFolder(album);
  assert.deepEqual(
    found.map(({ file, path }) => [path.join("/"), file.name]),
    [["Album/cover.jpg", "cover.jpg"], ["Album/CD2/01 Two.flac", "01 Two.flac"], ["Album/01 One.flac", "01 One.flac"]],
  );
  assert.deepEqual(picked(found[1]).path, ["Album", "CD2", "01 Two.flac"]);
});

test("a file from an input is at its folder's relative path, or at its name alone", () => {
  const loose = new File(["x"], "a.flac");
  assert.deepEqual(fromInput(loose).path, ["a.flac"]);
  const inFolder = Object.defineProperty(new File(["x"], "b.flac"), "webkitRelativePath", { value: "Album/CD1/b.flac" });
  assert.deepEqual(fromInput(inFolder).path, ["Album", "CD1", "b.flac"]);
});
