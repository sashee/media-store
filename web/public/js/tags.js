// Tags inside audio files (SPEC §5.3): title, artist, album artist, album, track and disc numbers, and year, for
// sorting. Read in the browser, from only the parts of a file that hold them: ID3v2 (and ID3v1) for MP3, FLAC's Vorbis
// comment, Ogg Vorbis and Opus comments, MP4's ilst atoms, and RIFF INFO for WAV. Untrusted input: anything malformed
// yields no tags rather than an error, and nothing is read past MAX_TAG bytes.

/** The most read for one tag block: embedded cover art makes them big, but not bigger than this. */
const MAX_TAG = 16 * 1024 * 1024;

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");
const ascii = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
const be32 = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const le32 = (b, at) => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + ((b[at + 3] << 24) >>> 0);
const syncsafe = (b, at) => (b[at] << 21) | (b[at + 1] << 14) | (b[at + 2] << 7) | b[at + 3];

export const NO_TAGS = Object.freeze({ title: "", artist: "", albumArtist: "", album: "", track: null, trackTotal: null, disc: null, discTotal: null, year: null });

/** "3/12" → { n: 3, total: 12 }; anything else → nulls. */
function numberPair(value) {
  const match = /^\s*(\d{1,4})\s*(?:\/\s*(\d{1,4}))?/.exec(String(value ?? ""));
  return { n: match ? Number(match[1]) || null : null, total: match?.[2] ? Number(match[2]) || null : null };
}

const yearOf = (value) => {
  const match = /(\d{4})/.exec(String(value ?? ""));
  return match ? Number(match[1]) : null;
};

/** The tags from raw fields: { title, artist, albumArtist, album, track ("3/12"), disc, date }. */
export function tagsOf(fields) {
  const clean = (value) => String(value ?? "").replace(/\u0000+$/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300);
  const track = numberPair(fields.track);
  const disc = numberPair(fields.disc);
  return {
    title: clean(fields.title),
    artist: clean(fields.artist),
    albumArtist: clean(fields.albumArtist),
    album: clean(fields.album),
    track: track.n,
    trackTotal: fields.trackTotal ?? track.total,
    disc: disc.n,
    discTotal: fields.discTotal ?? disc.total,
    year: yearOf(fields.date),
  };
}

// ---------------------------------------------------------------- ID3

/** ID3v2 text: its first byte says the encoding (ISO-8859-1, UTF-16 with BOM, UTF-16BE, UTF-8); the first value only. */
function id3Text(bytes) {
  const body = bytes.subarray(1);
  const decoded = (() => {
    switch (bytes[0]) {
      case 1:
        return body[0] === 0xfe && body[1] === 0xff ? new TextDecoder("utf-16be").decode(body.subarray(2)) : new TextDecoder("utf-16le").decode(body[0] === 0xff ? body.subarray(2) : body);
      case 2:
        return new TextDecoder("utf-16be").decode(body);
      case 3:
        return utf8.decode(body);
      default:
        return latin1.decode(body);
    }
  })();
  return decoded.split("\u0000")[0];
}

/** Reverses ID3's unsynchronisation: every 0xFF 0x00 was a 0xFF. */
function resync(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]);
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return Uint8Array.from(out);
}

const ID3_FIELDS = {
  TIT2: "title", TPE1: "artist", TPE2: "albumArtist", TALB: "album", TRCK: "track", TPOS: "disc", TDRC: "date", TYER: "date",
  TT2: "title", TP1: "artist", TP2: "albumArtist", TAL: "album", TRK: "track", TPA: "disc", TYE: "date",
};

/** The fields of an ID3v2 tag: `tag` is the whole of it, header included. */
export function parseId3v2(tag) {
  if (ascii(tag, 0, 3) !== "ID3") return {};
  const version = tag[3];
  const flags = tag[5];
  const end = Math.min(tag.length, 10 + syncsafe(tag, 6));
  let body = tag.subarray(10, end);
  if (version < 4 && flags & 0x80) body = resync(body);
  let at = 0;
  if (flags & 0x40) at = version === 3 ? 4 + be32(body, 0) : version === 4 ? syncsafe(body, 0) : 0;
  const idLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;
  const fields = {};
  while (at + headerLength <= body.length && body[at] !== 0) {
    const id = ascii(body, at, idLength);
    const size = version === 2 ? (body[at + 3] << 16) | (body[at + 4] << 8) | body[at + 5] : version === 4 ? syncsafe(body, at + 4) : be32(body, at + 4);
    const formatFlags = version === 2 ? 0 : body[at + 9];
    let data = body.subarray(at + headerLength, at + headerLength + size);
    at += headerLength + size;
    const field = ID3_FIELDS[id];
    // Compressed or encrypted frames are skipped; v2.4's unsynchronised ones are resynced, its length indicator dropped.
    if (!field || fields[field] || (version === 3 && formatFlags & 0xc0) || (version === 4 && formatFlags & 0x0c)) continue;
    if (version === 4 && formatFlags & 0x02) data = resync(data);
    if (version === 4 && formatFlags & 0x01) data = data.subarray(4);
    if (data.length > 0) fields[field] = id3Text(data);
  }
  return fields;
}

/** The fields of an ID3v1 tag: the last 128 bytes of an MP3. */
export function parseId3v1(bytes) {
  if (bytes.length !== 128 || ascii(bytes, 0, 3) !== "TAG") return {};
  const field = (from, length) => latin1.decode(bytes.subarray(from, from + length)).split("\u0000")[0].trim();
  // ID3v1.1: a zero byte before the last byte of the comment makes that byte the track number.
  const track = bytes[125] === 0 && bytes[126] !== 0 ? String(bytes[126]) : "";
  return { title: field(3, 30), artist: field(33, 30), album: field(63, 30), date: field(93, 4), track };
}

// ---------------------------------------------------------------- Vorbis comments (FLAC, Ogg Vorbis, Opus)

const VORBIS_FIELDS = { TITLE: "title", ARTIST: "artist", ALBUMARTIST: "albumArtist", "ALBUM ARTIST": "albumArtist", ALBUM: "album", TRACKNUMBER: "track", DISCNUMBER: "disc", DATE: "date", YEAR: "date", TRACKTOTAL: "trackTotal", TOTALTRACKS: "trackTotal", DISCTOTAL: "discTotal", TOTALDISCS: "discTotal" };

/** The fields of a Vorbis comment block: a vendor string, then KEY=value pairs, all little-endian lengths. */
export function parseVorbisComment(bytes) {
  const fields = {};
  if (bytes.length < 8) return fields;
  let at = 4 + le32(bytes, 0);
  const count = le32(bytes, at);
  at += 4;
  for (let i = 0; i < count && at + 4 <= bytes.length; i++) {
    const length = le32(bytes, at);
    const comment = utf8.decode(bytes.subarray(at + 4, at + 4 + length));
    at += 4 + length;
    const equals = comment.indexOf("=");
    const field = VORBIS_FIELDS[comment.slice(0, equals).toUpperCase()];
    if (equals > 0 && field && fields[field] === undefined) fields[field] = comment.slice(equals + 1);
  }
  if (fields.trackTotal !== undefined) fields.trackTotal = Number(fields.trackTotal) || null;
  if (fields.discTotal !== undefined) fields.discTotal = Number(fields.discTotal) || null;
  return fields;
}

/** The comment packet of an Ogg stream: the second packet of the first logical stream, put together from its pages. */
export function oggCommentPacket(bytes) {
  const packets = [];
  let current = [];
  let at = 0;
  let serial = null;
  while (at + 27 <= bytes.length && ascii(bytes, at, 4) === "OggS" && packets.length < 2) {
    const pageSerial = le32(bytes, at + 14);
    const segments = bytes[at + 26];
    const table = bytes.subarray(at + 27, at + 27 + segments);
    let body = at + 27 + segments;
    serial ??= pageSerial;
    for (const length of table) {
      if (pageSerial === serial) current.push(bytes.subarray(body, body + length));
      body += length;
      if (length < 255 && pageSerial === serial) {
        packets.push(join(current));
        current = [];
      }
    }
    at = body;
  }
  return packets.length >= 2 ? packets[1] : null;
}

/** The Vorbis comment inside an Ogg comment packet: Vorbis's ("\x03vorbis") or Opus's ("OpusTags"). */
export function parseOggComment(packet) {
  if (!packet) return {};
  if (packet[0] === 3 && ascii(packet, 1, 6) === "vorbis") return parseVorbisComment(packet.subarray(7));
  if (ascii(packet, 0, 8) === "OpusTags") return parseVorbisComment(packet.subarray(8));
  return {};
}

// ---------------------------------------------------------------- MP4

/** The atoms in `bytes`, as { type, body }; 64-bit sizes are understood, and one running past the end ends the list. */
function atoms(bytes) {
  const found = [];
  let at = 0;
  while (at + 8 <= bytes.length) {
    let size = be32(bytes, at);
    let header = 8;
    if (size === 1) {
      size = be32(bytes, at + 8) * 2 ** 32 + be32(bytes, at + 12);
      header = 16;
    }
    if (size === 0) size = bytes.length - at;
    if (size < header || at + size > bytes.length) break;
    found.push({ type: latin1.decode(bytes.subarray(at + 4, at + 8)), body: bytes.subarray(at + header, at + size) });
    at += size;
  }
  return found;
}

const child = (bytes, type) => atoms(bytes).find((atom) => atom.type === type)?.body ?? null;

const MP4_TEXT = { "©nam": "title", "©ART": "artist", aART: "albumArtist", "©alb": "album", "©day": "date" };

/** The fields of an MP4 `moov` atom's body: moov/udta/meta/ilst, whose items hold "data" atoms. */
export function parseMoov(moov) {
  const udta = child(moov, "udta");
  const meta = udta && child(udta, "meta");
  // `meta` is a full box: four bytes of version and flags come first.
  const ilst = meta && child(meta.subarray(4), "ilst");
  const fields = {};
  for (const { type, body } of ilst ? atoms(ilst) : []) {
    const data = child(body, "data");
    if (!data || data.length < 8) continue;
    const value = data.subarray(8);
    if (MP4_TEXT[type]) fields[MP4_TEXT[type]] ??= utf8.decode(value);
    if ((type === "trkn" || type === "disk") && value.length >= 6) {
      const n = (value[2] << 8) | value[3];
      const total = (value[4] << 8) | value[5];
      fields[type === "trkn" ? "track" : "disc"] = total ? `${n}/${total}` : String(n);
    }
  }
  return fields;
}

// ---------------------------------------------------------------- RIFF (WAV)

const RIFF_FIELDS = { INAM: "title", IART: "artist", IPRD: "album", ITRK: "track", IPRT: "track", ICRD: "date" };

/** The fields of a RIFF LIST/INFO chunk's body (after "INFO"). */
export function parseRiffInfo(bytes) {
  const fields = {};
  let at = 0;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, 4);
    const size = le32(bytes, at + 4);
    const value = bytes.subarray(at + 8, at + 8 + size);
    const field = RIFF_FIELDS[id];
    if (field) fields[field] ??= textOf(value).split("\u0000")[0];
    at += 8 + size + (size % 2);
  }
  return fields;
}

/** UTF-8 if it is valid, else ISO-8859-1: RIFF says nothing of its encoding. */
function textOf(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

// ---------------------------------------------------------------- reading a file

function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
}

/** Top-level boxes or chunks from `start`, read header by header: { type, at, size, header } of the one `wanted`. */
async function findTop(read, size, start, wanted, { littleEndian = false, pad = false } = {}) {
  let at = start;
  for (let i = 0; i < 10_000 && at + 8 <= size; i++) {
    const head = await read(at, Math.min(at + 16, size));
    const type = ascii(head, littleEndian ? 0 : 4, 4);
    let length = littleEndian ? le32(head, 4) : be32(head, 0);
    let header = 8;
    if (!littleEndian && length === 1 && head.length >= 16) {
      length = be32(head, 8) * 2 ** 32 + be32(head, 12);
      header = 16;
    }
    if (!littleEndian && length === 0) length = size - at;
    if (type === wanted) return { at, size: length, header };
    if (length < (littleEndian ? 0 : header)) return null;
    at += (littleEndian ? 8 : 0) + length + (pad ? length % 2 : 0);
  }
  return null;
}

/**
 * The tags of an audio file ({ size, read(start, end) → Promise<Uint8Array> }), reading only what holds them: NO_TAGS
 * for a file without any, or one that isn't what it seems.
 */
export async function readTags({ size, read }) {
  try {
    return tagsOf(await fieldsOf(size, read));
  } catch {
    return NO_TAGS;
  }
}

async function fieldsOf(size, read) {
  const head = await read(0, Math.min(size, 64 * 1024));
  const capped = (start, end) => read(start, Math.min(end, start + MAX_TAG, size));
  if (ascii(head, 0, 3) === "ID3") {
    const tagSize = 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
    const fields = parseId3v2(await capped(0, tagSize));
    return Object.keys(fields).length ? fields : parseId3v1(await read(size - 128, size));
  }
  if (ascii(head, 0, 4) === "fLaC") {
    let at = 4;
    for (let i = 0; i < 128 && at + 4 <= size; i++) {
      const header = await read(at, at + 4);
      const type = header[0] & 0x7f;
      const length = (header[1] << 16) | (header[2] << 8) | header[3];
      if (type === 4) return parseVorbisComment(await capped(at + 4, at + 4 + length));
      if (header[0] & 0x80) break;
      at += 4 + length;
    }
    return {};
  }
  if (ascii(head, 0, 4) === "OggS") {
    const small = oggCommentPacket(head);
    return parseOggComment(small ?? oggCommentPacket(await capped(0, MAX_TAG)));
  }
  if (ascii(head, 4, 4) === "ftyp") {
    const moov = await findTop(read, size, 0, "moov");
    return moov ? parseMoov(await capped(moov.at + moov.header, moov.at + moov.size)) : {};
  }
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE") {
    let at = 12;
    for (let i = 0; i < 64; i++) {
      const list = await findTop(read, size, at, "LIST", { littleEndian: true, pad: true });
      if (!list) return {};
      const body = await capped(list.at + 8, list.at + 8 + list.size);
      if (ascii(body, 0, 4) === "INFO") return parseRiffInfo(body.subarray(4));
      at = list.at + 8 + list.size + (list.size % 2);
    }
    return {};
  }
  return size >= 128 ? parseId3v1(await read(size - 128, size)) : {};
}

// ---------------------------------------------------------------- length (SPEC §5.9)

const le16 = (b, at) => b[at] | (b[at + 1] << 8);

// MPEG audio frame headers: sample rates by version (3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5), and kbit/s by bitrate index.
const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MPEG1_LAYER3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG1_LAYER2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const MPEG2_LAYERS23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/**
 * The MPEG audio frame (Layer II or III) whose header is at `at`: { rate, bitrate (bit/s), samples (per frame),
 * length (bytes), xing (where a Layer III frame's Xing header would be) }; null if there is none.
 */
function mpegFrame(b, at) {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1] >> 3) & 3;
  const layer = (b[at + 1] >> 1) & 3;
  const bitrateIndex = b[at + 2] >> 4;
  const rateIndex = (b[at + 2] >> 2) & 3;
  if (version === 1 || (layer !== 1 && layer !== 2) || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const rate = MPEG_RATES[version][rateIndex];
  const bitrate = (mpeg1 ? (layer === 1 ? MPEG1_LAYER3 : MPEG1_LAYER2) : MPEG2_LAYERS23)[bitrateIndex] * 1000;
  const samples = layer === 1 && !mpeg1 ? 576 : 1152;
  const mono = b[at + 3] >> 6 === 3;
  return {
    rate,
    bitrate,
    samples,
    length: Math.floor((samples / 8) * (bitrate / rate)) + ((b[at + 2] >> 1) & 1),
    xing: layer === 1 ? at + 4 + (mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17) : null,
  };
}

/** An MP3's length from its first frame at or after `start`: its Xing or VBRI frame count, else its bitrate. */
async function mpegSeconds(read, size, start) {
  const head = await read(start, Math.min(size, start + 64 * 1024));
  // A frame is one whose next frame follows it, so stray bytes that look like a header don't count.
  const at = head.findIndex((_, i) => {
    const frame = mpegFrame(head, i);
    return frame !== null && (i + frame.length + 4 > head.length || mpegFrame(head, i + frame.length) !== null);
  });
  if (at < 0) return null;
  const frame = mpegFrame(head, at);
  const tag = frame.xing !== null ? ascii(head, frame.xing, 4) : "";
  if ((tag === "Xing" || tag === "Info") && be32(head, frame.xing + 4) & 1) return (be32(head, frame.xing + 8) * frame.samples) / frame.rate;
  if (ascii(head, at + 36, 4) === "VBRI") return (be32(head, at + 36 + 14) * frame.samples) / frame.rate;
  return ((size - start - at) * 8) / frame.bitrate;
}

/** FLAC's length from its STREAMINFO, the first metadata block: its total samples over its sample rate. */
async function flacSeconds(read, start) {
  const info = await read(start + 8, start + 26);
  const rate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
  const total = (info[13] & 0x0f) * 2 ** 32 + be32(info, 14);
  return rate > 0 && total > 0 ? total / rate : null;
}

/** An Ogg Opus or Vorbis stream's length: the granule position of its last page, from the first page's rate. */
async function oggSeconds(read, size, head) {
  const serial = le32(head, 14);
  const packet = head.subarray(27 + head[26]);
  const opus = ascii(packet, 0, 8) === "OpusHead";
  const rate = opus ? 48000 : packet[0] === 1 && ascii(packet, 1, 6) === "vorbis" ? le32(packet, 12) : 0;
  if (!rate) return null;
  const preSkip = opus ? le16(packet, 10) : 0;
  const tail = await read(Math.max(0, size - 64 * 1024), size);
  for (let at = tail.length - 27; at >= 0; at--) {
    if (tail[at] !== 0x4f || ascii(tail, at, 4) !== "OggS" || le32(tail, at + 14) !== serial) continue;
    const [low, high] = [le32(tail, at + 6), le32(tail, at + 10)];
    // -1: no packet ends on that page.
    if (low !== 0xffffffff || high !== 0xffffffff) return Math.max(0, high * 2 ** 32 + low - preSkip) / rate;
  }
  return null;
}

/** MP4's length from moov/mvhd: its duration over its timescale. */
async function mp4Seconds(read, size) {
  const moov = await findTop(read, size, 0, "moov");
  const mvhd = moov && (await findTop(read, moov.at + moov.size, moov.at + moov.header, "mvhd"));
  if (!mvhd) return null;
  const box = await read(mvhd.at + mvhd.header, mvhd.at + mvhd.header + 32);
  const v1 = box[0] === 1;
  const scale = be32(box, v1 ? 20 : 12);
  const length = v1 ? be32(box, 24) * 2 ** 32 + be32(box, 28) : be32(box, 16);
  return scale > 0 ? length / scale : null;
}

/** WAV's length: its data chunk's bytes (as many as the file has) over the format's bytes per second. */
async function wavSeconds(read, size) {
  const chunk = (id) => findTop(read, size, 12, id, { littleEndian: true, pad: true });
  const [format, data] = [await chunk("fmt "), await chunk("data")];
  if (!format || !data) return null;
  const byteRate = le32(await read(format.at + 8, format.at + 24), 8);
  return byteRate > 0 ? Math.min(data.size, size - data.at - 8) / byteRate : null;
}

async function secondsOf(size, read) {
  const first = await read(0, Math.min(size, 64 * 1024));
  // An ID3v2 tag comes first in MP3s, and now and then in front of FLAC.
  const start = ascii(first, 0, 3) === "ID3" ? 10 + syncsafe(first, 6) + (first[5] & 0x10 ? 10 : 0) : 0;
  const head = start === 0 ? first : await read(start, Math.min(size, start + 64 * 1024));
  if (ascii(head, 0, 4) === "fLaC") return flacSeconds(read, start);
  if (start === 0 && ascii(head, 0, 4) === "OggS") return oggSeconds(read, size, head);
  if (start === 0 && ascii(head, 4, 4) === "ftyp") return mp4Seconds(read, size);
  if (start === 0 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE") return wavSeconds(read, size);
  return mpegSeconds(read, size, start);
}

/**
 * How long an audio file ({ size, read(start, end) }, as for readTags) plays, in seconds, from its headers alone: MP3
 * (its Xing or VBRI frame count, else its bitrate), FLAC, Ogg Opus and Vorbis, MP4 and WAV. An estimate, to tell
 * whether decoding it whole is safe (SPEC §5.9); null for any other kind of file, or one that isn't what it seems.
 */
export async function readDuration({ size, read }) {
  try {
    const seconds = await secondsOf(size, read);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  } catch {
    return null;
  }
}
