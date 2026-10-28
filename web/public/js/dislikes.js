// Dislikes (SPEC §5.8): tracks, by their bytes (SHA-256), that no list plays unless they are started on purpose. Kept
// in one small file, lists/dislikes.json, with what the Dislikes screen shows of each; unlike a like, a dislike holds no
// copy of the track's entry, so it keeps nothing stored: a disliked track whose package goes is gone, and one uploaded
// again is still disliked. Plain functions and save steps; no DOM.

import { te } from "../sdk/crypto.js";
import { TreeError } from "../sdk/tree.js";

export const DISLIKES = ["lists", "dislikes.json"];
const VERSION = 1;

const text = (value) => (typeof value === "string" ? value : "");

/**
 * The dislikes in dislikes.json's bytes (null for none): [{ sha256, title, artist, disliked }], the newest first; []
 * for a file this version doesn't read, which is then left as it is until something is disliked or taken back.
 */
export function readDislikes(bytes) {
  if (!bytes) return [];
  try {
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    if (doc?.version !== VERSION || !Array.isArray(doc.tracks)) return [];
    return doc.tracks
      .filter((track) => typeof track?.sha256 === "string" && /^[0-9a-f]{64}$/.test(track.sha256))
      .map((track) => ({ sha256: track.sha256, title: text(track.title), artist: text(track.artist), disliked: text(track.disliked) }));
  } catch {
    return [];
  }
}

/** Whether the bytes with this SHA-256 are disliked, among `dislikes`. */
export const isDisliked = (dislikes, sha256) => typeof sha256 === "string" && dislikes.some((dislike) => dislike.sha256 === sha256);

const encoded = (dislikes) => te.encode(`${JSON.stringify({ version: VERSION, tracks: dislikes }, null, 2)}\n`);

/** dislikes.json as it is in `tx`: [] when there is none yet. */
async function current(tx) {
  try {
    return readDislikes(await tx.read(DISLIKES));
  } catch (error) {
    if (error instanceof TreeError && error.code === "not_found") return [];
    throw error;
  }
}

/**
 * A save step disliking `track` (library.js's trackOf, with `artist` if known) at `now`. Nothing changes if its bytes
 * are disliked already. Taking back a like of the same bytes is likes.js's `unlike`, in the same save.
 */
export const dislike = (track, now) => async (tx) => {
  const dislikes = await current(tx);
  if (typeof track.sha256 !== "string" || isDisliked(dislikes, track.sha256)) return tx;
  const added = { sha256: track.sha256, title: text(track.title), artist: text(track.artist), disliked: new Date(now).toISOString() };
  return tx.put(DISLIKES, tx.upload(encoded([added, ...dislikes])));
};

/** A save step taking back the dislike of the bytes with this SHA-256; nothing changes if they aren't disliked. */
export const undislike = (sha256) => async (tx) => {
  const dislikes = await current(tx);
  if (!isDisliked(dislikes, sha256)) return tx;
  return tx.put(DISLIKES, tx.upload(encoded(dislikes.filter((dislike) => dislike.sha256 !== sha256))));
};
