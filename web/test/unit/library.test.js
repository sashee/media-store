import { test } from "node:test";
import assert from "node:assert/strict";

import { labels } from "../../public/sdk/labels.js";
import { LABELS } from "../../public/js/labels.js";
import { freeName, isAudio, isImage, isTrack, nameFor, parsePlayUrl, playUrl, playUrlBlob, titleOf, trackOf, typeOf, typeOfEntry, unplayable, walk } from "../../public/js/library.js";

const ID = "ab".repeat(32);
const SALT = "cd".repeat(16);

test("the namespace never changes: every key and blob of a library is bound to it", () => {
  assert.deepEqual(LABELS, labels("media-store"));
  assert.equal(LABELS.prf, "media-store/prf/v1");
  assert.equal(LABELS.file, "media-store/file/v1");
});

test("a file's type is the browser's, or else from its extension", () => {
  assert.equal(typeOf({ name: "a.mp3", type: "audio/mpeg" }), "audio/mpeg");
  assert.equal(typeOf({ name: "a.bin", type: "Audio/FLAC" }), "audio/flac");
  assert.equal(typeOf({ name: "Song.OPUS", type: "" }), "audio/ogg");
  assert.equal(typeOf({ name: "song.m4a", type: "" }), "audio/mp4");
  assert.equal(typeOf({ name: "a.mp3", type: "audio/ogg; codecs=opus" }), "audio/mpeg", "a type with parameters isn't taken");
  assert.equal(typeOf({ name: "noextension", type: "" }), "");
  assert.equal(typeOf({ name: "a.xyz", type: "" }), "");
});

test("a file is refused when its type is unknown, isn't audio, or the browser can't play it", () => {
  const canPlay = (type) => (type === "audio/mpeg" ? "maybe" : "");
  assert.equal(unplayable("audio/mpeg", canPlay), null);
  assert.match(unplayable("", canPlay), /unknown/);
  assert.match(unplayable("text/plain", canPlay), /isn't audio/);
  assert.match(unplayable("audio/flac", canPlay), /can't play audio\/flac/);
});

test("titles are file names without the extension", () => {
  assert.equal(titleOf("01 - Song.mp3"), "01 - Song");
  assert.equal(titleOf("a.b.flac"), "a.b");
  assert.equal(titleOf("noextension"), "noextension");
  assert.equal(titleOf(".mp3"), ".mp3");
});

test("names the tree takes: no slashes or control characters, at most 200 bytes, never empty", () => {
  assert.equal(nameFor("Song.mp3"), "Song.mp3");
  assert.equal(nameFor("a/b\u0000c.mp3"), "abc.mp3");
  assert.equal(nameFor("  ..  "), "track");
  assert.equal(nameFor(""), "track");
  const long = nameFor(`${"é".repeat(150)}.mp3`);
  assert.ok(new TextEncoder().encode(long).length <= 200);
  assert.equal(long, "é".repeat(100), "cut at a character, not inside one");
  assert.equal(nameFor("e\u0301.mp3"), "\u00e9.mp3", "normalised to NFC");
});

test("a taken name gets a number before its extension", () => {
  assert.equal(freeName("a.mp3", []), "a.mp3");
  assert.equal(freeName("a.mp3", ["a.mp3"]), "a (2).mp3");
  assert.equal(freeName("a.mp3", ["a.mp3", "a (2).mp3"]), "a (3).mp3");
  assert.equal(freeName("noext", ["noext"]), "noext (2)");
});

test("tracks come from file entries: their path tells them apart, the title is the tag's or the name's", () => {
  const entry = (name, app) => ({ kind: "file", name, id: ID, salt: SALT, size: 3, sha256: ID, modified: "2026-10-24T00:00:00.000Z", ...(app ? { app } : {}) });
  assert.deepEqual(trackOf(entry("01 Bee.mp3", { type: "audio/mpeg", tags: { title: "Bee" } }), ["uploads", "p", "files"]), {
    name: "uploads/p/files/01 Bee.mp3",
    title: "Bee",
    type: "audio/mpeg",
    size: 3,
    id: ID,
    salt: SALT,
    sha256: ID,
    app: { type: "audio/mpeg", tags: { title: "Bee" } },
  });
  assert.deepEqual([trackOf(entry("c.ogg")).title, trackOf(entry("c.ogg")).type], ["c", "audio/ogg"]);
  const odd = trackOf(entry("d", { tags: { title: 5 }, type: "audio/mpeg\r\nX-Evil: 1" }));
  assert.deepEqual([odd.title, odd.type], ["d", "application/octet-stream"]);
  assert.equal(typeOfEntry(entry("x.flac")), "audio/flac");
  assert.equal(isAudio(entry("x.flac")), true);
  assert.equal(isAudio(entry("cover.jpg", { type: "image/jpeg" })), false);
  assert.equal(isImage(entry("cover.jpg", { type: "image/jpeg" })), true);
  assert.equal(isImage(entry("Folder.PNG")), true, "by its extension");
  assert.equal(isImage(entry("x.flac")), false);
  assert.equal(isAudio({ kind: "dir", name: "a.mp3", id: ID, salt: SALT }), false);
});

test("folders' names get numbers without an extension", () => {
  assert.equal(freeName("Vol. 2", ["Vol. 2"], { extension: false }), "Vol. 2 (2)");
  assert.equal(nameFor("", "Upload"), "Upload");
});

test("play URLs round-trip, and anything else isn't one", () => {
  const track = { id: ID, salt: SALT, size: 12345, type: "audio/mpeg" };
  const url = new URL(playUrl(track), "http://localhost");
  assert.equal(url.pathname, `/play/${ID}`);
  assert.deepEqual(parsePlayUrl(url), track);
  const broken = (change) => {
    const copy = new URL(url);
    change(copy);
    return parsePlayUrl(copy);
  };
  assert.equal(broken((u) => (u.pathname = "/play/../api")), null);
  assert.equal(broken((u) => (u.pathname = `/play/${ID}/x`)), null);
  assert.equal(broken((u) => u.searchParams.set("salt", "zz")), null);
  assert.equal(broken((u) => u.searchParams.set("size", "-1")), null);
  assert.equal(broken((u) => u.searchParams.set("size", "")), null);
  assert.equal(broken((u) => u.searchParams.set("type", "audio/mpeg\r\nX: 1")), null);
  assert.equal(broken((u) => u.searchParams.delete("type")), null);
});

test("playlists aren't tracks, whatever audio type they claim", () => {
  const entry = (name, type) => ({ kind: "file", name, id: ID, salt: SALT, size: 3, sha256: ID, modified: "2026-10-25T00:00:00.000Z", app: { type } });
  assert.equal(isAudio(entry("album.m3u", "audio/x-mpegurl")), false);
  assert.equal(isAudio(entry("album.m3u8", "")), false);
  assert.equal(isAudio(entry("list.pls", "audio/x-scpls")), false);
  assert.equal(isAudio(entry("odd.txt", "audio/mpegurl")), false, "by its type alone");
  assert.equal(isAudio(entry("song.mp3", "audio/mpeg")), true);
  assert.equal(isTrack({ name: "a.xspf", type: "application/xspf+xml" }), false);
  assert.equal(isTrack({ name: "a.flac", type: "audio/flac" }), true);
});

test("walking a folder: everything below it, folders first, paths relative to it", async () => {
  const tree = { "": ["a", "x.mp3"], a: ["b", "y.mp3"], "a/b": [] };
  const list = async (path) => tree[path.slice(1).join("/")].map((name) => ({ name, kind: name.includes(".") ? "file" : "dir" }));
  const walked = await walk(list, ["root"]);
  assert.deepEqual(walked.map(({ path, entry }) => [path.join("/"), entry.kind]), [["a", "dir"], ["a/b", "dir"], ["a/y.mp3", "file"], ["x.mp3", "file"]]);
});

test("a play URL's blob, for telling which track an error is of", () => {
  const track = { id: "a".repeat(64), salt: "b".repeat(32), size: 1234, type: "audio/flac" };
  assert.equal(playUrlBlob(`http://x.localhost:1${playUrl(track)}`), track.id);
  assert.equal(playUrlBlob("http://x.localhost:1/api/v1/me"), null);
  assert.equal(playUrlBlob("not a url"), null);
  assert.equal(playUrlBlob(undefined), null);
});
