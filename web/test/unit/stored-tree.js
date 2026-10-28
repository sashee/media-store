// A stored tree for the unit tests, without a server: directories and file entries as the SDK keeps them, so steps
// can copy stored entries (tree.js accepts back only entries it has seen).

import { begin } from "../../public/sdk/tree.js";

export const NOW = Date.UTC(2026, 9, 25, 10, 0, 0);

const hex = (n, length) => n.toString(16).padStart(length, "0");
const byName = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A tx on a tree of `files`: { "uploads/P/files/01.mp3": { app, sha256, size, modified } }, with folders made along
 * the paths. Each file gets its own blob ID; its SHA-256 is its own unless given.
 */
export function storedTree(files) {
  let counter = 0;
  const dirs = new Map();
  const known = new Map();
  const remember = (entry) => (known.set(entry.id, entry), entry);
  const build = (items) =>
    [...Map.groupBy(items, ([parts]) => parts[0])].sort(byName).map(([name, below]) => {
      const n = (counter += 1);
      if (below.length === 1 && below[0][0].length === 1) {
        const file = below[0][1];
        const entry = { name, kind: "file", id: hex(n, 64), salt: hex(n, 32), size: file.size ?? 100, sha256: file.sha256 ?? hex(n + 1000, 64), modified: file.modified ?? "2026-10-24T00:00:00.000Z" };
        return remember({ ...entry, ...(file.app ? { app: file.app } : {}) });
      }
      const doc = { version: 1, entries: build(below.map(([parts, file]) => [parts.slice(1), file])) };
      dirs.set(hex(n, 64), doc);
      return remember({ name, kind: "dir", id: hex(n, 64), salt: hex(n, 32) });
    });
  const root = { version: 1, revision: 1, entries: build(Object.entries(files).map(([path, file]) => [path.split("/"), file])) };
  return begin(root, { loadDir: async (id) => dirs.get(id), known: (id) => known.get(id) }, NOW);
}

/** The files below `path` in a tx, as { "relative/path": entry }. */
export async function filesAt(tx, path) {
  const out = {};
  const walkDir = async (at) => {
    for (const entry of await tx.list([...path, ...at])) {
      if (entry.kind === "dir") await walkDir([...at, entry.name]);
      else out[[...at, entry.name].join("/")] = entry;
    }
  };
  if (await tx.entry(path)) await walkDir([]);
  return out;
}
