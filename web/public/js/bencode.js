// Bencoding (BEP 3), the format of .torrent files: decoding only, of untrusted input. Integers are numbers, byte strings
// stay bytes (Uint8Array), lists are arrays, and dictionaries are Maps with their keys read as UTF-8, so a key like
// "__proto__" (a file name in a v2 file tree) is only a key.

export class BencodeError extends Error {
  constructor(message) {
    super(`Not a torrent file: ${message}`);
    this.name = "BencodeError";
  }
}

/** Nesting deeper than any real torrent goes: past it, the input is refused rather than exhausting the stack. */
const MAX_DEPTH = 100;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const DIGIT = (byte) => byte >= 0x30 && byte <= 0x39;

/**
 * The value in `bytes`, which must be exactly one bencoded value. → { value, spans }: `spans` maps each key of the
 * top-level dictionary to its value's [start, end) in `bytes`, for hashing the info dictionary as it was written.
 */
export function decode(bytes) {
  const spans = new Map();
  const { value, end } = valueAt(bytes, 0, 0, spans);
  if (end !== bytes.length) throw new BencodeError("there are bytes after its end");
  return { value, spans };
}

function valueAt(bytes, at, depth, spans) {
  if (depth > MAX_DEPTH) throw new BencodeError("it is nested too deeply");
  const byte = bytes[at];
  if (byte === 0x69) return integerAt(bytes, at); // i
  if (byte === 0x6c) return listAt(bytes, at, depth); // l
  if (byte === 0x64) return dictionaryAt(bytes, at, depth, depth === 0 ? spans : null); // d
  if (byte !== undefined && DIGIT(byte)) return stringAt(bytes, at);
  throw new BencodeError(byte === undefined ? "it ends too early" : `unexpected byte ${byte} at ${at}`);
}

function integerAt(bytes, at) {
  const end = bytes.indexOf(0x65, at); // e
  if (end < 0) throw new BencodeError("an integer doesn't end");
  const text = String.fromCharCode(...bytes.subarray(at + 1, end));
  if (!/^(0|-?[1-9][0-9]*)$/.test(text)) throw new BencodeError(`"${text}" isn't an integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new BencodeError(`${text} is too large`);
  return { value, end: end + 1 };
}

function stringAt(bytes, at) {
  const colon = bytes.indexOf(0x3a, at); // :
  if (colon < 0 || colon - at > 16) throw new BencodeError("a string's length doesn't end");
  const text = String.fromCharCode(...bytes.subarray(at, colon));
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new BencodeError(`"${text}" isn't a length`);
  const start = colon + 1;
  const end = start + Number(text);
  if (end > bytes.length) throw new BencodeError("a string runs past the end");
  return { value: bytes.subarray(start, end), end };
}

function listAt(bytes, at, depth) {
  const items = [];
  let next = at + 1;
  while (bytes[next] !== 0x65) {
    const { value, end } = valueAt(bytes, next, depth + 1, null);
    items.push(value);
    next = end;
  }
  return { value: items, end: next + 1 };
}

function dictionaryAt(bytes, at, depth, spans) {
  const entries = new Map();
  let next = at + 1;
  while (bytes[next] !== 0x65) {
    const key = stringAt(bytes, next);
    let name;
    try {
      name = utf8.decode(key.value);
    } catch {
      throw new BencodeError("a dictionary key isn't text");
    }
    const { value, end } = valueAt(bytes, key.end, depth + 1, null);
    if (entries.has(name)) throw new BencodeError(`the key "${name}" appears twice`);
    entries.set(name, value);
    spans?.set(name, [key.end, end]);
    next = end;
  }
  return { value: entries, end: next + 1 };
}

/** Bytes as text (UTF-8), or null when they aren't valid UTF-8. */
export function text(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}
