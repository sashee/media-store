// Files stored more than once (SPEC §5.7): the same bytes, by the SHA-256 their entries record, in more than one
// blob. Copies of an entry, in artists/ and the likes, share its blob and aren't duplicates; the same track uploaded in
// two packages is. Plain functions of data.

/** What a duplicate costs beyond one copy, in bytes. */
export const wasted = ({ size, blobs }) => size * (blobs.length - 1);

/**
 * The bytes stored in more than one blob, among `files` ([{ path, entry }], the whole tree as library.js's walk gives
 * it): [{ sha256, size, blobs: [{ id, paths }] }], each blob with the paths that reach it, the most wasteful first.
 */
export function duplicates(files) {
  const hashed = files.filter(({ entry }) => entry.kind === "file" && typeof entry.sha256 === "string");
  return [...Map.groupBy(hashed, ({ entry }) => entry.sha256)]
    .map(([sha256, copies]) => ({
      sha256,
      size: copies[0].entry.size,
      blobs: [...Map.groupBy(copies, ({ entry }) => entry.id)].map(([id, reaching]) => ({ id, paths: reaching.map(({ path }) => path.join("/")) })),
    }))
    .filter(({ blobs }) => blobs.length > 1)
    .toSorted((a, b) => wasted(b) - wasted(a));
}
