// What plays next (SPEC §6.1): the library's tracks in the order it lists them, or shuffled; and what repeats. Plain
// functions of data; randomness is passed in.

/** "Previous" restarts the track instead, once it has played longer than this. */
export const RESTART_AFTER_S = 3;

/** Repeat modes, in the order the button goes through them. */
export const REPEAT_MODES = ["off", "all", "one"];

export const nextRepeat = (mode) => REPEAT_MODES[(REPEAT_MODES.indexOf(mode) + 1) % REPEAT_MODES.length];

const indexOf = (queue, name) => queue.findIndex((track) => track.name === name);

/**
 * The track after the one named `current`: at the end, the first again when repeating, else null. Null as well when
 * `current` isn't in the queue. Repeating one track is the player's business, when a track ends: a press of next
 * still moves on.
 */
export function after(queue, current, repeat = "off") {
  const index = indexOf(queue, current);
  if (index < 0) return null;
  if (index + 1 < queue.length) return queue[index + 1];
  return repeat === "off" ? null : queue[0];
}

/**
 * What "previous" plays, `position` seconds into the track named `current`: the track itself from the start, when it
 * has played longer than RESTART_AFTER_S, or is the first and nothing repeats; else the one before it, which for the
 * first is the last when repeating. Null when `current` isn't in the queue.
 */
export function previous(queue, current, position, repeat = "off") {
  const index = indexOf(queue, current);
  if (index < 0) return null;
  if (position > RESTART_AFTER_S) return queue[index];
  if (index > 0) return queue[index - 1];
  return repeat === "off" ? queue[index] : queue.at(-1);
}

/**
 * The queue as next and previous go through it: without the tracks `skipped` says no to (the disliked ones), but with
 * the one named `current`, played on purpose, so that next moves on from it.
 */
export const skipping = (queue, skipped, current) => queue.filter((track) => track.name === current || !skipped(track));

/** `names` in a random order (Fisher–Yates); `random()` is in [0, 1), like Math.random. */
export function shuffled(names, random) {
  return names.reduce((order, name, i) => {
    const at = Math.floor(random() * (i + 1));
    return [...order.slice(0, at), name, ...order.slice(at)];
  }, []);
}

/** A new shuffled order of `tracks`, starting with `current` (a name, or null) so that what plays keeps playing. */
export function shuffleOrder(tracks, current, random) {
  const rest = tracks.map((track) => track.name).filter((name) => name !== current);
  return [...(tracks.some((track) => track.name === current) ? [current] : []), ...shuffled(rest, random)];
}

/** A shuffled `order` kept up with the library: tracks gone are dropped, new ones go at the end. */
export function keptOrder(order, tracks) {
  const names = new Set(tracks.map((track) => track.name));
  const kept = order.filter((name) => names.has(name));
  const known = new Set(kept);
  return [...kept, ...tracks.map((track) => track.name).filter((name) => !known.has(name))];
}

/** The queue: the library's tracks as listed, or in the shuffled `order` (names) when there is one. */
export function queueOf(tracks, order) {
  if (order === null) return tracks;
  const byName = new Map(tracks.map((track) => [track.name, track]));
  return keptOrder(order, tracks).map((name) => byName.get(name));
}

/**
 * What the notification shows of the track and the player, on its second line, where an artist would go: whether the
 * track is liked (when that is known), shuffle and repeat; "" for none of them.
 */
export function statusLine({ shuffle, repeat, liked = null, disliked = false }) {
  const like = disliked ? "👎 Disliked" : liked === true ? "♥ Liked" : liked === false && "♡ Not liked";
  return [like, shuffle && "Shuffle", repeat === "all" && "Repeat all", repeat === "one" && "Repeat one"]
    .filter(Boolean)
    .join(" · ");
}
