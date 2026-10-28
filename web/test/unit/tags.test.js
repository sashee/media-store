import { test } from "node:test";
import assert from "node:assert/strict";

import { NO_TAGS, readTags, tagsOf } from "../../public/js/tags.js";

const te = new TextEncoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
};
const bytes = (...values) => Uint8Array.from(values);
const ascii = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const be32 = (n) => bytes(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const le32 = (n) => bytes(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24);
const syncsafe = (n) => bytes((n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127);
const utf16le = (text) => Uint8Array.from([...text].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]));

/** A file the way readTags gets one, counting what it reads. */
function file(data) {
  const reads = [];
  return { size: data.length, reads, read: async (start, end) => (reads.push([start, end]), data.slice(start, end)) };
}
const tags = async (data) => readTags(file(data));
const expected = (fields) => ({ ...NO_TAGS, ...fields });

// ---------------------------------------------------------------- ID3

const id3Frame = (version, id, data) =>
  version === 2
    ? concat(ascii(id), bytes(data.length >> 16, (data.length >> 8) & 255, data.length & 255), data)
    : concat(ascii(id), version === 4 ? syncsafe(data.length) : be32(data.length), bytes(0, 0), data);
const id3 = (version, frames, flags = 0) => {
  const body = concat(...frames);
  return concat(ascii("ID3"), bytes(version, 0, flags), syncsafe(body.length), body);
};
const mp3 = (tag) => concat(tag, new Uint8Array(5000).fill(0xff));

test("ID3v2.3: ISO-8859-1 and UTF-16 text, numbers out of n/total, and a big picture skipped", async () => {
  const tag = id3(3, [
    id3Frame(3, "TIT2", concat(bytes(0), ascii("Ausl\xe4nder"))),
    id3Frame(3, "TPE1", concat(bytes(1, 0xff, 0xfe), utf16le("Rammstein"))),
    id3Frame(3, "APIC", new Uint8Array(100_000)),
    id3Frame(3, "TALB", concat(bytes(0), ascii("Zeit"))),
    id3Frame(3, "TRCK", concat(bytes(0), ascii("3/12"))),
    id3Frame(3, "TPOS", concat(bytes(0), ascii("1/2"))),
    id3Frame(3, "TYER", concat(bytes(0), ascii("2022"))),
  ]);
  assert.deepEqual(await tags(mp3(tag)), expected({ title: "Ausländer", artist: "Rammstein", album: "Zeit", track: 3, trackTotal: 12, disc: 1, discTotal: 2, year: 2022 }));
});

test("ID3v2.4: UTF-8, syncsafe frame sizes, a date for the year, the album artist; and ID3v2.2's short frames", async () => {
  const v4 = id3(4, [
    id3Frame(4, "TIT2", concat(bytes(3), te.encode("Ünder"))),
    id3Frame(4, "TPE2", concat(bytes(3), te.encode("Various Artists"))),
    id3Frame(4, "TDRC", concat(bytes(3), te.encode("2003-05-01"))),
    id3Frame(4, "TXXX", new Uint8Array(200)),
  ]);
  assert.deepEqual(await tags(mp3(v4)), expected({ title: "Ünder", albumArtist: "Various Artists", year: 2003 }));
  const v2 = id3(2, [id3Frame(2, "TT2", concat(bytes(0), ascii("Old"))), id3Frame(2, "TRK", concat(bytes(0), ascii("7")))]);
  assert.deepEqual(await tags(mp3(v2)), expected({ title: "Old", track: 7 }));
});

test("ID3v1 at the end, with v1.1's track number, when there is nothing at the start", async () => {
  const field = (text, length) => concat(ascii(text), new Uint8Array(length - text.length));
  const v1 = concat(ascii("TAG"), field("Song", 30), field("Band", 30), field("Album", 30), ascii("1999"), field("comment", 28), bytes(0, 4), bytes(12));
  assert.deepEqual(await tags(concat(new Uint8Array(3000).fill(0xff), v1)), expected({ title: "Song", artist: "Band", album: "Album", year: 1999, track: 4 }));
});

// ---------------------------------------------------------------- Vorbis comments

const vorbisComment = (...comments) =>
  concat(le32(6), ascii("vendor"), le32(comments.length), ...comments.flatMap((c) => [le32(te.encode(c).length), te.encode(c)]));

test("FLAC: the Vorbis comment block, after a big picture, read on its own", async () => {
  const block = (type, data, last = false) => concat(bytes((last ? 0x80 : 0) | type, data.length >> 16, (data.length >> 8) & 255, data.length & 255), data);
  const flac = concat(
    ascii("fLaC"),
    block(0, new Uint8Array(34)),
    block(6, new Uint8Array(300_000)),
    block(4, vorbisComment("TITLE=Sonne", "artist=Rammstein", "ALBUMARTIST=Rammstein", "ALBUM=Mutter", "TRACKNUMBER=2", "TRACKTOTAL=11", "DISCNUMBER=1", "DATE=2001")),
    block(1, new Uint8Array(10), true),
    new Uint8Array(1000),
  );
  const read = file(flac);
  assert.deepEqual(await readTags(read), expected({ title: "Sonne", artist: "Rammstein", albumArtist: "Rammstein", album: "Mutter", track: 2, trackTotal: 11, disc: 1, year: 2001 }));
  assert.ok(read.reads.every(([start, end]) => end - start < 100_000), "the picture isn't read");
});

/** Ogg pages carrying `packets`, cut into segments of up to 255 bytes, one page per `perPage` segments. */
function ogg(packets, perPage = 255) {
  const segments = packets.flatMap((packet) => {
    const lengths = [];
    for (let left = packet.length; ; left -= 255) {
      lengths.push(Math.min(left, 255));
      if (left < 255) break;
    }
    let at = 0;
    return lengths.map((length) => {
      const part = packet.subarray(at, at + length);
      at += length;
      return part;
    });
  });
  const pages = [];
  for (let i = 0; i < segments.length; i += perPage) {
    const chunk = segments.slice(i, i + perPage);
    pages.push(concat(ascii("OggS"), new Uint8Array(10), le32(1), le32(pages.length), new Uint8Array(4), bytes(chunk.length), Uint8Array.from(chunk.map((s) => s.length)), ...chunk));
  }
  return concat(...pages);
}

test("Ogg: Opus's and Vorbis's comment packets, also across pages", async () => {
  const opusTags = concat(ascii("OpusTags"), vorbisComment("TITLE=Opus song", "ALBUM=" + "x".repeat(600)));
  assert.deepEqual(await tags(ogg([ascii("OpusHead"), opusTags], 2)), expected({ title: "Opus song", album: "x".repeat(300) }));
  const vorbis = concat(bytes(3), ascii("vorbis"), vorbisComment("TITLE=Vorbis song", "DISCNUMBER=2/2"));
  assert.deepEqual(await tags(ogg([concat(bytes(1), ascii("vorbis")), vorbis])), expected({ title: "Vorbis song", disc: 2, discTotal: 2 }));
});

// ---------------------------------------------------------------- MP4

const box = (type, ...children) => {
  const body = concat(...children);
  return concat(be32(8 + body.length), ascii(type), body);
};
const item = (type, value, kind = 1) => box(type, box("data", be32(kind), be32(0), value));

test("MP4: the ilst items in moov, also when moov comes after the audio", async () => {
  const moov = box(
    "moov",
    box("mvhd", new Uint8Array(100)),
    box("udta", box("meta", be32(0), box("hdlr", new Uint8Array(25)), box("ilst",
      item("\xa9nam", te.encode("M4A song")),
      item("\xa9ART", te.encode("Artist")),
      item("aART", te.encode("Album Artist")),
      item("\xa9alb", te.encode("Album")),
      item("trkn", bytes(0, 0, 0, 5, 0, 10, 0, 0), 0),
      item("disk", bytes(0, 0, 0, 1, 0, 1), 0),
      item("\xa9day", te.encode("2010-01-01T00:00:00Z")),
    ))),
  );
  const m4a = concat(box("ftyp", ascii("M4A "), be32(0)), box("mdat", new Uint8Array(200_000)), moov);
  const read = file(m4a);
  assert.deepEqual(await readTags(read), expected({ title: "M4A song", artist: "Artist", albumArtist: "Album Artist", album: "Album", track: 5, trackTotal: 10, disc: 1, discTotal: 1, year: 2010 }));
  assert.ok(read.reads.every(([start, end]) => end - start < 100_000), "the audio isn't read");
});

// ---------------------------------------------------------------- RIFF

test("WAV: the LIST/INFO chunk, after the audio", async () => {
  const chunk = (id, data) => concat(ascii(id), le32(data.length), data, data.length % 2 ? bytes(0) : bytes());
  const info = concat(ascii("INFO"), chunk("INAM", te.encode("Wav song\0")), chunk("IART", te.encode("Wav artist\0")), chunk("IPRD", te.encode("Wav album\0")), chunk("ITRK", te.encode("4\0")));
  const body = concat(ascii("WAVE"), chunk("fmt ", new Uint8Array(16)), chunk("data", new Uint8Array(5001)), chunk("LIST", info));
  const wav = concat(ascii("RIFF"), le32(body.length), body);
  assert.deepEqual(await tags(wav), expected({ title: "Wav song", artist: "Wav artist", album: "Wav album", track: 4 }));
});

// ---------------------------------------------------------------- what isn't

test("a file without tags, or with broken ones, has none, and nothing throws", async () => {
  for (const data of [
    new Uint8Array(0),
    te.encode("not audio at all"),
    concat(ascii("ID3"), bytes(3, 0, 0), syncsafe(1_000_000), ascii("TIT2")),
    concat(ascii("fLaC"), bytes(4, 255, 255, 255)),
    ogg([ascii("OpusHead")]),
    concat(box("ftyp", ascii("M4A ")), concat(be32(999_999), ascii("moov"))),
    concat(ascii("RIFF"), le32(4), ascii("WAVE"), ascii("LIST"), le32(99999)),
  ]) {
    assert.deepEqual(await tags(data), NO_TAGS);
  }
});

test("tag text is cleaned: control characters, trailing NULs and length", () => {
  assert.deepEqual(tagsOf({ title: "a\tb\u0000\u0000", track: "x", date: "unknown", artist: "y".repeat(400) }), expected({ title: "a b", artist: "y".repeat(300) }));
});
