import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { BencodeError, decode } from "../../public/js/bencode.js";
import { fitFiles, piecesRoot, readTorrent } from "../../public/js/torrent.js";

// ---------------------------------------------------------------- building torrents, independently of the code under test

const te = new TextEncoder();
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
};
const sha = (algorithm, bytes) => new Uint8Array(createHash(algorithm).update(bytes).digest());

/** Bencodes numbers, strings (as UTF-8), bytes, arrays and objects (keys sorted, as BEP 3 says). */
function encode(value) {
  if (typeof value === "number") return te.encode(`i${value}e`);
  if (typeof value === "string") return encode(te.encode(value));
  if (value instanceof Uint8Array) return concat([te.encode(`${value.length}:`), value]);
  if (Array.isArray(value)) return concat([te.encode("l"), ...value.map(encode), te.encode("e")]);
  const keys = Object.keys(value).sort();
  return concat([te.encode("d"), ...keys.flatMap((key) => [encode(key), encode(value[key])]), te.encode("e")]);
}

const BLOCK = 16 * 1024;
function merkle(bytes) {
  const leaves = [];
  for (let at = 0; at < bytes.length; at += BLOCK) leaves.push(sha("sha256", bytes.subarray(at, at + BLOCK)));
  let width = 1;
  while (width < leaves.length) width *= 2;
  let layer = [...leaves, ...Array.from({ length: width - leaves.length }, () => new Uint8Array(32))];
  while (layer.length > 1) layer = Array.from({ length: layer.length / 2 }, (_, i) => sha("sha256", concat([layer[2 * i], layer[2 * i + 1]])));
  return layer[0];
}

/**
 * A torrent of `files` ({ path: [names], bytes, padding }) in folder `name`: v1 (with pieces of `pieceLength`), v2,
 * or both. A single file with `single` is a single-file torrent.
 */
function makeTorrent({ name = "Album", files, pieceLength = 64, v1 = true, v2 = false, single = false }) {
  const stream = concat(files.map((f) => f.bytes));
  const pieces = [];
  for (let at = 0; at < stream.length; at += pieceLength) pieces.push(sha("sha1", stream.subarray(at, at + pieceLength)));
  const info = { name, "piece length": pieceLength };
  if (v1) {
    info.pieces = concat(pieces);
    if (single) info.length = files[0].bytes.length;
    else info.files = files.map((f) => ({ length: f.bytes.length, path: f.path, ...(f.padding ? { attr: "p" } : {}) }));
  }
  if (v2) {
    info["meta version"] = 2;
    const tree = {};
    for (const f of files.filter((f) => !f.padding)) {
      const path = single ? [name] : f.path;
      const leaf = path.slice(0, -1).reduce((node, part) => (node[part] ??= {}), tree);
      leaf[path.at(-1)] = { "": { length: f.bytes.length, ...(f.bytes.length ? { "pieces root": merkle(f.bytes) } : {}) } };
    }
    info["file tree"] = tree;
  }
  const bytes = encode({ announce: "https://tracker.example/announce?passkey=secret", info });
  return { bytes, infoHash: sha(v1 ? "sha1" : "sha256", encode(info)) };
}

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const bytesOf = (length, seed) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 7 + Math.floor(i / 50)) % 256);
/** A selected file, as the page has it: a name, a size, and a way to read it. */
const picked = (name, bytes) => ({ name, size: bytes.length, read: async (start, end) => bytes.slice(start, end) });
const summary = ({ placed, missing, unused }) => ({
  placed: placed.map(({ entry, file, check }) => [entry.path.join("/"), file.name, check]),
  missing: missing.map((entry) => entry.path.join("/")),
  unused: unused.map((file) => file.name),
});

// ---------------------------------------------------------------- bencode

test("bencode: values, the spans of the top-level keys, and what isn't bencode", () => {
  const input = te.encode("d3:agei42e4:infod1:xli1ei-2eee4:name5:Hello1:z0:e");
  const { value, spans } = decode(input);
  assert.equal(value.get("age"), 42);
  assert.deepEqual(value.get("info").get("x"), [1, -2]);
  assert.equal(new TextDecoder().decode(value.get("name")), "Hello");
  assert.deepEqual(value.get("z"), new Uint8Array(0));
  const [start, end] = spans.get("info");
  assert.equal(new TextDecoder().decode(input.subarray(start, end)), "d1:xli1ei-2eee");
  assert.equal(decode(te.encode("d9:__proto__i1ee")).value.get("__proto__"), 1, "keys are only keys");

  for (const bad of ["i01e", "i-0e", "i1", "5:abc", "le e", "d1:ai1e1:ai2ee", "i1ei2e", "x", "", "d1:ae", "i99999999999999999999e"]) {
    assert.throws(() => decode(te.encode(bad)), BencodeError, bad);
  }
  assert.throws(() => decode(te.encode("l".repeat(200) + "e".repeat(200))), /nested too deeply/);
});

// ---------------------------------------------------------------- reading torrents

test("a v1 multi-file torrent: paths below its folder, offsets in the joined stream, padding marked, its infohash", async () => {
  const files = [
    { path: ["CD1", "01 Intro.flac"], bytes: bytesOf(100, 1) },
    { path: [".pad", "28"], bytes: new Uint8Array(28), padding: true },
    { path: ["cover.jpg"], bytes: bytesOf(20, 2) },
  ];
  const { bytes, infoHash } = makeTorrent({ files });
  const torrent = await readTorrent(bytes);
  assert.equal(torrent.name, "Album");
  assert.equal(torrent.id, hex(infoHash));
  assert.equal(torrent.pieceLength, 64);
  assert.deepEqual(
    torrent.files.map(({ path, length, offset, padding, piecesRoot }) => [path.join("/"), length, offset, padding, piecesRoot]),
    [["CD1/01 Intro.flac", 100, 0, false, null], [".pad/28", 28, 100, true, null], ["cover.jpg", 20, 128, false, null]],
  );
});

test("a single-file torrent's one path is its name; v2 and hybrid torrents carry each file's own hash", async () => {
  const single = await readTorrent(makeTorrent({ name: "song.mp3", files: [{ path: ["song.mp3"], bytes: bytesOf(10, 1) }], single: true }).bytes);
  assert.deepEqual(single.files.map((f) => f.path), [["song.mp3"]]);

  const files = [{ path: ["a.flac"], bytes: bytesOf(40_000, 1) }, { path: ["sub", "b.txt"], bytes: bytesOf(5, 2) }];
  const v2 = makeTorrent({ files, v1: false, v2: true });
  const onlyV2 = await readTorrent(v2.bytes);
  assert.equal(onlyV2.id, hex(v2.infoHash), "v2's infohash, SHA-256, when there is no v1");
  assert.equal(onlyV2.pieces, null);
  assert.deepEqual(onlyV2.files.map((f) => [f.path.join("/"), f.offset, hex(f.piecesRoot)]), [["a.flac", null, hex(merkle(files[0].bytes))], ["sub/b.txt", null, hex(merkle(files[1].bytes))]]);

  const hybrid = await readTorrent(makeTorrent({ files, v2: true }).bytes);
  assert.deepEqual(hybrid.files.map((f) => [f.path.join("/"), f.offset, hex(f.piecesRoot)]), [["a.flac", 0, hex(merkle(files[0].bytes))], ["sub/b.txt", 40_000, hex(merkle(files[1].bytes))]]);
});

test("what isn't a torrent is refused", async () => {
  for (const bad of [te.encode("d4:spami1ee"), encode({ info: { name: "x", "piece length": 64 } }), encode({ info: { name: "x", "piece length": 0, length: 1, pieces: new Uint8Array(20) } }), encode({ info: { name: "x", "piece length": 64, length: 1, pieces: new Uint8Array(7) } })]) {
    await assert.rejects(readTorrent(bad), BencodeError);
  }
});

test("v2's root of a file: one block is its hash; more are a tree padded to a power of two", async () => {
  const read = (bytes) => async (start, end) => bytes.slice(start, end);
  const small = bytesOf(1000, 3);
  assert.deepEqual(await piecesRoot(read(small), small.length), sha("sha256", small));
  const three = bytesOf(3 * BLOCK + 5, 4);
  assert.deepEqual(await piecesRoot(read(three), three.length), merkle(three));
});

// ---------------------------------------------------------------- fitting files

test("files are fitted by their bytes, whatever they were called; extras are left out and missing ones listed", async () => {
  const intro = bytesOf(300, 1);
  const song = bytesOf(250, 2);
  const torrent = await readTorrent(makeTorrent({ files: [{ path: ["CD1", "01 Intro.flac"], bytes: intro }, { path: ["CD1", "02 Song.flac"], bytes: song }, { path: ["CD2", "01 Other.flac"], bytes: bytesOf(400, 3) }] }).bytes);
  const result = await fitFiles(torrent, [picked("track1.flac", intro), picked("track2.flac", song), picked("notes.txt", bytesOf(12, 9))]);
  assert.deepEqual(summary(result), {
    placed: [["CD1/01 Intro.flac", "track1.flac", "hash"], ["CD1/02 Song.flac", "track2.flac", "hash"]],
    missing: ["CD2/01 Other.flac"],
    unused: ["notes.txt"],
  });
});

test("a file of the right size but other bytes is left out", async () => {
  const torrent = await readTorrent(makeTorrent({ files: [{ path: ["a.flac"], bytes: bytesOf(300, 1) }] }).bytes);
  assert.deepEqual(summary(await fitFiles(torrent, [picked("a.flac", bytesOf(300, 2))])), { placed: [], missing: ["a.flac"], unused: ["a.flac"] });
});

test("a small file is checked by the piece it shares with its neighbours, when they are there", async () => {
  const files = [{ path: ["01.flac"], bytes: bytesOf(150, 1) }, { path: ["cover.jpg"], bytes: bytesOf(20, 2) }, { path: ["02.flac"], bytes: bytesOf(150, 3) }];
  const torrent = await readTorrent(makeTorrent({ files }).bytes);
  const all = (cover) => [picked("x.flac", files[0].bytes), picked("folder.jpg", cover), picked("y.flac", files[2].bytes)];
  assert.deepEqual(summary(await fitFiles(torrent, all(files[1].bytes))).placed, [["01.flac", "x.flac", "hash"], ["cover.jpg", "folder.jpg", "hash"], ["02.flac", "y.flac", "hash"]]);

  const wrongCover = await fitFiles(torrent, all(bytesOf(20, 7)));
  assert.deepEqual(summary(wrongCover).missing, ["cover.jpg"], "with its neighbours there, a wrong small file is caught");

  const alone = await fitFiles(torrent, [picked("cover.jpg", bytesOf(20, 7))]);
  assert.deepEqual(summary(alone).placed, [["cover.jpg", "cover.jpg", "size"]], "alone, only its size can tell, and the result says so");
});

test("padding files (BEP 47) are skipped and their zeros checked", async () => {
  const files = [{ path: ["a.flac"], bytes: bytesOf(100, 1) }, { path: [".pad", "28"], bytes: new Uint8Array(28), padding: true }, { path: ["small.txt"], bytes: bytesOf(10, 2) }];
  const torrent = await readTorrent(makeTorrent({ files }).bytes);
  const result = await fitFiles(torrent, [picked("a.flac", files[0].bytes), picked("small.txt", files[2].bytes)]);
  assert.deepEqual(summary(result), { placed: [["a.flac", "a.flac", "hash"], ["small.txt", "small.txt", "hash"]], missing: [], unused: [] });
});

test("bytes the torrent holds twice are filled from one file", async () => {
  const cover = bytesOf(200, 5);
  const torrent = await readTorrent(makeTorrent({ files: [{ path: ["CD1", "cover.jpg"], bytes: cover }, { path: ["CD2", "cover.jpg"], bytes: cover }], v1: false, v2: true }).bytes);
  assert.deepEqual(summary(await fitFiles(torrent, [picked("cover.jpg", cover)])).placed, [["CD1/cover.jpg", "cover.jpg", "hash"], ["CD2/cover.jpg", "cover.jpg", "hash"]]);
});

test("v2 checks every file by its own hash", async () => {
  const files = [{ path: ["a.flac"], bytes: bytesOf(40_000, 1) }, { path: ["b.txt"], bytes: bytesOf(5, 2) }];
  const torrent = await readTorrent(makeTorrent({ files, v1: false, v2: true }).bytes);
  assert.deepEqual(summary(await fitFiles(torrent, [picked("one", files[0].bytes), picked("two", files[1].bytes)])).placed, [["a.flac", "one", "hash"], ["b.txt", "two", "hash"]]);
  assert.deepEqual(summary(await fitFiles(torrent, [picked("b.txt", bytesOf(5, 9))])).missing, ["a.flac", "b.txt"]);
});

test("among files of the same size that hashes can't tell apart, the one with the entry's name is chosen", async () => {
  const torrent = await readTorrent(makeTorrent({ pieceLength: 1024, files: [{ path: ["a.txt"], bytes: bytesOf(10, 1) }, { path: ["b.txt"], bytes: bytesOf(10, 2) }] }).bytes);
  const result = await fitFiles(torrent, [picked("b.txt", bytesOf(10, 2)), picked("a.txt", bytesOf(10, 1))]);
  assert.deepEqual(summary(result).placed, [["a.txt", "a.txt", "hash"], ["b.txt", "b.txt", "hash"]], "together, their shared piece confirms both");
  const guessed = await fitFiles(torrent, [picked("b.txt", bytesOf(10, 2))]);
  assert.deepEqual(summary(guessed).placed, [["b.txt", "b.txt", "size"]]);
});

test("checking reports its progress", async () => {
  const bytes = bytesOf(300, 1);
  const torrent = await readTorrent(makeTorrent({ files: [{ path: ["a.flac"], bytes }] }).bytes);
  const seen = [];
  await fitFiles(torrent, [picked("a.flac", bytes)], { onProgress: (done, total) => seen.push([done, total]) });
  assert.deepEqual(seen, [[1, 1]]);
});
