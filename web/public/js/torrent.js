// Torrents as the shape of a package (SPEC §5.2): a .torrent file says which files a release has, where, and what their
// bytes hash to. The selected files are fitted to it by size and hash, wherever and under whatever name they were
// picked. Nothing is downloaded and nothing is contacted: the torrent is only read.
//
// v1 torrents (BEP 3) hash pieces of all the files joined together, so a file is checked by the pieces wholly inside
// it, and a small file only when the files it shares a piece with are there too. v2 torrents (BEP 52) hash each file on
// its own. Hybrid torrents have both.

import { hexEncode } from "../sdk/crypto.js";
import { BencodeError, decode, text } from "./bencode.js";

/** v1's piece hashes are SHA-1; v2's leaves are SHA-256 of 16 KiB blocks. */
const SHA1_LENGTH = 20;
const V2_BLOCK = 16 * 1024;
/** How many pieces wholly inside a file are checked: the first, the middle and the last are plenty to tell. */
const PIECES_CHECKED = 3;

const digest = async (algorithm, bytes) => new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
const equal = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

const get = (map, key) => (map instanceof Map ? map.get(key) : undefined);
const isInteger = (value) => Number.isSafeInteger(value) && value >= 0;

/** A name from the torrent: its UTF-8 variant if it has one, else the plain one. */
const nameIn = (map, key) => text(get(map, `${key}.utf-8`)) ?? text(get(map, key));

/**
 * What a .torrent file says. → { name, id, pieceLength, pieces, files }, where `id` is its infohash (v1's if it has
 * one, else v2's, in hex: the same torrent, the same id), and each file is { path: [names], length, offset, padding,
 * piecesRoot }: `path` within the torrent (a single-file torrent's is its name, a multi-file one's is below the folder
 * `name`), `offset` in v1's joined stream (null without v1), `piecesRoot` v2's hash of it (null without v2).
 * Throws a BencodeError for anything that isn't a torrent.
 */
export async function readTorrent(bytes) {
  const { value: root, spans } = decode(bytes);
  const info = get(root, "info");
  const span = spans.get("info");
  if (!(info instanceof Map) || !span) throw new BencodeError("it has no info dictionary");
  const name = nameIn(info, "name");
  const pieceLength = get(info, "piece length");
  if (!name || !isInteger(pieceLength) || pieceLength === 0) throw new BencodeError("its name or piece length is missing");
  const infoBytes = bytes.subarray(span[0], span[1]);

  const v2 = get(info, "meta version") === 2 ? filesOfTree(get(info, "file tree")) : null;
  if (v2?.some((file) => file.path.length === 0)) throw new BencodeError("a file in its tree has no name");
  const pieces = get(info, "pieces");
  const v1 = pieces instanceof Uint8Array ? filesOfList(info, name) : null;
  if (!v1 && !v2) throw new BencodeError("it lists no files");
  if (v1 && pieces.length % SHA1_LENGTH !== 0) throw new BencodeError("its piece hashes are cut short");

  const roots = new Map((v2 ?? []).map((file) => [file.path.join("/"), file.piecesRoot]));
  const files = v1 ? v1.map((file) => ({ ...file, piecesRoot: roots.get(file.path.join("/")) ?? null })) : v2;
  return {
    name,
    id: hexEncode(await digest(v1 ? "SHA-1" : "SHA-256", infoBytes)),
    pieceLength,
    pieces: v1 ? pieces : null,
    files,
  };
}

/** v1's files, single or many, with their offsets in the joined stream; padding files (BEP 47) are marked. */
function filesOfList(info, name) {
  const length = get(info, "length");
  if (isInteger(length)) return [{ path: [name], length, offset: 0, padding: false }];
  const list = get(info, "files");
  if (!Array.isArray(list)) throw new BencodeError("it has neither a length nor a file list");
  let offset = 0;
  return list.map((file) => {
    const size = get(file, "length");
    const parts = get(file, "path.utf-8") ?? get(file, "path");
    const path = Array.isArray(parts) ? parts.map(text) : [];
    if (!isInteger(size) || path.length === 0 || path.some((part) => part === null)) throw new BencodeError("a file in it has no length or path");
    const entry = { path, length: size, offset, padding: (text(get(file, "attr")) ?? "").includes("p") };
    offset += size;
    return entry;
  });
}

/**
 * v2's file tree, flattened: a file is a dictionary whose "" key holds its length and pieces root. Its paths are below
 * the torrent's folder, as v1's are; a single-file torrent's tree holds just that file.
 */
function filesOfTree(tree, at = []) {
  if (!(tree instanceof Map)) throw new BencodeError("its file tree isn't one");
  return [...tree].flatMap(([key, node]) => {
    const file = key === "" ? null : get(node, "");
    if (key === "") return [];
    if (file instanceof Map) {
      const length = get(file, "length");
      const root = get(file, "pieces root");
      if (!isInteger(length)) throw new BencodeError("a file in it has no length");
      return [{ path: [...at, key], length, offset: null, padding: false, piecesRoot: root instanceof Uint8Array ? root : null }];
    }
    return filesOfTree(node, [...at, key]);
  });
}

// ---------------------------------------------------------------- fitting files to a torrent

/** The pieces wholly inside a file at [offset, offset + length) of the joined stream. */
function piecesInside(offset, length, pieceLength) {
  const first = Math.ceil(offset / pieceLength);
  const last = Math.floor((offset + length) / pieceLength) - 1;
  return last >= first ? { first, last } : null;
}

const pieceHash = (torrent, index) => torrent.pieces.subarray(index * SHA1_LENGTH, (index + 1) * SHA1_LENGTH);

/** Which of a file's pieces to check: the first, the middle and the last of those wholly inside it. */
function sample({ first, last }) {
  return [...new Set([first, Math.floor((first + last) / 2), last])].slice(0, PIECES_CHECKED);
}

/** v2's hash of a whole file: the merkle root of its 16 KiB blocks, padded with zero hashes to a power of two. */
export async function piecesRoot(read, length) {
  const leaves = [];
  for (let start = 0; start < length; start += V2_BLOCK) leaves.push(await digest("SHA-256", await read(start, Math.min(start + V2_BLOCK, length))));
  let layer = leaves;
  let width = 1;
  while (width < layer.length) width *= 2;
  layer = [...layer, ...Array.from({ length: width - layer.length }, () => new Uint8Array(32))];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const pair = new Uint8Array(64);
      pair.set(layer[i]);
      pair.set(layer[i + 1], 32);
      next.push(await digest("SHA-256", pair));
    }
    layer = next;
  }
  return layer[0];
}

/** Whether `file` has the bytes of torrent `entry`, by its own hashes: v2's root, or v1's pieces inside it; null if neither can tell. */
async function checkAlone(torrent, entry, file) {
  if (entry.piecesRoot) return equal(await piecesRoot(file.read, file.size), entry.piecesRoot);
  if (!torrent.pieces) return null;
  const inside = piecesInside(entry.offset, entry.length, torrent.pieceLength);
  if (!inside) return null;
  for (const index of sample(inside)) {
    const start = index * torrent.pieceLength - entry.offset;
    const bytes = await file.read(start, start + torrent.pieceLength);
    if (!equal(await digest("SHA-1", bytes), pieceHash(torrent, index))) return false;
  }
  return true;
}

/**
 * Checks the v1 pieces that cover `entry` together with its neighbours, using the files `chosen` for them (entry → file).
 * True when one of those pieces could be put together and matches; null when none could; false when one didn't match.
 */
async function checkWithNeighbours(torrent, entry, chosen) {
  const { pieceLength } = torrent;
  const realFiles = torrent.files.filter((file) => file.length > 0);
  let result = null;
  const first = Math.floor(entry.offset / pieceLength);
  const last = Math.floor((entry.offset + entry.length - 1) / pieceLength);
  for (let index = first; index <= last; index++) {
    const start = index * pieceLength;
    const end = Math.min(start + pieceLength, totalLength(torrent));
    const covering = realFiles.filter((file) => file.offset < end && file.offset + file.length > start);
    if (covering.some((file) => !file.padding && !chosen.has(file))) continue;
    const parts = await Promise.all(
      covering.map(async (file) => {
        const from = Math.max(start, file.offset) - file.offset;
        const to = Math.min(end, file.offset + file.length) - file.offset;
        return file.padding ? new Uint8Array(to - from) : chosen.get(file).read(from, to);
      }),
    );
    const bytes = new Uint8Array(end - start);
    parts.reduce((at, part) => (bytes.set(part, at), at + part.length), 0);
    if (!equal(await digest("SHA-1", bytes), pieceHash(torrent, index))) return false;
    result = true;
  }
  return result;
}

const totalLength = (torrent) => torrent.files.reduce((sum, file) => sum + file.length, 0);
const baseName = (path) => path.at(-1).normalize("NFC");

/**
 * Fits the selected `files` ({ name, size, read(start, end) → Promise<Uint8Array> }) to the torrent's entries. A file
 * fills each entry whose bytes it has; it may fill several, when the torrent holds the same bytes twice.
 * → { placed: [{ entry, file, check }], missing: [entry], unused: [file] }, where `check` is "hash" when the hashes
 * confirm it, and "size" when they can't tell (a small v1 file without its neighbours) and the size, and the name if
 * it can, decided. Empty files and padding are left out. `onProgress(done, total)` follows the checking.
 */
export async function fitFiles(torrent, files, { onProgress = () => {} } = {}) {
  const entries = torrent.files.filter((file) => !file.padding && file.length > 0);
  const bySize = Map.groupBy(entries, (entry) => entry.length);
  const candidates = files.flatMap((file) => (bySize.get(file.size) ?? []).map((entry) => ({ entry, file })));
  const verdicts = new Map(); // candidate → true | false | null
  let done = 0;
  for (const candidate of candidates) {
    verdicts.set(candidate, await checkAlone(torrent, candidate.entry, candidate.file));
    onProgress(++done, candidates.length);
  }

  // Each entry gets the file its own hashes confirm; else, for now, the one its size and name suggest.
  const confirmed = (entry) => candidates.find((c) => c.entry === entry && verdicts.get(c) === true);
  const guessed = (entry, taken, byName) => {
    const open = candidates.filter((c) => c.entry === entry && verdicts.get(c) === null && !taken.has(c.file));
    return byName ? open.find((c) => baseName(c.entry.path) === c.file.name.normalize("NFC")) : open[0];
  };
  const chosen = new Map();
  for (const entry of entries) {
    const pick = confirmed(entry);
    if (pick) chosen.set(entry, { candidate: pick, check: "hash" });
  }
  // A file the hashes placed isn't also guessed elsewhere by its size.
  const taken = new Set([...chosen.values()].map(({ candidate }) => candidate.file));
  // Files with the entry's own name first, so another entry of the same size can't take them.
  for (const byName of [true, false]) {
    for (const entry of entries.filter((e) => !chosen.has(e))) {
      const pick = guessed(entry, taken, byName);
      if (pick) {
        chosen.set(entry, { candidate: pick, check: "size" });
        taken.add(pick.file);
      }
    }
  }

  // v1's small files: their pieces can be checked once their neighbours are chosen too.
  if (torrent.pieces) {
    for (const [entry, choice] of [...chosen]) {
      if (choice.check !== "size" || entry.offset === null) continue;
      const files = new Map([...chosen].map(([e, { candidate }]) => [e, candidate.file]));
      const result = await checkWithNeighbours(torrent, entry, files);
      if (result === true) choice.check = "hash";
      if (result === false) chosen.delete(entry);
    }
  }

  const placed = entries.filter((entry) => chosen.has(entry)).map((entry) => ({ entry, file: chosen.get(entry).candidate.file, check: chosen.get(entry).check }));
  const used = new Set(placed.map(({ file }) => file));
  return {
    placed,
    missing: entries.filter((entry) => !chosen.has(entry)),
    unused: files.filter((file) => !used.has(file)),
  };
}
