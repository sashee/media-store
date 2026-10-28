// Sorting (SPEC §5.4, §5.5): where each track goes in artists/<artist>/<album>/<name>, from its tags, its place in its
// package, the package's name, and what the user set; and the artists/ tree that follows from all the packages. Plain
// functions of data: the upload preview, the browser and the save steps (artists.js) use them.

import { freeName, isImage, isTrack, nameFor, typeOfEntry } from "./library.js";
import { NO_TAGS } from "./tags.js";

export const UNKNOWN_ARTIST = "Unknown artist";

/** "CD1", "Disc 2", "disk_3": a folder that only says which disc. */
const DISC_FOLDER = /^(?:cd|disc|disk)[\s._-]*(\d{1,2})$/i;
/** "01 Title", "01 - Title", "01. Title", "1_Title": a number before the title. */
const NUMBERED = /^(\d{1,3})(?:\s*[-._)]\s*|\s+)(.+)$/;
const EXTENSION = /\.[^.]+$/;

/** The disc a path's folders say, e.g. 2 for .../CD2/...; null if none does. */
export function discOfPath(path) {
  const folder = path.slice(0, -1).findLast((name) => DISC_FOLDER.test(name));
  return folder ? Number(DISC_FOLDER.exec(folder)[1]) : null;
}

/** The folders a file's album is told by: the ones it is in, without disc folders. */
const albumFolders = (path) => path.slice(0, -1).filter((name) => !DISC_FOLDER.test(name));

/** A folder name from a tag: "/" can't be in one, so it becomes "∕", which reads the same (AC∕DC). */
export const folderName = (text, fallback) => nameFor(text.replace(/\//g, "∕"), fallback);

/**
 * Where a file of the package `packageName` would go: { artist, album, name }, as names the tree takes. `path` is the
 * file's path in the package's `files`, `tags` its tags (tags.js), `sort` what the user set: { artist, album }, either
 * or both, which win over everything else.
 *
 * - artist: the album artist, else the artist, else the folder above the album's, else "Unknown artist";
 * - album: the album, else the folder the file is in (not counting a disc folder), else the package's name;
 * - name: "<track> <title><extension>", the track number two digits wide, with "<disc>-" first on a multi-disc album;
 *   the title is the tag's, else the file name's without a leading number, which becomes the track number if no tag says.
 */
export function sortTarget({ tags, path, packageName, sort = {} }) {
  const fileName = path.at(-1);
  const extension = EXTENSION.exec(fileName)?.[0] ?? "";
  const stem = fileName.slice(0, fileName.length - extension.length).trim();
  const numbered = NUMBERED.exec(stem);
  const folders = albumFolders(path);
  const disc = tags.disc ?? discOfPath(path);
  const multiDisc = (tags.discTotal ?? 0) > 1 || (disc ?? 0) > 1 || discOfPath(path) !== null;
  const track = tags.track ?? (numbered ? Number(numbered[1]) : null);
  const title = tags.title || (numbered ? numbered[2] : stem) || stem;
  const prefix = `${multiDisc && disc ? `${disc}-` : ""}${track ? `${String(track).padStart(2, "0")} ` : ""}`;
  const artist = folderName(tags.albumArtist || tags.artist || folders.at(-2) || "", UNKNOWN_ARTIST);
  const album = folderName(tags.album || folders.at(-1) || packageName, packageName);
  return {
    artist: sort.artist ? folderName(sort.artist, artist) : artist,
    album: sort.album ? folderName(sort.album, album) : album,
    name: nameFor(`${prefix}${title.replace(/\//g, "∕")}${extension}`, fileName),
  };
}

/** How the preview and the browser show a target: "Artist / Album / 01 Title.mp3". */
export const shownTarget = ({ artist, album, name }) => `${artist} / ${album} / ${name}`;

/** The one value all of `values` that say anything agree on; null when none say, or they disagree. */
function agreed(values) {
  const said = new Set(values.filter(Boolean));
  return said.size === 1 ? [...said][0] : null;
}

/**
 * The targets of a package's tracks, `files` as [{ path, tags, sort }], in their order. A track that lacks an artist or
 * an album gets the one the tagged tracks in its folder agree on, if they do: an album with a track or two untagged
 * stays together.
 */
export function packageTargets({ packageName, files }) {
  const byFolder = Map.groupBy(files, (file) => albumFolders(file.path).join("/"));
  const folderTags = new Map(
    [...byFolder].map(([folder, inFolder]) => [
      folder,
      { artist: agreed(inFolder.map(({ tags }) => tags.albumArtist || tags.artist)), album: agreed(inFolder.map(({ tags }) => tags.album)) },
    ]),
  );
  return files.map(({ path, tags, sort = {} }) => {
    const folder = folderTags.get(albumFolders(path).join("/"));
    const filled = { ...tags, artist: tags.artist || (tags.albumArtist ? "" : (folder.artist ?? "")), album: tags.album || (folder.album ?? "") };
    return sortTarget({ tags: filled, path, packageName, sort });
  });
}

/** An entry's stored tags, as sorting reads them: anything odd counts as no tag. */
export function entryTags(entry) {
  const tags = entry.app?.tags ?? {};
  const text = (value) => (typeof value === "string" ? value : "");
  const number = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
  return {
    ...NO_TAGS,
    ...Object.fromEntries(["title", "artist", "albumArtist", "album"].map((key) => [key, text(tags[key])])),
    ...Object.fromEntries(["track", "trackTotal", "disc", "discTotal", "year"].map((key) => [key, number(tags[key])])),
  };
}

/** What the user set for an entry's sorting (`app.sort`): { artist, album }, either or both. */
export function entrySort(entry) {
  const sort = entry.app?.sort ?? {};
  return Object.fromEntries(["artist", "album"].filter((key) => typeof sort[key] === "string" && sort[key].trim()).map((key) => [key, sort[key]]));
}

/** A package's tracks, from its files ([{ path, entry }]), as packageTargets takes them, with their entries. */
export const packageTracks = (files) =>
  files.filter(({ entry }) => entry.kind === "file" && isTrack({ name: entry.name, type: typeOfEntry(entry) })).map(({ path, entry }) => ({ path, entry, tags: entryTags(entry), sort: entrySort(entry) }));

/** The albums targets go to, in the order they first come: [{ artist, album, tracks }]. */
export function albumGroups(targets) {
  const groups = Map.groupBy(targets, ({ artist, album }) => JSON.stringify([artist, album]));
  return [...groups.values()].map((members) => ({ artist: members[0].artist, album: members[0].album, tracks: members.length }));
}

/**
 * The files of a package after the user sets the album `group` ({ artist, album }, as albumGroups gives it) to `to`
 * ({ artist, album }, as typed). Each track of the group keeps a `sort` only where `to` differs from what its tags and
 * folders say by themselves, so an empty field, or one set back, goes back to that.
 */
export function regroup({ packageName, files, group, to }) {
  const targets = packageTargets({ packageName, files });
  const own = packageTargets({ packageName, files: files.map((file) => ({ ...file, sort: {} })) });
  const wanted = (text, auto) => {
    const name = text.trim() ? folderName(text.trim(), auto) : auto;
    return name === auto ? null : text.trim();
  };
  return files.map((file, i) => {
    if (targets[i].artist !== group.artist || targets[i].album !== group.album) return file;
    const artist = wanted(to.artist, own[i].artist);
    const album = wanted(to.album, own[i].album);
    return { ...file, sort: { ...(artist ? { artist } : {}), ...(album ? { album } : {}) } };
  });
}

// ---------------------------------------------------------------- the artists/ tree

/** An album's picture, by its name: the better names first. */
const COVER_NAMES = [/^cover\b/i, /^folder\b/i, /^front\b/i, /^album ?art/i, /^album\b/i];
const coverRank = (name) => COVER_NAMES.findIndex((pattern) => pattern.test(name));

/** The package's pictures that can be an album's cover, the better ones first: [{ path, entry }]. */
function coversOf(files) {
  return files
    .filter(({ entry }) => isImage(entry) && coverRank(entry.name) >= 0)
    .toSorted((a, b) => coverRank(a.entry.name) - coverRank(b.entry.name) || a.path.length - b.path.length);
}

/** The cover for a track at `path` among `covers`: the nearest one in its folder or a folder above. */
function coverFor(covers, path) {
  const isAbove = (cover) => cover.path.length <= path.length && cover.path.slice(0, -1).every((name, i) => name === path[i]);
  return covers.filter(isAbove).toSorted((a, b) => b.path.length - a.path.length)[0] ?? null;
}

const coverName = (name) => `cover${(EXTENSION.exec(name)?.[0] ?? "").toLowerCase()}`;

/**
 * The artists/ tree that follows from the packages: [{ path, entry }], `path` below artists/. Every track goes to its
 * target (packageTargets), as a copy of its entry, so the same blob. `packages` is [{ name, files: [{ path, entry }] }]
 * with `path` in the package's files/.
 *
 * - The packages count in the order of their names, and their files in the order of their paths: what comes first
 *   keeps its name, a later track with the same one gets " (2)", and the same bytes (by SHA-256) twice are sorted once.
 * - An album gets a cover: the picture called cover, folder or front (any image type) next to its first track, or in a
 *   folder above it in its package, as "cover.<ext>".
 */
export function sortLibrary(packages) {
  const placed = packages
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap(({ name: packageName, files }) => {
      const tracks = packageTracks(files);
      const targets = packageTargets({ packageName, files: tracks });
      const covers = coversOf(files);
      return tracks.map(({ path, entry }, i) => ({ entry, target: targets[i], cover: coverFor(covers, path) }));
    });
  const seen = new Set();
  const unique = placed.filter(({ entry }) => {
    if (typeof entry.sha256 !== "string") return true;
    if (seen.has(entry.sha256)) return false;
    seen.add(entry.sha256);
    return true;
  });
  const albums = Map.groupBy(unique, ({ target }) => JSON.stringify([target.artist, target.album]));
  return [...albums.values()].flatMap((tracks) => {
    const { artist, album } = tracks[0].target;
    const named = tracks.reduce((done, { target, entry }) => [...done, { name: freeName(target.name, done.map((d) => d.name)), entry }], []);
    const cover = tracks.find((track) => track.cover)?.cover;
    const withCover = cover ? [...named, { name: freeName(coverName(cover.entry.name), named.map((n) => n.name)), entry: cover.entry }] : named;
    return withCover.map(({ name, entry }) => ({ path: [artist, album, name], entry }));
  });
}

/** Whether two file entries are the same, as a directory stores them. */
const sameFile = (a, b) => a.kind === "file" && b.kind === "file" && a.id === b.id && a.salt === b.salt && a.modified === b.modified && JSON.stringify(a.app) === JSON.stringify(b.app);

/**
 * What turns the tree `current` into `wanted`, both [{ path, entry }] below the same folder, `current` with its
 * folders too: { remove: [path], put: [{ path, entry }] }. A folder nothing wanted is in goes as a whole, and a file
 * that is already as wanted isn't put again, so only what changes is written.
 */
export function treeChanges(current, wanted) {
  const key = (path) => JSON.stringify(path);
  const wantedFiles = new Map(wanted.map((item) => [key(item.path), item.entry]));
  const wantedFolders = new Set(wanted.flatMap(({ path }) => path.slice(0, -1).map((_, i) => key(path.slice(0, i + 1)))));
  const keeps = ({ path, entry }) => (entry.kind === "dir" ? wantedFolders.has(key(path)) : wantedFiles.has(key(path)));
  const gone = current.filter((item) => !keeps(item));
  const goneFolders = new Set(gone.filter(({ entry }) => entry.kind === "dir").map(({ path }) => key(path)));
  const insideGone = (path) => path.slice(0, -1).some((_, i) => goneFolders.has(key(path.slice(0, i + 1))));
  const have = new Map(current.filter(({ entry }) => entry.kind === "file").map((item) => [key(item.path), item.entry]));
  return {
    remove: gone.filter(({ path }) => !insideGone(path)).map(({ path }) => path),
    put: wanted.filter(({ path, entry }) => !(have.has(key(path)) && sameFile(have.get(key(path)), entry))),
  };
}
