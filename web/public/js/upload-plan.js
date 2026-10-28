// What an upload would store (SPEC §5.1–§5.4), worked out before anything is stored, for the preview: each file's path
// in the package, whether the torrent confirms it, its tags, and where it would be sorted. No DOM; files are read
// through `read(start, end)`.

import { isTrack, nameFor, typeOf } from "./library.js";
import { commonFolder, packagePaths } from "./packages.js";
import { NO_TAGS, readTags } from "./tags.js";
import { fitFiles, readTorrent } from "./torrent.js";

/** A picked File at `path` (its folders and name, from the picked folder's own), as the planning reads it. */
export function picked({ file, path }) {
  return {
    name: file.name,
    size: file.size,
    type: typeOf(file),
    path,
    source: file,
    read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
  };
}

/** A File from an input, with its path: a folder input's relative one, else its name alone. */
export const fromInput = (file) => ({ file, path: file.webkitRelativePath ? file.webkitRelativePath.split("/") : [file.name] });

/**
 * The files below a folder picked with `showDirectoryPicker` (a FileSystemDirectoryHandle), each with its path from
 * the folder's own name down: [{ file, path }], as a folder input gives them.
 */
export async function filesInFolder(folder, at = [folder.name]) {
  const found = [];
  for await (const entry of folder.values()) {
    const path = [...at, entry.name];
    found.push(...(entry.kind === "file" ? [{ file: await entry.getFile(), path }] : await filesInFolder(entry, path)));
  }
  return found;
}

/**
 * The plan for uploading `files` (picked()), shaped by `torrent` (its bytes) if there is one. `findPackage(id)` says
 * which package a torrent already filled, if any: { name, present (its files' paths, joined by "/") }.
 * → { source, torrent, into, folder, rows } where each row is { path, file, status, type, tags }:
 *   status "new" (to be stored), "checked" or "size" (stored, fitted to the torrent by its hashes or by its size only),
 *   "present" (in the package already), "missing" (in the torrent, not picked) or "unused" (picked, not in the torrent).
 * `onProgress(text)` says what it is doing.
 */
export async function planUpload({ files, torrent: torrentBytes = null, findPackage = async () => null, onProgress = () => {} }) {
  if (torrentBytes) return planTorrent({ files, torrentBytes, findPackage, onProgress });
  const paths = packagePaths(files.map((file) => file.path));
  const rows = files.map((file, i) => ({ path: paths[i], file, status: "new", type: file.type }));
  return {
    source: files.some((file) => file.path.length > 1) ? "folder" : "files",
    torrent: null,
    into: null,
    folder: commonFolder(files.map((file) => file.path)),
    rows: await withTags(rows, onProgress),
  };
}

async function planTorrent({ files, torrentBytes, findPackage, onProgress }) {
  onProgress("Reading the torrent");
  const torrent = await readTorrent(torrentBytes);
  const existing = await findPackage(torrent.id);
  const fitted = await fitFiles(torrent, files, { onProgress: (done, total) => onProgress(`Checking files against the torrent: ${done} of ${total}`) });
  const pathOf = (entry) => entry.path.map((part) => nameFor(part, "file"));
  const present = (path) => existing?.present.has(path.join("/")) ?? false;
  const placed = fitted.placed.map(({ entry, file, check }) => ({ path: pathOf(entry), file, status: present(pathOf(entry)) ? "present" : check === "hash" ? "checked" : "size", type: typeOf({ name: entry.path.at(-1), type: file.type }) }));
  const missing = fitted.missing.map((entry) => ({ path: pathOf(entry), file: null, status: present(pathOf(entry)) ? "present" : "missing", type: typeOf({ name: entry.path.at(-1), type: "" }) }));
  const unused = fitted.unused.map((file) => ({ path: [file.name], file, status: "unused", type: file.type }));
  const byPath = (a, b) => (a.path.join("/") < b.path.join("/") ? -1 : 1);
  return {
    source: "torrent",
    torrent: { name: torrent.name, id: torrent.id, files: torrent.files.filter((f) => !f.padding && f.length > 0).length, bytes: torrentBytes },
    into: existing?.name ?? null,
    folder: null,
    rows: [...(await withTags([...placed, ...missing].sort(byPath), onProgress)), ...unused],
  };
}

/** The rows, with the tags of the audio files that will be stored. */
async function withTags(rows, onProgress) {
  const track = (row) => isTrack({ name: row.path.at(-1), type: row.type });
  const reading = rows.filter((row) => stored(row) && track(row));
  let done = 0;
  return Promise.all(
    rows.map(async (row) => {
      if (!reading.includes(row)) return { ...row, tags: track(row) ? NO_TAGS : null };
      const tags = await readTags(row.file);
      onProgress(`Reading tags: ${++done} of ${reading.length}`);
      return { ...row, tags };
    }),
  );
}

/** Whether a row's file is to be stored. */
export const stored = (row) => row.status === "new" || row.status === "checked" || row.status === "size";
