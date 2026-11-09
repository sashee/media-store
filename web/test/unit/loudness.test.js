import { test } from "node:test";
import assert from "node:assert/strict";

import { gainFor, kWeighting, LOUDNESS, loudnessOf, MAX_SECONDS, MAX_UNKNOWN_BYTES, measurable, readLoudness, recordLoudness, toMeasure, usualLufs, volumeFor } from "../../public/js/loudness.js";
import { storedTree } from "./stored-tree.js";

const SHA = (n) => n.toString(16).padStart(64, "0");
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ""} ${actual} is not ${expected} ± ${tolerance}`);

/** A 1 kHz sine at `dbfs` (its peak, as EBU Tech 3341 gives its levels), `seconds` long. */
const sine = (dbfs, seconds, rate = 48000) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 10 ** (dbfs / 20) * Math.sin((2 * Math.PI * 1000 * i) / rate));
const joined = (...parts) => Float32Array.from(parts.flatMap((part) => [...part]));
const stereo = (samples) => [samples, samples];

test("K-weighting: at 48 kHz, BS.1770's own coefficients", () => {
  const [shelf, highPass] = kWeighting(48000);
  const close = (actual, expected) => actual.forEach((value, i) => near(value, expected[i], 1e-8));
  close(shelf.b, [1.53512485958697, -2.69169618940638, 1.19839281085285]);
  close(shelf.a, [-1.69065929318241, 0.73248077421585]);
  close(highPass.b, [1, -2, 1]);
  close(highPass.a, [-1.99004745483398, 0.99007225036621]);
});

test("EBU Tech 3341's cases 1 to 4: steady tones, and the absolute and relative gates", () => {
  near(loudnessOf(stereo(sine(-23, 20)), 48000).lufs, -23, 0.1, "case 1");
  near(loudnessOf(stereo(sine(-33, 20)), 48000).lufs, -33, 0.1, "case 2");
  near(loudnessOf(stereo(joined(sine(-36, 10), sine(-23, 60), sine(-36, 10))), 48000).lufs, -23, 0.1, "case 3: the quiet parts are gated out");
  const four = joined(sine(-72, 10), sine(-36, 10), sine(-23, 60), sine(-36, 10), sine(-72, 10));
  near(loudnessOf(stereo(four), 48000).lufs, -23, 0.1, "case 4: under -70 LUFS doesn't count at all");
  near(loudnessOf(stereo(sine(-23, 20, 44100)), 44100).lufs, -23, 0.1, "at 44.1 kHz too");
});

test("a mono track counts twice, as it plays from both speakers; the peak is the largest sample", () => {
  const measured = loudnessOf([sine(-23, 5)], 48000);
  near(measured.lufs, loudnessOf(stereo(sine(-23, 5)), 48000).lufs, 1e-9, "as loud as the same in both channels");
  near(measured.lufs, -23, 0.1);
  near(measured.peak, 10 ** (-23 / 20), 1e-4);
});

test("silence, or under 400 ms, has no loudness", () => {
  assert.equal(loudnessOf(stereo(new Float32Array(48000 * 5)), 48000).lufs, null);
  assert.equal(loudnessOf(stereo(sine(-80, 5)), 48000).lufs, null, "all under the absolute gate");
  assert.equal(loudnessOf(stereo(sine(-10, 0.35)), 48000).lufs, null, "no whole block");
  assert.equal(loudnessOf([], 48000).lufs, null);
});

test("what is decoded to be measured: up to MAX_SECONDS, or by its size when its length isn't known", () => {
  assert.ok(measurable(MAX_SECONDS, 10 ** 9));
  assert.ok(!measurable(MAX_SECONDS + 1, 1000));
  assert.ok(measurable(null, MAX_UNKNOWN_BYTES));
  assert.ok(!measurable(null, MAX_UNKNOWN_BYTES + 1));
});

test("loudness.json is read with care: anything odd is left out", () => {
  assert.deepEqual(readLoudness(null), new Map());
  assert.deepEqual(readLoudness(new TextEncoder().encode("not json")), new Map());
  assert.deepEqual(readLoudness(encode({ version: 2, tracks: { [SHA(1)]: { lufs: -9, peak: 1 } } })), new Map(), "a newer version");
  const read = readLoudness(
    encode({
      version: 1,
      tracks: { [SHA(1)]: { lufs: -9.123, peak: 0.98765, extra: 1 }, [SHA(2)]: { lufs: null }, [SHA(3)]: { lufs: "loud" }, [SHA(4)]: { lufs: -9 }, short: { lufs: -9, peak: 1 } },
    }),
  );
  assert.deepEqual([...read], [[SHA(1), { lufs: -9.12, peak: 0.9877 }], [SHA(2), { lufs: null }]]);
});

test("recording adds to loudness.json, over the same bytes' old values; the same again changes nothing", async () => {
  const tx = storedTree({ "uploads/P/files/one.mp3": { sha256: SHA(1) } });
  const read = async (t) => readLoudness(await t.read(LOUDNESS));
  const one = await recordLoudness([[SHA(1), { lufs: -10.004, peak: 0.5 }]])(tx);
  const two = await recordLoudness([[SHA(2), { lufs: null, peak: 0 }], [SHA(1), { lufs: -11, peak: 0.6 }], ["short", { lufs: -1, peak: 1 }]])(one);
  assert.deepEqual([...(await read(two))], [[SHA(1), { lufs: -11, peak: 0.6 }], [SHA(2), { lufs: null }]]);
  assert.equal(await recordLoudness([[SHA(2), { lufs: null }]])(two), two, "nothing new");
  assert.equal(await recordLoudness([])(tx), tx);
});

test("the volume: turned down to the target, never up; an unmeasured track at the usual loudness", () => {
  near(gainFor(-18), 1, 1e-12);
  near(gainFor(-12), 0.5012, 1e-4, "6 dB louder: half the amplitude");
  assert.equal(gainFor(-30), 1, "a quiet one plays as it is");
  const known = new Map([
    [SHA(1), { lufs: -6, peak: 1 }],
    [SHA(2), { lufs: -12, peak: 1 }],
    [SHA(3), { lufs: null }],
    [SHA(4), { lufs: -14, peak: 1 }],
  ]);
  assert.equal(usualLufs(known), -12, "the median, without the unmeasured");
  assert.equal(usualLufs(new Map([...known, [SHA(5), { lufs: -16, peak: 1 }]])), -13, "an even count: the middle two");
  near(volumeFor(known, SHA(1)), gainFor(-6), 1e-12);
  near(volumeFor(known, SHA(3)), gainFor(-12), 1e-12, "not measured on purpose: the usual");
  near(volumeFor(known, SHA(9)), gainFor(-12), 1e-12, "not measured yet: the usual");
  near(volumeFor(known, undefined), gainFor(-12), 1e-12);
  assert.equal(volumeFor(new Map(), SHA(1)), 1, "nothing measured at all");
  assert.equal(usualLufs(new Map()), null);
});

test("what Measure loudness measures: tracks this browser plays, each set of bytes once, none known already", () => {
  const file = (path, sha256, type = "audio/mpeg") => ({ path: path.split("/"), entry: { kind: "file", name: path.split("/").at(-1), sha256, app: { type } } });
  const files = [
    { path: ["artists"], entry: { kind: "dir", name: "artists" } },
    file("artists/A/B/01 One.mp3", SHA(1)),
    file("artists/A/B/cover.jpg", SHA(2), "image/jpeg"),
    file("lists/likes/A - One.mp3", SHA(1)),
    file("uploads/P/files/one.mp3", SHA(1)),
    file("uploads/P/files/two.mp3", SHA(3)),
    file("uploads/P/files/known.mp3", SHA(4)),
    file("uploads/P/files/odd.xyz", SHA(5), "audio/x-odd"),
    file("uploads/P/files/list.m3u", SHA(6), "audio/x-mpegurl"),
    file("uploads/P/files/nohash.mp3", undefined),
  ];
  const canPlay = (type) => (type === "audio/mpeg" ? "probably" : "");
  const picked = toMeasure(files, new Map([[SHA(4), { lufs: null }]]), canPlay);
  assert.deepEqual(
    picked.map(({ path }) => path.join("/")),
    ["artists/A/B/01 One.mp3", "uploads/P/files/two.mp3"],
  );
});
