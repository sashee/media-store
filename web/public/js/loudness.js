// Loudness (SPEC §5.9): every track plays at about the same loudness. Each one's integrated loudness (ITU-R BS.1770,
// as EBU R128 measures it) is measured once, from its bytes, and kept by its SHA-256 in one file, loudness.json; the
// player turns each track down to TARGET_LUFS. Like a dislike, a value holds no copy of the track, so it keeps nothing
// stored. Plain functions and a save step; decoding is measure.js's.

import { te } from "../sdk/crypto.js";
import { TreeError } from "../sdk/tree.js";
import { isAudio, typeOfEntry, unplayable } from "./library.js";

export const LOUDNESS = ["loudness.json"];
const VERSION = 1;

/** What every track is turned down to, in LUFS: ReplayGain 2's reference. A quieter one plays as it is. */
export const TARGET_LUFS = -18;

/** The sample rate tracks are decoded at to be measured: the one BS.1770 specifies its filter at. */
export const RATE = 48000;

/** The longest track decoded whole to be measured: decoded, a minute of it takes some 50 to 90 MB at once. */
export const MAX_SECONDS = 20 * 60;

/** The biggest file whose length its headers don't tell (tags.js's readDuration) that is still decoded. */
export const MAX_UNKNOWN_BYTES = 20 * 1024 * 1024;

/** Whether a track `seconds` long (null: not known) in a file of `size` bytes is decoded to be measured. */
export const measurable = (seconds, size) => (seconds === null ? size <= MAX_UNKNOWN_BYTES : seconds <= MAX_SECONDS);

// ---------------------------------------------------------------- measuring (ITU-R BS.1770-4)

/**
 * The K-weighting filter at `rate`: a high shelf, then a high pass, each a biquad { b: [b0, b1, b2], a: [a1, a2] }.
 * Worked out for any rate as libebur128 does, which gives the standard's own coefficients at 48 kHz.
 */
export function kWeighting(rate) {
  const shelf = (() => {
    const K = Math.tan((Math.PI * 1681.974450955533) / rate);
    const Q = 0.7071752369554196;
    const Vh = 10 ** (3.999843853973347 / 20);
    const Vb = Vh ** 0.4996667741545416;
    const a0 = 1 + K / Q + K * K;
    return { b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
  })();
  const highPass = (() => {
    const K = Math.tan((Math.PI * 38.13547087602444) / rate);
    const Q = 0.5003270373238773;
    const a0 = 1 + K / Q + K * K;
    return { b: [1, -2, 1], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
  })();
  return [shelf, highPass];
}

/**
 * Each channel's weight (BS.1770's G), in Web Audio's channel order: 5.1's surrounds count 1.41, its LFE nothing. A
 * mono track counts twice, as it plays from both speakers.
 */
const weightsOf = (channels) => (channels === 1 ? [2] : channels === 6 ? [1, 1, 1, 0, 1.41, 1.41] : Array(channels).fill(1));

/** One channel, K-weighted: its mean square in each whole `step` of samples, and its largest sample. */
function channelSteps(samples, rate, step) {
  const [shelf, highPass] = kWeighting(rate);
  const [b0, b1, b2] = shelf.b;
  const [a1, a2] = shelf.a;
  const [c1, c2] = highPass.a;
  const steps = new Float64Array(Math.floor(samples.length / step));
  // The filters' state, carried from sample to sample: mutated, and without arrays, as this runs over every sample of
  // a track (some 23 million in 4 minutes of stereo).
  let [x1, x2, y1, y2, z1, z2, peak] = [0, 0, 0, 0, 0, 0, 0];
  for (let start = 0; start < samples.length; start += step) {
    const end = Math.min(samples.length, start + step);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const x = samples[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      const z = y - 2 * y1 + y2 - c1 * z1 - c2 * z2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      z2 = z1;
      z1 = z;
      sum += z * z;
      if (x > peak) peak = x;
      else if (-x > peak) peak = -x;
    }
    if (end - start === step) steps[start / step] = sum / step;
  }
  return { steps, peak };
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const lufsOf = (power) => -0.691 + 10 * Math.log10(power);

/**
 * The integrated loudness of decoded audio (`channels`, sample arrays at `rate`), gated as BS.1770 says: blocks of
 * 400 ms every 100 ms, those under -70 LUFS left out, then those more than 10 LU under the rest. With its sample peak
 * (1 is full scale). → { lufs, peak }; lufs is null when no block passes the gates: silence, or under 400 ms.
 */
export function loudnessOf(channels, rate) {
  const step = Math.round(rate / 10);
  const weights = weightsOf(channels.length);
  const measured = channels.map((samples) => channelSteps(samples, rate, step));
  const count = measured[0]?.steps.length ?? 0;
  const steps = Array.from({ length: count }, (_, i) => measured.reduce((sum, { steps: own }, c) => sum + weights[c] * own[i], 0));
  const blocks = steps.slice(3).map((_, j) => (steps[j] + steps[j + 1] + steps[j + 2] + steps[j + 3]) / 4);
  const loud = blocks.filter((power) => lufsOf(power) > -70);
  // 10 LU under their loudness: a tenth of their power.
  const gated = loud.filter((power) => power > mean(loud) / 10);
  return { lufs: gated.length ? lufsOf(mean(gated)) : null, peak: Math.max(0, ...measured.map(({ peak }) => peak)) };
}

// ---------------------------------------------------------------- loudness.json

const SHA256 = /^[0-9a-f]{64}$/;

/** A value as it is kept: { lufs, peak }, rounded, or { lufs: null } for a track not measured on purpose. */
const kept = ({ lufs, peak }) => (lufs === null ? { lufs: null } : { lufs: Math.round(lufs * 100) / 100, peak: Math.round(peak * 10000) / 10000 });

const valid = (value) => value?.lufs === null || (Number.isFinite(value?.lufs) && Number.isFinite(value?.peak) && value.peak >= 0);

/**
 * The loudness in loudness.json's bytes (null for none): a Map from SHA-256 to { lufs, peak }, lufs null for a track
 * not measured on purpose (too long to decode here, or silent). Empty for a file this version doesn't read, which is
 * then left as it is until something is measured.
 */
export function readLoudness(bytes) {
  if (!bytes) return new Map();
  try {
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    if (doc?.version !== VERSION || typeof doc.tracks !== "object" || doc.tracks === null) return new Map();
    return new Map(Object.entries(doc.tracks).flatMap(([sha256, value]) => (SHA256.test(sha256) && valid(value) ? [[sha256, kept(value)]] : [])));
  } catch {
    return new Map();
  }
}

/** loudness.json's bytes for `known`: compact, as it holds a line for every track of the library. */
const encoded = (known) => te.encode(JSON.stringify({ version: VERSION, tracks: Object.fromEntries(known) }));

/** loudness.json as it is in `tx`: empty when there is none yet. */
async function current(tx) {
  try {
    return readLoudness(await tx.read(LOUDNESS));
  } catch (error) {
    if (error instanceof TreeError && error.code === "not_found") return new Map();
    throw error;
  }
}

/**
 * A save step putting `measured` ([[sha256, { lufs, peak }]], as measure.js gives them) in loudness.json, over what it
 * has for the same bytes. Nothing changes when it has them all already.
 */
export const recordLoudness = (measured) => async (tx) => {
  const known = await current(tx);
  const added = measured
    .filter(([sha256, value]) => SHA256.test(sha256) && valid(value))
    .map(([sha256, value]) => [sha256, kept(value)])
    .filter(([sha256, value]) => JSON.stringify(known.get(sha256)) !== JSON.stringify(value));
  return added.length === 0 ? tx : tx.put(LOUDNESS, tx.upload(encoded(new Map([...known, ...added]))));
};

// ---------------------------------------------------------------- playing

/** The volume that plays a track of `lufs` at `target`: at most 1, as the <audio> element can't turn one up. */
export const gainFor = (lufs, target = TARGET_LUFS) => Math.min(1, 10 ** ((target - lufs) / 20));

/** The loudness most tracks have: the median of those measured; null with none. */
export function usualLufs(known) {
  const values = [...known.values()].flatMap(({ lufs }) => (lufs === null ? [] : [lufs])).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  if (values.length === 0) return null;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/**
 * The volume the bytes with this SHA-256 play at, among `known`: by their loudness, or by the usual one when theirs
 * isn't measured, so an unmeasured track doesn't stand out; 1 when nothing is measured.
 */
export function volumeFor(known, sha256) {
  const lufs = known.get(sha256)?.lufs ?? usualLufs(known);
  return lufs === null ? 1 : gainFor(lufs);
}

// ---------------------------------------------------------------- measuring the library

/**
 * What Measure loudness measures: of `files` (library.js's walk of the root), the tracks this browser plays
 * (`canPlay`) whose bytes `known` has nothing for, each set of bytes once, from its first place. → [{ path, entry }]
 */
export function toMeasure(files, known, canPlay) {
  const tracks = files.filter(({ entry }) => isAudio(entry) && !unplayable(typeOfEntry(entry), canPlay) && SHA256.test(entry.sha256 ?? "") && !known.has(entry.sha256));
  return [...Map.groupBy(tracks, ({ entry }) => entry.sha256).values()].map(([first]) => first);
}
