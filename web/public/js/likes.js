// Likes (SPEC §5.6): lists/likes/ holds a copy of each liked track's entry, the same blob, its `modified` the time it
// was liked, which orders the list, newest first. A like is of the bytes (by SHA-256), wherever they are played from,
// and stays when its package goes: such likes are shown apart. Plain functions and save steps; no DOM.

import { freeName, nameFor, orEmpty } from "./library.js";
import { allPackages } from "./packages.js";

export const LIKES = ["lists", "likes"];

const EXTENSION = /\.[^.]+$/;

/** The name a liked track gets: "<artist> - <title><extension>", or the title alone without an artist. */
export function likeName(track, taken) {
  const tags = track.app?.tags ?? {};
  const artist = [tags.artist, tags.albumArtist].find((value) => typeof value === "string" && value.trim()) ?? "";
  const extension = EXTENSION.exec(track.name)?.[0] ?? "";
  const fallback = track.name.split("/").at(-1);
  return freeName(nameFor(`${artist ? `${artist.trim()} - ` : ""}${track.title}${extension}`.replace(/\//g, "∕"), fallback), taken);
}

/** Likes, the newest first; at the same time, by name. */
export const newestFirst = (likes) => likes.toSorted((a, b) => Date.parse(b.modified) - Date.parse(a.modified) || (a.name < b.name ? -1 : 1));

/** Whether the bytes with this SHA-256 are liked, among `likes` (the entries of lists/likes/). */
export const isLiked = (likes, sha256) => typeof sha256 === "string" && likes.some((like) => like.sha256 === sha256);

/**
 * A save step liking `track` (library.js's trackOf) at `now`: a copy of its entry in lists/likes/. Nothing changes if
 * its bytes are liked already.
 */
export const like = (track, now) => async (tx) => {
  const likes = (await orEmpty(tx.list)(LIKES)).filter((entry) => entry.kind === "file");
  if (isLiked(likes, track.sha256)) return tx;
  const entry = { kind: "file", id: track.id, salt: track.salt, size: track.size, sha256: track.sha256, modified: new Date(now).toISOString(), ...(track.app ? { app: track.app } : {}) };
  return tx.put([...LIKES, likeName(track, likes.map((e) => e.name))], entry);
};

/** A save step taking back the like of the bytes with this SHA-256. */
export const unlike = (sha256) => async (tx) => {
  const likes = await orEmpty(tx.list)(LIKES);
  return likes.filter((entry) => entry.sha256 === sha256).reduce((next, entry) => next.remove([...LIKES, entry.name]), tx);
};

/** The tracks among `tracks` whose bytes are liked (`likes`, the entries of lists/likes/), in their order. */
export function onlyLiked(tracks, likes) {
  const liked = new Set(likes.map((like) => like.sha256).filter((sha256) => typeof sha256 === "string"));
  return tracks.filter((track) => liked.has(track.sha256));
}

/** The likes whose bytes no package has any more (packages.js's allPackages): they still play, from the like. */
export function notInPackages(likes, packages) {
  const kept = new Set(packages.flatMap(({ files }) => files.map(({ entry }) => entry.sha256)));
  return likes.filter((like) => !kept.has(like.sha256));
}

/**
 * The likes to point at another blob (SPEC §5.6): a like whose own blob no package has any more, but whose bytes (by
 * SHA-256) a package has, takes that package's copy, the first by package name and path as sorting picks it. It keeps
 * its name and when it was liked; its old blob, reached by nothing then, is left for cleanup. A package uploaded again
 * after it was deleted takes its likes back this way, and a like of a deleted package's track goes to another package
 * that has the same bytes. → [{ name, entry }]: only the likes that change.
 */
export function repointed(likes, packages) {
  const inPackages = packages
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap(({ files }) => files.map(({ entry }) => entry))
    .filter((entry) => entry.kind === "file");
  const used = new Set(inPackages.map((entry) => entry.id));
  const firstWith = new Map(inPackages.filter((entry) => typeof entry.sha256 === "string").reverse().map((entry) => [entry.sha256, entry]));
  return likes
    .filter((like) => like.kind === "file" && !used.has(like.id) && firstWith.has(like.sha256))
    .map((like) => {
      const copy = firstWith.get(like.sha256);
      return { name: like.name, entry: { ...like, id: copy.id, salt: copy.salt, size: copy.size } };
    });
}

/** A save step pointing the likes whose blob no package has at a package's copy of their bytes (`repointed`). */
export const repointLikes = async (tx) => {
  const list = orEmpty(tx.list);
  const [likes, packages] = await Promise.all([list(LIKES), allPackages(list)]);
  return repointed(likes, packages).reduce((next, { name, entry }) => next.put([...LIKES, name], entry), tx);
};
