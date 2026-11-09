// Measuring a track's loudness (SPEC §5.9), in the page: its length from its headers, then, if it isn't too long,
// decoded whole by the browser (Web Audio, at loudness.js's RATE) and measured. Not in a worker: OfflineAudioContext
// is the page's.

import { loudnessOf, measurable, RATE } from "./loudness.js";
import { readDuration } from "./tags.js";

/**
 * The loudness of a track's bytes (a Blob, or a picked File): { lufs, peak }, or { lufs: null } when it is too long to
 * decode here (loudness.js's MAX_SECONDS), or has no sound. Rejects when the browser can't decode it.
 */
export async function measureLoudness(blob) {
  const read = async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
  if (!measurable(await readDuration({ size: blob.size, read }), blob.size)) return { lufs: null };
  const audio = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await blob.arrayBuffer());
  return loudnessOf(Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i)), audio.sampleRate);
}
