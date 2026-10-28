// The artists/ tree (SPEC §5.5): copies of the packages' tracks, by artist and album. It follows from uploads/ alone
// (sorting.js), so it is brought in line with it in the save that changes a package, or right after an upload, and can
// be rebuilt at any time. Copies are the same blobs, so they cost no storage.

import { orEmpty, walk, writeAll } from "./library.js";
import { allPackages } from "./packages.js";
import { sortLibrary, treeChanges } from "./sorting.js";

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
