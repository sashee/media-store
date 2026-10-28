// Picking up where playing stopped (SPEC §6.4): what played, from which queue, and where in it, kept on this device for
// the next time the library opens. It is the library's content (names of folders and tracks), so it is kept encrypted,
// under a key derived from the master key, which is never stored: it opens only once the library is unlocked. Plain
// functions of data, and the two that seal and open it.

import { aesGcmDecrypt, aesGcmEncrypt, b64urlDecode, b64urlEncode, hkdfAesKey, td, te } from "../sdk/crypto.js";

const VERSION = 1;
const INFO = "media-store resume v1";

/**
 * What a queue was made from, so it can be made again (main.js): the tracks of one folder, as played from it
 * ({ kind: "folder", path }); every track below a folder, as Play all plays them ({ kind: "below", path }); the liked
 * ones among those, as Play likes plays them ({ kind: "likedBelow", path }); or the likes ({ kind: "likes" }).
 */
export function validSource(source) {
  const path = Array.isArray(source?.path) && source.path.every((name) => typeof name === "string") ? source.path : null;
  if (["folder", "below", "likedBelow"].includes(source?.kind) && path) return { kind: source.kind, path };
  if (source?.kind === "likes") return { kind: "likes" };
  return null;
}

/** The state kept: the queue's source, the track (its name in the queue and its blob), and where in it, in seconds. */
export const resumeState = ({ source, track, position, duration }) => ({
  version: VERSION,
  source,
  track: { name: track.name, id: track.id },
  position: Number.isFinite(position) && position > 0 ? position : 0,
  duration: Number.isFinite(duration) ? duration : null,
});

/** A kept state, checked: null for anything else (another version, a part missing). */
export function readResume(state) {
  const source = validSource(state?.source);
  const { name, id } = state?.track ?? {};
  if (state?.version !== VERSION || !source || typeof name !== "string" || typeof id !== "string") return null;
  const position = Number.isFinite(state.position) && state.position > 0 ? state.position : 0;
  const duration = Number.isFinite(state.duration) ? state.duration : null;
  return { source, track: { name, id }, position, duration };
}

/** The kept track in a queue made again: by its name, else by its blob (renamed meanwhile); null when it is gone. */
export const findTrack = (tracks, kept) => tracks.find((track) => track.name === kept.name) ?? tracks.find((track) => track.id === kept.id) ?? null;

/** Where to start again: where it stopped, unless that was in its last second, at its end, when it starts over. */
export const startAt = ({ position, duration }) => (duration !== null && position >= duration - 1 ? 0 : position);

/** The key the state is sealed with, from the library's master key. */
export const resumeKey = (masterKey) => hkdfAesKey(masterKey, INFO);

/** `state`, encrypted with `key`, as text for localStorage: "<nonce>.<ciphertext>", both base64url. */
export async function sealResume(key, state) {
  const { nonce, ciphertext } = await aesGcmEncrypt(key, te.encode(JSON.stringify(state)), te.encode(INFO));
  return `${b64urlEncode(nonce)}.${b64urlEncode(ciphertext)}`;
}

/** A state sealed with `key` (readResume'd); null for anything that doesn't open: another library's, tampered, garbage. */
export async function openResume(key, text) {
  try {
    const [nonce, ciphertext] = String(text).split(".");
    return readResume(JSON.parse(td.decode(await aesGcmDecrypt(key, b64urlDecode(nonce), b64urlDecode(ciphertext), te.encode(INFO)))));
  } catch {
    return null;
  }
}
