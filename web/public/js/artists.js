// The artists/ tree (SPEC §5.5): copies of the packages' tracks, by artist and album. It follows from uploads/ alone
// (sorting.js), so it is brought in line with it in the save that changes a package, or right after an upload, and can
// be rebuilt at any time. Copies are the same blobs, so they cost no storage.

import { orEmpty, walk, writeAll } from "./library.js";
import { allPackages, FILES, UPLOADS } from "./packages.js";
import { entrySort, entryTags, sortLibrary, sortTarget, treeChanges } from "./sorting.js";

export const ARTISTS = ["artists"];

/** `tx` with the paths below `at` removed and the entries put, as treeChanges gives them. */
const applied = (tx, at, { remove, put }) =>
  writeAll(tx, [...remove.map((path) => (t) => t.remove([...at, ...path])), ...put.map(({ path, entry }) => (t) => t.put([...at, ...path], entry))]);

/** A save step bringing artists/ in line with uploads/: only what differs is written. */
export async function sortArtists(tx) {
  const list = orEmpty(tx.list);
  const [packages, current] = await Promise.all([allPackages(list), walk(list, ARTISTS)]);
  return applied(tx, ARTISTS, treeChanges(current, sortLibrary(packages)));
}

/**
 * The album below artists/ a track at `path` (from the root) most likely is in, as [artist, album]: the one it is
 * played from, else where its own tags and what the user set sort it, at its place in its package; null when they
 * don't say. Only likely: sorting also looks at the other tracks of its folder, and sorts the same bytes once.
 */
export function likelyAlbum(path, entry) {
  if (path[0] === ARTISTS[0] && path.length === 4) return path.slice(1, 3);
  const inPackage = path[0] === UPLOADS[0] && path[2] === FILES && path.length > 3;
  const at = inPackage ? { path: path.slice(3), packageName: path[1] } : { path: path.slice(-1), packageName: "" };
  const { artist, album } = sortTarget({ ...at, tags: entryTags(entry), sort: entrySort(entry) });
  return album ? [artist, album] : null;
}

/**
 * The album below artists/ that has the bytes of `track` (library.js's trackOf), as a path from the root; null when
 * none has them. Its likely album is looked in first, all of artists/ only when they aren't there. `list` lists a folder.
 */
export async function albumOf(list, track) {
  const lists = orEmpty(list);
  const isIt = (entry) => entry.kind === "file" && entry.sha256 === track.sha256;
  const likely = likelyAlbum(track.name.split("/"), track);
  if (likely && (await lists([...ARTISTS, ...likely])).some(isIt)) return [...ARTISTS, ...likely];
  const found = (await walk(lists, ARTISTS)).find(({ entry }) => isIt(entry));
  return found ? [...ARTISTS, ...found.path.slice(0, -1)] : null;
}
