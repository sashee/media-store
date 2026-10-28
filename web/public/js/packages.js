// Upload packages (SPEC §5.1): what was uploaded together stays together, under uploads/<package>/:
//
//   files/…          the files, at their paths in the folder or torrent they came from, or flat when picked one by one
//   package.json     what the package is: its name, when and how it was uploaded, its files, what its torrent misses
//   package.torrent  the torrent that shaped it, if one did
//
// Plain functions of data, and the save steps; no DOM.

import { te } from "../sdk/crypto.js";
import { freeName, nameFor, orEmpty, walk, writeAll } from "./library.js";

export const UPLOADS = ["uploads"];
export const FILES = "files";
export const PACKAGE_DOC = "package.json";
export const PACKAGE_TORRENT = "package.torrent";
export const DOC_VERSION = 1;

/** The folder every relative path starts with, when they all start with the same one; else null. */
export function commonFolder(paths) {
  const firsts = new Set(paths.map((path) => (path.length > 1 ? path[0] : null)));
  return firsts.size === 1 && !firsts.has(null) ? [...firsts][0] : null;
}

/** The album most of these tags name, if one does. */
function commonAlbum(tags) {
  const counts = new Map();
  tags.forEach(({ album }) => album && counts.set(album, (counts.get(album) ?? 0) + 1));
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** The name a package gets unless the user gives one: its torrent's, its folder's, its album's, or the date's. */
export function defaultPackageName({ torrent = null, folder = null, tags = [], now }) {
  const name = torrent?.name ?? folder ?? commonAlbum(tags) ?? `Upload ${new Date(now).toISOString().slice(0, 10)}`;
  return nameFor(name, "Upload");
}

/**
 * Paths in the package, from the paths the files were picked with (a folder's relative paths, split): below the folder
 * all of them share, which names the package instead; names cleaned; and a name twice in one folder made unique.
 */
export function packagePaths(paths) {
  const folder = commonFolder(paths);
  const taken = new Map();
  return paths.map((path) => {
    const parts = (folder ? path.slice(1) : path).map((part) => nameFor(part, "file"));
    const dir = parts.slice(0, -1).join("/");
    const used = taken.get(dir) ?? [];
    const name = freeName(parts.at(-1), used);
    taken.set(dir, [...used, name]);
    return [...parts.slice(0, -1), name];
  });
}

/**
 * package.json: { version, name, uploaded, updated, source ("files", "folder" or "torrent"), torrent ({ name, id,
 * files } or null), files, bytes, missing (the torrent's paths it lacks) }.
 */
export function packageDoc({ name, source, torrent = null, files, missing = [], uploaded, updated = uploaded }) {
  return {
    version: DOC_VERSION,
    name,
    uploaded: new Date(uploaded).toISOString(),
    updated: new Date(updated).toISOString(),
    source,
    torrent: torrent && { name: torrent.name, id: torrent.id, files: torrent.files },
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    missing,
  };
}

/** package.json read back, checked; null for anything that isn't one. */
export function readPackageDoc(bytes) {
  try {
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    const valid = doc && doc.version === DOC_VERSION && typeof doc.name === "string" && Number.isSafeInteger(doc.files) && Array.isArray(doc.missing);
    return valid ? doc : null;
  } catch {
    return null;
  }
}

const json = (value) => te.encode(`${JSON.stringify(value, null, 2)}\n`);

/**
 * A save step storing a package: `files` as [{ path, source (a Blob), app }], `doc` its package.json, `torrent` the
 * torrent's bytes or null. A new package (`into` null) gets a name no other package has when the step runs; one that
 * is being completed (`into`, its name) gets the new files and its package.json replaced. Files are offloadable, the
 * package's own documents aren't.
 */
export const savePackage = ({ name, into = null, files, doc, torrent = null }) => async (tx) => {
  const taken = (await tx.entry(UPLOADS)) ? (await tx.list(UPLOADS)).map((entry) => entry.name) : [];
  const folder = into ?? freeName(name, taken, { extension: false });
  const at = [...UPLOADS, folder];
  const withFiles = await writeAll(tx, files.map((file) => (next) => next.put([...at, FILES, ...file.path], next.upload(file.source, { offloadable: true, app: file.app }))));
  const withDoc = withFiles.put([...at, PACKAGE_DOC], withFiles.upload(json({ ...doc, name: folder })));
  return torrent ? withDoc.put([...at, PACKAGE_TORRENT], withDoc.upload(torrent)) : withDoc;
};

/** The files of the package `name`, as [{ path, entry }] with `path` in its files/. `list` lists a folder. */
export async function packageFiles(list, name) {
  return (await walk(orEmpty(list), [...UPLOADS, name, FILES])).filter(({ entry }) => entry.kind === "file");
}

/** Every package, with its files: [{ name, files }], what sorting starts from. */
export async function allPackages(list) {
  const names = (await orEmpty(list)(UPLOADS)).filter((entry) => entry.kind === "dir").map((entry) => entry.name);
  return Promise.all(names.map(async (name) => ({ name, files: await packageFiles(list, name) })));
}

/**
 * A save step setting how the package `name`'s files are sorted, `files` as [{ path, sort }] (sorting.js's regroup):
 * `sort` goes into each file's `app`, or out of it when it is empty. A file that is gone meanwhile is left alone.
 */
export const setSorting = (name, files) => (tx) =>
  files.reduce(async (previous, { path, sort }) => {
    const next = await previous;
    const at = [...UPLOADS, name, FILES, ...path];
    const entry = await next.entry(at);
    if (!entry || entry.kind !== "file") return next;
    const { sort: _before, ...app } = entry.app ?? {};
    const wanted = Object.keys(sort).length > 0 ? { ...app, sort } : app;
    return JSON.stringify(wanted) === JSON.stringify(entry.app ?? {}) ? next : next.put(at, { ...entry, app: wanted });
  }, Promise.resolve(tx));

/** A save step deleting the package `name`, all of it. */
export const deletePackage = (name) => (tx) => tx.remove([...UPLOADS, name]);
