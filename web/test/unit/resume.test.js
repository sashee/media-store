import { test } from "node:test";
import assert from "node:assert/strict";

import { findTrack, openResume, readResume, resumeKey, resumeState, sealResume, startAt, validSource } from "../../public/js/resume.js";

const track = (name, id) => ({ name, id, title: name });

test("a queue's source is a folder, everything below one, or the likes", () => {
  assert.deepEqual(validSource({ kind: "folder", path: ["artists", "X", "Y"] }), { kind: "folder", path: ["artists", "X", "Y"] });
  assert.deepEqual(validSource({ kind: "below", path: [] }), { kind: "below", path: [] });
  assert.deepEqual(validSource({ kind: "likes", path: ["ignored"] }), { kind: "likes" });
  assert.deepEqual(validSource({ kind: "likedBelow", path: ["artists", "X"] }), { kind: "likedBelow", path: ["artists", "X"] });
  for (const odd of [null, {}, { kind: "folder" }, { kind: "folder", path: [1] }, { kind: "radio" }]) assert.equal(validSource(odd), null);
});

test("the state kept is checked when it is read back", () => {
  const state = resumeState({ source: { kind: "likes" }, track: track("lists/likes/a.flac", "b1"), position: 61.5, duration: 240 });
  assert.deepEqual(readResume(state), { source: { kind: "likes" }, track: { name: "lists/likes/a.flac", id: "b1" }, position: 61.5, duration: 240 });
  assert.equal(resumeState({ source: { kind: "likes" }, track: track("a", "b"), position: NaN, duration: NaN }).position, 0);
  assert.equal(readResume({ ...state, version: 2 }), null);
  assert.equal(readResume({ ...state, track: { name: "a" } }), null);
  assert.equal(readResume({ ...state, source: { kind: "radio" } }), null);
});

test("the track is found again by its name, else by its blob, else not at all", () => {
  const tracks = [track("A/01.flac", "x"), track("A/02.flac", "y")];
  assert.equal(findTrack(tracks, { name: "A/02.flac", id: "zzz" }), tracks[1]);
  assert.equal(findTrack(tracks, { name: "A/renamed.flac", id: "x" }), tracks[0]);
  assert.equal(findTrack(tracks, { name: "B/01.flac", id: "gone" }), null);
});

test("it starts where it stopped, unless that was the very end", () => {
  assert.equal(startAt({ position: 61.5, duration: 240 }), 61.5);
  assert.equal(startAt({ position: 239.5, duration: 240 }), 0);
  assert.equal(startAt({ position: 0.2, duration: 2 }), 0.2, "a short track isn't all end");
  assert.equal(startAt({ position: 30, duration: null }), 30);
});

test("the state is sealed with a key from the master key, and opens only with it", async () => {
  const key = await resumeKey(crypto.getRandomValues(new Uint8Array(32)));
  const state = resumeState({ source: { kind: "folder", path: ["uploads", "P", "files"] }, track: track("uploads/P/files/01.flac", "b1"), position: 12, duration: 200 });
  const sealed = await sealResume(key, state);
  assert.ok(!sealed.includes("uploads"), "nothing of it in the clear");
  assert.deepEqual(await openResume(key, sealed), readResume(state));

  const other = await resumeKey(crypto.getRandomValues(new Uint8Array(32)));
  assert.equal(await openResume(other, sealed), null, "another library's key");
  const [nonce, ciphertext] = sealed.split(".");
  assert.equal(await openResume(key, `${nonce}.${ciphertext.slice(0, -2)}AA`), null, "tampered");
  assert.equal(await openResume(key, "garbage"), null);
  assert.equal(await openResume(key, null), null);
});
