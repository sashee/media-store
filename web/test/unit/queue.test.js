import { test } from "node:test";
import assert from "node:assert/strict";

import { after, keptOrder, nextRepeat, previous, queueOf, REPEAT_MODES, RESTART_AFTER_S, shuffled, shuffleOrder, skipping, statusLine } from "../../public/js/queue.js";

const queue = ["a", "b", "c"].map((name) => ({ name }));

test("next is the track after, and nothing at the end or for a track the queue doesn't have", () => {
  assert.equal(after(queue, "a").name, "b");
  assert.equal(after(queue, "b").name, "c");
  assert.equal(after(queue, "c"), null);
  assert.equal(after(queue, "gone"), null);
  assert.equal(after(queue, null), null);
  assert.equal(after([], "a"), null);
});

test("previous is the track before, or the same one again once it has played a while, or at the start", () => {
  assert.equal(previous(queue, "b", 0).name, "a");
  assert.equal(previous(queue, "b", RESTART_AFTER_S).name, "a");
  assert.equal(previous(queue, "b", RESTART_AFTER_S + 0.1).name, "b");
  assert.equal(previous(queue, "a", 0).name, "a");
  assert.equal(previous(queue, "gone", 0), null);
});

test("repeating all goes round: after the last comes the first, and before the first the last", () => {
  assert.equal(after(queue, "c", "all").name, "a");
  assert.equal(after(queue, "c", "one").name, "a", "next still moves on when one track repeats");
  assert.equal(previous(queue, "a", 0, "all").name, "c");
  assert.equal(previous(queue, "a", 0, "off").name, "a");
  assert.equal(previous(queue, "a", RESTART_AFTER_S + 1, "all").name, "a");
});

test("the repeat button goes off, all, one, and round again", () => {
  assert.deepEqual(REPEAT_MODES.map(nextRepeat), ["all", "one", "off"]);
});

/** A random() that returns these numbers in turn. */
const numbers = (...values) => () => values.shift() ?? 0;

test("shuffling: every track once, in the order random() says, starting with the one playing", () => {
  assert.deepEqual(shuffled(["a", "b", "c"], numbers(0, 0, 0)), ["c", "b", "a"]);
  assert.deepEqual(shuffled(["a", "b", "c"], numbers(0, 0.99, 0.99)), ["a", "b", "c"]);
  const tracks = ["a", "b", "c", "d"].map((name) => ({ name }));
  const order = shuffleOrder(tracks, "c", Math.random);
  assert.equal(order[0], "c");
  assert.deepEqual([...order].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual([...shuffleOrder(tracks, null, Math.random)].sort(), ["a", "b", "c", "d"], "nothing playing: all of them shuffled");
});

test("a shuffled order keeps up with the library: tracks gone are dropped, new ones go at the end", () => {
  const tracks = ["a", "b", "d"].map((name) => ({ name }));
  assert.deepEqual(keptOrder(["c", "b", "a"], tracks), ["b", "a", "d"]);
  assert.deepEqual(queueOf(tracks, ["d", "a", "b"]).map((t) => t.name), ["d", "a", "b"]);
  assert.equal(queueOf(tracks, null), tracks, "not shuffled: the library as listed");
});

test("the notification's line says what is on, and nothing when nothing is", () => {
  assert.equal(statusLine({ shuffle: false, repeat: "off" }), "");
  assert.equal(statusLine({ shuffle: true, repeat: "off" }), "Shuffle");
  assert.equal(statusLine({ shuffle: true, repeat: "all" }), "Shuffle · Repeat all");
  assert.equal(statusLine({ shuffle: false, repeat: "one" }), "Repeat one");
  assert.equal(statusLine({ shuffle: true, repeat: "all", liked: true }), "♥ Liked · Shuffle · Repeat all");
  assert.equal(statusLine({ shuffle: false, repeat: "off", liked: false }), "♡ Not liked");
  assert.equal(statusLine({ shuffle: false, repeat: "off", liked: null }), "", "not known yet: nothing said");
});

test("next and previous go past disliked tracks, but not past the one played on purpose", () => {
  const queue = [{ name: "a" }, { name: "b", off: true }, { name: "c" }, { name: "d", off: true }];
  const off = (track) => track.off === true;
  assert.deepEqual(skipping(queue, off, "a").map((t) => t.name), ["a", "c"]);
  assert.deepEqual(skipping(queue, off, "b").map((t) => t.name), ["a", "b", "c"], "b, started on purpose, moves on to c");
  assert.equal(after(skipping(queue, off, "b"), "b"), queue[2]);
  assert.equal(statusLine({ shuffle: false, repeat: "off", liked: false, disliked: true }), "👎 Disliked");
});
