// Serving a track to the browser's own HTTP client (SPEC §6): the page answers the <audio> element's requests, which the
// Service Worker passes on, `Range` included, with the track read in ranges. Nothing here but `Response`; the read is
// passed in.

import { IntegrityError } from "../sdk/api.js";

/** A byte position from a `Range` header; past any safe integer is past any file. */
const position = (digits) => (digits === "" ? null : Math.min(Number(digits), Number.MAX_SAFE_INTEGER));

/**
 * The bytes a `Range` header asks for, of a file of `size` bytes (RFC 9110 §14.1.2):
 * { from, to } for [from, to); null for all of it, when there is no header, or one this ignores (not one range of
 * bytes, or malformed); or "unsatisfiable".
 */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  const [first, last] = [position(match[1]), position(match[2])];
  if (first === null) return last === 0 || size === 0 ? "unsatisfiable" : { from: Math.max(0, size - last), to: size };
  if (last !== null && last < first) return null;
  if (first >= size) return "unsatisfiable";
  return { from: first, to: last === null ? size : Math.min(last + 1, size) };
}

/**
 * The response to a request whose `Range` header is `range` (null without one), for a file of `size` bytes of MIME type
 * `type`: 206 with the bytes asked for, 200 with all of them, or 416. `read({ from, to })` → { size, stream } reads
 * them, e.g. `readBlob` with the entry's salt. Its size must be `size`: the entry's.
 * Every response says ranges are accepted, so a media element seeks with them, and none is cached.
 */
export async function rangeResponse(range, { size, type }, read) {
  const common = { "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const wanted = parseRange(range, size);
  if (wanted === "unsatisfiable") return new Response(null, { status: 416, headers: { ...common, "Content-Range": `bytes */${size}` } });
  const { from, to } = wanted ?? { from: 0, to: size };
  const opened = await read({ from, to });
  if (opened.size !== size) {
    await opened.stream.cancel();
    throw new IntegrityError(`a file of ${opened.size} bytes where its entry says ${size}`);
  }
  const headers = { ...common, "Content-Type": type, "Content-Length": String(to - from) };
  if (wanted === null) return new Response(opened.stream, { status: 200, headers });
  return new Response(opened.stream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${from}-${to - 1}/${size}` } });
}
