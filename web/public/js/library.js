// The library's files (SPEC §5): names the tree takes, MIME types, the tracks the player plays, and play URLs. Plain
// functions of data, no DOM: the Service Worker and the unit tests use them too.

import { te } from "../sdk/crypto.js";
import { TreeError, validName } from "../sdk/tree.js";

/** MIME types by extension, for files the browser gives none: audio, and pictures for covers. */
const TYPES = {
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  weba: "audio/webm",
  webm: "audio/webm",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** A MIME type without parameters: what goes into a play URL and a response's Content-Type. */
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

const EXTENSION = /\.[^.]+$/;

/** A file's MIME type: the browser's, or else from its extension; "" when neither says. */
export function typeOf({ name, type }) {
  if (MIME.test(type ?? "")) return type.toLowerCase();
  return TYPES[EXTENSION.exec(name)?.[0].slice(1).toLowerCase()] ?? "";
}

/** A track's title from its file name: without the extension. */
export const titleOf = (fileName) => fileName.replace(EXTENSION, "").trim() || fileName;

/** Why this browser can't play a file of MIME type `type`, or null if it can. `canPlay` is an <audio>'s canPlayType. */
export function unplayable(type, canPlay) {
  if (type === "") return "its type is unknown.";
  if (!type.startsWith("audio/")) return `it isn't audio (${type}).`;
  return canPlay(type) === "" ? `this browser can't play ${type}.` : null;
}

/** Under the tree's 255 bytes, with room for " (n)". */
const MAX_NAME_BYTES = 200;

/** The longest start of `text` that is at most `max` bytes of UTF-8. */
function cut(text, max) {
  const chars = [...text];
  const fits = (n) => te.encode(chars.slice(0, n).join("")).length <= max;
  let n = chars.length;
  while (!fits(n)) n -= 1;
  return chars.slice(0, n).join("");
}

/** A name the tree takes, from any text: without "/" and control characters, and not too long; `fallback` if nothing is left. */
export function nameFor(text, fallback = "track") {
  const name = cut(text.normalize("NFC").replace(/[/\u0000-\u001f\u007f]/g, "").trim(), MAX_NAME_BYTES);
  return validName(name) ? name : fallback;
}

/** `name`, or else "<name> (2).<ext>", "(3)", …: the first that isn't among `taken`. Folders have no extension. */
export function freeName(name, taken, { extension: hasExtension = true } = {}) {
  const used = new Set(taken);
  const extension = hasExtension ? (EXTENSION.exec(name)?.[0] ?? "") : "";
  const stem = name.slice(0, name.length - extension.length);
  const candidate = (n) => (n === 1 ? name : `${stem} (${n})${extension}`);
  let n = 1;
  while (used.has(candidate(n))) n += 1;
  return candidate(n);
}

/** The MIME type an entry was stored with, else one from its name: "" when neither says. */
export const typeOfEntry = (entry) => (typeof entry.app?.type === "string" && MIME.test(entry.app.type) ? entry.app.type : typeOf({ name: entry.name, type: "" }));

/**
 * A track, from a file entry in directory `dir`: its blob, title and type, for the player and its queue. Its `name` is
 * its path, which tells it apart in a queue. The title is its tag's, else its file name's. The entry's SHA-256 and
 * `app` come along, so a like can copy it (likes.js).
 */
export function trackOf(entry, dir = []) {
  const tagged = entry.app?.tags?.title;
  const title = typeof tagged === "string" && tagged !== "" ? tagged : titleOf(entry.name);
  return { name: [...dir, entry.name].join("/"), title, type: typeOfEntry(entry) || "application/octet-stream", size: entry.size, id: entry.id, salt: entry.salt, sha256: entry.sha256, ...(entry.app ? { app: entry.app } : {}) };
}

/**
 * Playlists say "audio/…" too (audio/x-mpegurl for .m3u), and a browser that streams HLS even says it can play them.
 * They list tracks; they aren't any.
 */
const PLAYLIST_TYPES = new Set(["audio/x-mpegurl", "audio/mpegurl", "application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/x-scpls", "application/xspf+xml"]);
const PLAYLIST_EXTENSION = /\.(m3u8?|pls|xspf)$/i;

/** Whether a file of this name and MIME type is a track: audio, and not a playlist. */
export const isTrack = ({ name, type }) => type.startsWith("audio/") && !PLAYLIST_TYPES.has(type) && !PLAYLIST_EXTENSION.test(name);

/** Whether an entry is a track this browser may play: audio by its type, and not a playlist. */
export const isAudio = (entry) => entry.kind === "file" && isTrack({ name: entry.name, type: typeOfEntry(entry) });

/** Whether an entry is a picture, such as an album's cover. */
export const isImage = (entry) => entry.kind === "file" && /^image\/(jpeg|png|webp|gif)$/.test(typeOfEntry(entry));

/** `list` (a save's tx.list, or the session's), but a folder that isn't there lists as empty. */
export const orEmpty = (list) => async (path) => {
  try {
    return await list(path);
  } catch (error) {
    if (error instanceof TreeError && error.code === "not_found") return [];
    throw error;
  }
};

/** How many writes go on a tx before it is worked out: each waits on the one before, and too many at once overflow the stack. */
const WRITES_AT_ONCE = 200;

/** `tx` after `writes`, each (tx) => tx, in order. */
export const writeAll = (tx, writes) =>
  writes.reduce(async (previous, write, i) => {
    const next = write(await previous);
    if ((i + 1) % WRITES_AT_ONCE === 0) await next.list([]);
    return next;
  }, Promise.resolve(tx));

/**
 * Everything below the folder `path`, folders too, as [{ path, entry }] with `path` relative to it, each folder before
 * what is in it. `list(path)` lists a folder (a save's tx.list, or the session's).
 */
export async function walk(list, path) {
  const below = async (at) => {
    const entries = await list([...path, ...at]);
    const nested = await Promise.all(entries.map(async (entry) => [{ path: [...at, entry.name], entry }, ...(entry.kind === "dir" ? await below([...at, entry.name]) : [])]));
    return nested.flat();
  };
  return below([]);
}

// ---------------------------------------------------------------- play URLs (sw.js)

/** Where the page plays a track from. The Service Worker answers it; it never reaches the server (player.js). */
export const playUrl = ({ id, salt, size, type }) => `/play/${id}?${new URLSearchParams({ salt, size: String(size), type })}`;

/** The track a play URL names, checked; null if it isn't one. */
/** The blob a play URL (a string) is of; null for anything else. */
export const playUrlBlob = (url) => {
  try {
    return parsePlayUrl(new URL(url))?.id ?? null;
  } catch {
    return null;
  }
};

export function parsePlayUrl(url) {
  const id = /^\/play\/([0-9a-f]{64})$/.exec(url.pathname)?.[1];
  const [salt, size, type] = ["salt", "size", "type"].map((key) => url.searchParams.get(key) ?? "");
  const valid = id && /^[0-9a-f]{32}$/.test(salt) && /^\d{1,15}$/.test(size) && MIME.test(type);
  return valid ? { id, salt, size: Number(size), type } : null;
}
