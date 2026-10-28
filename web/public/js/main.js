// Startup and the screen state machine. The only long-lived state is the unlocked session; locking reloads the page
// so the keys and plaintext leave memory (SPEC §7.3). The account flows are pw-mgr's.

import * as api from "../sdk/api.js";
import { flows } from "./flows.js";
import { UserFacingError } from "../sdk/passkeys.js";
import { RollbackError, rollbackCheck } from "../sdk/save.js";
import { WrongKeyError } from "../sdk/keys.js";
import { isDue } from "../sdk/maintenance.js";
import { formatRecoveryKey, generateRecoveryKey } from "../sdk/recovery-key.js";
import { parseSetupFragment } from "../sdk/setup-link.js";
import { TreeError } from "../sdk/tree.js";
import { freeName, isAudio, orEmpty, parsePlayUrl, playUrl, playUrlBlob, trackOf, typeOfEntry, unplayable, walk } from "./library.js";
import { allPackages, defaultPackageName, deletePackage, FILES, PACKAGE_DOC, packageDoc, packageFiles, readPackageDoc, savePackage, setSorting, UPLOADS } from "./packages.js";
import { ARTISTS, sortArtists } from "./artists.js";
import { isLiked, LIKES, like, newestFirst, notInPackages, onlyLiked, repointLikes, unlike } from "./likes.js";
import { duplicates } from "./duplicates.js";
import { DISLIKES, dislike, isDisliked, readDislikes, undislike } from "./dislikes.js";
import { findTrack, openResume, resumeKey, resumeState, sealResume, startAt } from "./resume.js";
import { albumGroups, entryTags, packageTargets, packageTracks, regroup } from "./sorting.js";
import { filesInFolder, picked, planUpload, stored } from "./upload-plan.js";
import { aheadBytes, forgetReads, nearEnd, NEXT_START_BYTES, playingNow, startPlayback } from "./player.js";
import { offer, readWhole } from "./saving.js";
import { rangeResponse } from "./ranges.js";
import { connectMediaSession, showTrack } from "./media-session.js";
import { after, nextRepeat, previous, queueOf, REPEAT_MODES, shuffleOrder, skipping, statusLine } from "./queue.js";
import { formatRate, formatUsage, metering, MINUTE_MS, plus, rate, recent, total } from "./traffic.js";
import * as requestCounter from "./requests.js";
import { h, replaceChildren } from "./ui/dom.js";
import { connectPlayerBar } from "./ui/player-bar.js";
import * as libraryScreens from "./ui/library-screens.js";
import * as screens from "./ui/screens.js";

const INACTIVITY_LOCK_MS = 15 * 60 * 1000;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const warnings = document.getElementById("warnings");
const lockButton = document.getElementById("lock");
const settingsButton = document.getElementById("settings");
const player = document.getElementById("player");
const audio = document.getElementById("audio");
const nowPlaying = document.getElementById("now-playing");

/** The unlocked session (flows.js), plus `rollback` when the library looked older than expected. */
let session = null;

/** The upload in progress, if any. Leaving its screen stops it (SPEC §5.1): showing any other screen does. */
let uploading = null;

const show = (screen) => {
  uploading?.abort(new DOMException("The upload was cancelled.", "AbortError"));
  uploading = null;
  replaceChildren(app, screen);
  window.scrollTo(0, 0);
};

function showError(error) {
  console.error(error);
  const text =
    error instanceof UserFacingError || error instanceof WrongKeyError || error instanceof api.IntegrityError || error instanceof api.ApiError || error instanceof TreeError
      ? error.message
      : `Something went wrong: ${error?.message ?? error}`;
  replaceChildren(banner, h("p", { class: "banner error", role: "alert" }, text, " ", h("button", { type: "button", onclick: clearBanner }, "Dismiss")));
}

function showNotice(text) {
  replaceChildren(banner, h("p", { class: "banner notice", role: "status", id: "notice" }, text, " ", h("button", { type: "button", onclick: clearBanner }, "Dismiss")));
}

const clearBanner = () => replaceChildren(banner);

/** Wraps an action so the banner is cleared first and errors land in it. */
const action = (fn) => async (...args) => {
  clearBanner();
  await fn(...args);
};

// ---------------------------------------------------------------- per-device memory (localStorage)

const remembered = {
  get: (key) => {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
};
// Filed under an ID derived from the master key, not the user ID the server reports (flows.js).
const revisionKey = (s) => `media-store/${s.stateId}/highest-revision`;
const cleanupKey = (s) => `media-store/${s.stateId}/last-cleanup`;

// ---------------------------------------------------------------- playback (SPEC §6)


/**
 * A play URL, answered here with the track decrypted in ranges (SPEC §6): the worker passes on the <audio> element's
 * requests, and the page has the key. Nothing plays while locked.
 */
async function respond(url, range) {
  const track = parsePlayUrl(url);
  if (!track) return new Response("Not a track", { status: 404 });
  if (!session) return new Response("Locked", { status: 403 });
  const current = session;
  return rangeResponse(range, track, (wanted) => flows.read(current, track, wanted));
}

const playback = startPlayback({
  respond,
  // Only for the track playing: one left behind fails as its read is stopped (SPEC §6.3), which is no news.
  onError: (text, url) => {
    if (playUrlBlob(url) === playingTrack()?.id) showError(new UserFacingError(`Can't play this track: ${text}`));
  },
  onTraffic: (bytes) => record({ at: Date.now(), down: bytes, up: 0 }),
});
// Reported when a track is played.
playback.catch(() => {});

/** The tracks of the folder or package playing was started from: what the queue is made of (SPEC §6.1). */
let listed = [];

/** Plays from these tracks from now on: a new queue, and a new shuffled order. */
/** What the queue was made from (resume.js's sources), so it can be made again when the library opens next. */
let queueSource = null;

/** Plays from these tracks from now on, made from `source`: a new queue, and a new shuffled order. */
function setQueue(tracks, source) {
  listed = tracks;
  queueSource = source;
  order = null;
}

/** Whether this browser plays a type. */
const canPlay = (type) => audio.canPlayType(type);

/** Shuffle and repeat, remembered on this device: they aren't secret. */
const MODE_KEY = "media-store/player";
const savedMode = remembered.get(MODE_KEY);
let mode = {
  shuffle: savedMode?.shuffle === true,
  repeat: REPEAT_MODES.includes(savedMode?.repeat) ? savedMode.repeat : "off",
};
/** The shuffled order, as names, while shuffling; made when shuffle is turned on, or first needed. */
let order = null;

/** What next and previous go through: the library as listed, or shuffled. */
function queue() {
  if (mode.shuffle && order === null) order = shuffleOrder(listed, playing(), Math.random);
  // Without the disliked tracks (SPEC §5.8), unless one of them is the one playing, started on purpose.
  return skipping(queueOf(listed, mode.shuffle ? order : null), skipped, playing());
}

/** The dislikes (dislikes.js), as last read: after the unlock, and after each change. */
let dislikes = [];
const skipped = (track) => isDisliked(dislikes, track.sha256);

/** dislikes.json as the library has it now: [] when there is none. */
async function readDislikedNow() {
  const entry = (await entriesAt(session, DISLIKES.slice(0, -1))).find((e) => e.name === DISLIKES.at(-1) && e.kind === "file");
  return entry ? readDislikes(await readAll(flows.read(session, entry))) : [];
}
const refreshDislikes = async () => {
  dislikes = await readDislikedNow();
};

/** Where Play all and Play likes start: the first track not disliked. */
const firstPlayable = (tracks) => {
  const first = tracks.find((track) => !skipped(track));
  if (!first) throw new UserFacingError("Everything here is disliked: started on purpose, a track still plays.");
  return first;
};

/** The track in the player: its name in `tracks`, or null. */
const playing = () => player.dataset.track ?? null;

/** Whether the track in the player is liked; null while that isn't known yet (showLiked). */
let playingLiked = null;

const showPlaying = (track) => showTrack(track, statusLine({ ...mode, liked: playingLiked, disliked: skipped(track) }));

/** The track in the player, as the queue has it; null when none. */
const playingTrack = () => listed.find((t) => t.name === playing()) ?? null;

/**
 * Puts `track` in the player, at `at` seconds; with `fetch` false, only its start is fetched, for its length and the
 * time to show, until it plays.
 */
function load(track, { at = 0, fetch = true } = {}) {
  aheadFetched = false;
  playingLiked = null;
  audio.preload = fetch ? "auto" : "metadata";
  audio.src = playUrl(track);
  // Once its length is known: set before, the browser's own load resets it.
  if (at > 0) {
    const seek = () => player.dataset.track === track.name && (audio.currentTime = at);
    audio.addEventListener("loadedmetadata", seek, { once: true });
  }
  player.dataset.track = track.name;
  player.hidden = false;
  nowPlaying.textContent = track.title;
  showPlaying(track);
  markPlaying();
  showLiked().catch(() => {});
}

/** What a track playing starts: the worker told, so it reads only this one ahead, and the next one's start fetched. */
function startedPlaying(track) {
  playingNow(track.id);
  prefetch(after(queue(), track.name, mode.repeat), NEXT_START_BYTES);
}

async function play(track) {
  await playback;
  // Before the new track's reads, and the next one's prefetch, so only what is left behind stops.
  const another = track.id !== playingTrack()?.id;
  load(track);
  restored = false;
  if (another) startedPlaying(track);
  else prefetch(after(queue(), track.name, mode.repeat), NEXT_START_BYTES);
  rememberPlaying();
  try {
    await audio.play();
  } catch (error) {
    // Another track was picked meanwhile; or the worker couldn't play it, which it says itself.
    if (error.name !== "AbortError" && error.name !== "NotSupportedError") throw error;
  }
}

/**
 * The first `bytes` of `track`, read ahead so the worker's cache has them when it plays. Only the encrypted bytes are
 * fetched, and dropped here: the worker keeps them. Best effort: without it, the track is fetched when it plays.
 */
async function prefetch(track, bytes) {
  if (!track || !session || track.name === playing()) return;
  try {
    const { body } = await api.getBlobStream(track.id, { range: { from: 0, to: bytes } });
    await body.pipeTo(new WritableStream());
  } catch {
    // played later, fetched then
  }
}

/** Whether the playing track's next one has had its share fetched, once the track neared its end (SPEC §6.3). */
let aheadFetched = false;
audio.addEventListener("timeupdate", () => {
  if (aheadFetched || !playing() || !nearEnd(audio.currentTime, audio.duration)) return;
  aheadFetched = true;
  const next = after(queue(), playing(), mode.repeat);
  if (next && next.id !== playingTrack()?.id) prefetch(next, aheadBytes(next.size));
});

/** The next track; at the end of the queue, the first when repeating, else nothing. */
async function playNext() {
  const track = after(queue(), playing(), mode.repeat);
  if (track?.name === playing()) audio.currentTime = 0;
  else if (track) await play(track);
}

/** The track before, or this one again from the start (queue.js). */
async function playPrevious() {
  const track = previous(queue(), playing(), audio.currentTime, mode.repeat);
  if (track?.name === playing()) audio.currentTime = 0;
  else if (track) await play(track);
}

/** A track that ends: again when repeating it, else the next. */
async function ended() {
  if (mode.repeat !== "one") return playNext();
  audio.currentTime = 0;
  await audio.play();
}

function stop() {
  playingNow(null);
  forgetPlaying();
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  delete player.dataset.track;
  player.hidden = true;
  showTrack(null);
  markPlaying();
}

const markPlaying = () => document.querySelectorAll("li[data-track]").forEach((row) => row.classList.toggle("playing", row.dataset.track === playing()));

// ---------------------------------------------------------------- likes (SPEC §5.6)

const likeButton = document.getElementById("like");

/** The entries of lists/likes/. */
const likedEntries = async () => (await entriesAt(session, LIKES)).filter((entry) => entry.kind === "file");

/** The like button, for the track in the player: ♥ when its bytes are liked. */
async function showLiked() {
  const track = playingTrack();
  const liked = Boolean(track && session && isLiked(await likedEntries(), track.sha256));
  if (playingTrack() !== track) return;
  likeButton.setAttribute("aria-pressed", String(liked));
  likeButton.setAttribute("aria-label", liked ? "Unlike" : "Like");
  likeButton.textContent = liked ? "♥" : "♡";
  const isOff = Boolean(track && skipped(track));
  dislikeButton.setAttribute("aria-pressed", String(isOff));
  dislikeButton.setAttribute("aria-label", isOff ? "Undo the dislike" : "Dislike");
  // And in the notification, so a like needn't be looked up in the app (SPEC §6.2).
  playingLiked = liked;
  if (track) showPlaying(track);
}

async function toggleLike() {
  const track = playingTrack();
  if (!track) return;
  // A like takes back a dislike of the same bytes: a track is one or the other (SPEC §5.8).
  await save(isLiked(await likedEntries(), track.sha256) ? [unlike(track.sha256)] : [like(track, Date.now()), undislike(track.sha256)]);
  await refreshDislikes();
  await showLiked();
  if (document.getElementById("likes-screen")) await showLikes();
  if (document.getElementById("dislikes-screen")) await showDislikes();
}
likeButton.addEventListener("click", () => toggleLike().catch(showError));

const dislikeButton = document.getElementById("dislike");

/**
 * Dislikes the track playing, taking back its like, and goes on to the next one (or stops, with none); or takes back
 * its dislike (SPEC §5.8).
 */
async function toggleDislike() {
  const track = playingTrack();
  if (!track) return;
  const was = skipped(track);
  const tags = entryTags(track);
  await save(was ? [undislike(track.sha256)] : [dislike({ ...track, artist: tags.artist || tags.albumArtist }, Date.now()), unlike(track.sha256)]);
  await refreshDislikes();
  await showLiked();
  if (document.getElementById("likes-screen")) await showLikes();
  if (document.getElementById("dislikes-screen")) await showDislikes();
  if (was) return;
  const next = after(queue(), track.name, mode.repeat);
  if (next && next.name !== track.name) await play(next);
  else stop();
}
dislikeButton.addEventListener("click", () => toggleDislike().catch(showError));

const shuffleButton = document.getElementById("shuffle");
const repeatButton = document.getElementById("repeat");

/** Sets shuffle and repeat: the buttons, what is remembered, and the notification's line. */
function setMode(next) {
  mode = next;
  remembered.set(MODE_KEY, mode);
  shuffleButton.setAttribute("aria-pressed", String(mode.shuffle));
  repeatButton.setAttribute("aria-pressed", String(mode.repeat !== "off"));
  repeatButton.dataset.mode = mode.repeat;
  repeatButton.setAttribute("aria-label", `Repeat: ${mode.repeat}`);
  repeatButton.textContent = mode.repeat === "one" ? "🔂" : "🔁";
  const track = playingTrack();
  if (track) showPlaying(track);
}

shuffleButton.addEventListener("click", () => {
  // A new order each time it is turned on, starting with what plays.
  order = null;
  setMode({ ...mode, shuffle: !mode.shuffle });
});
repeatButton.addEventListener("click", () => setMode({ ...mode, repeat: nextRepeat(mode.repeat) }));
setMode(mode);

const playerAction = (fn) => () => fn().catch(showError);
document.getElementById("previous").addEventListener("click", playerAction(playPrevious));
document.getElementById("next").addEventListener("click", playerAction(playNext));
audio.addEventListener("ended", playerAction(ended));

/**
 * A track this browser can't decode is skipped, as a music app would, rather than leaving the player stuck on it.
 * Network errors aren't: the track may play once the connection is back. When every track of the queue has failed
 * in a row, playing stops instead of going round.
 */
let failedInARow = 0;
audio.addEventListener("playing", () => (failedInARow = 0));
audio.addEventListener("error", () => {
  const code = audio.error?.code;
  const track = playingTrack();
  if (!track || (code !== MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED && code !== MediaError.MEDIA_ERR_DECODE)) return;
  failedInARow += 1;
  const next = failedInARow < queue().length ? after(queue(), track.name, mode.repeat) : null;
  showError(new UserFacingError(`"${track.title}" can't be played in this browser${next ? ", so it was skipped" : ""}.`));
  if (next) play(next).catch(showError);
  else failedInARow = 0;
});
connectPlayerBar(audio, {
  seek: document.getElementById("seek"),
  elapsed: document.getElementById("elapsed"),
  duration: document.getElementById("duration"),
  playPause: document.getElementById("play-pause"),
  onError: showError,
});
connectMediaSession(audio, { onPrevious: playerAction(playPrevious), onNext: playerAction(playNext), onStop: stop, onError: showError });

// ---------------------------------------------------------------- the traffic and request counters (SPEC §7.1)

/** What went to and came from the server in the last minute, as { at, down, up }: the page's and the worker's. */
let traffic = [];
const trafficView = document.getElementById("traffic");
const usageView = document.getElementById("usage");

/** What went and came since the app started: kept across the reloads that lock, for as long as the app runs. */
const USAGE_KEY = "media-store/usage";
let started = (() => {
  try {
    const kept = JSON.parse(sessionStorage.getItem(USAGE_KEY));
    return Number.isSafeInteger(kept?.down) && Number.isSafeInteger(kept?.up) ? kept : { down: 0, up: 0 };
  } catch {
    return { down: 0, up: 0 };
  }
})();

function record(sample) {
  traffic.push(sample);
  started = plus(started, [sample]);
}

/** The server's requests of the work in progress (requests.js). */
let requests = requestCounter.NONE;
const requestsView = document.getElementById("requests");
const showRequests = () => (requestsView.textContent = requestCounter.describe(requests, Date.now()) ?? "");

// Every request the page makes goes through `fetch`, the SDK's too: counted there, and its bytes metered.
globalThis.fetch = requestCounter.counting(metering(globalThis.fetch.bind(globalThis), { base: location.href, now: Date.now, onData: record }), {
  base: location.href,
  now: Date.now,
  onRequest: ({ id, at }) => ((requests = requestCounter.sent(requests, id, at)), showRequests()),
  onEnd: ({ id, at, outcome }) => ((requests = requestCounter.ended(requests, id, at, outcome)), showRequests()),
});

setInterval(() => {
  const now = Date.now();
  traffic = recent(traffic, now, MINUTE_MS);
  trafficView.hidden = session === null;
  trafficView.textContent = formatRate(rate(traffic, now));
  usageView.textContent = formatUsage({ minute: total(traffic), started });
  sessionStorage.setItem(USAGE_KEY, JSON.stringify(started));
  // The longest wait goes up, and the line goes, with time alone.
  showRequests();
}, 1000);

// ---------------------------------------------------------------- picking up where playing stopped (SPEC §6.4)

const resumeStorageKey = (s) => `media-store/${s.stateId}/resume`;

/** The key the state is sealed with, derived once per master key. */
const resumeKeys = new WeakMap();
const resumeKeyOf = (s) => {
  if (!resumeKeys.has(s.masterKey)) resumeKeys.set(s.masterKey, resumeKey(s.masterKey));
  return resumeKeys.get(s.masterKey);
};

/** Keeps what plays, from which queue, and where, sealed, for the next time the library opens. Best effort. */
async function rememberPlaying() {
  const s = session;
  const track = playingTrack();
  if (!s || !track || !queueSource) return;
  try {
    const state = resumeState({ source: queueSource, track, position: audio.currentTime, duration: audio.duration });
    remembered.set(resumeStorageKey(s), await sealResume(await resumeKeyOf(s), state));
  } catch {
    // kept as it was before
  }
}

/** Nothing to pick up next time: playing was stopped. */
const forgetPlaying = () => session && remembered.set(resumeStorageKey(session), null);

/** The tracks of a queue made again from `source`, from the library as it is now. */
async function queueFrom(source) {
  const playable = (tracks) => tracks.filter((track) => !unplayable(track.type, canPlay));
  if (source.kind === "below") return tracksBelow(session, source.path);
  if (source.kind === "likedBelow") return onlyLiked(await tracksBelow(session, source.path), await likedEntries());
  const dir = source.kind === "likes" ? LIKES : source.path;
  const entries = source.kind === "likes" ? newestFirst(await likedEntries()) : await entriesAt(session, dir);
  return playable(entries.filter((e) => isAudio(e)).map((e) => trackOf(e, dir)));
}

/** Whether the player holds a track put back by `restorePlaying`, which hasn't started yet. */
let restored = false;

/**
 * After unlock: the track that played, in its queue, at where it stopped, paused. Nothing is fetched until it plays;
 * when its queue or the track is gone, nothing is put back.
 */
async function restorePlaying() {
  const text = remembered.get(resumeStorageKey(session));
  if (typeof text !== "string" || playing()) return;
  const kept = await openResume(await resumeKeyOf(session), text);
  if (!kept) return;
  await playback;
  const tracks = await queueFrom(kept.source).catch(() => []);
  const track = findTrack(tracks, kept.track);
  if (!track || playing()) return;
  setQueue(tracks, kept.source);
  load(track, { at: startAt(kept), fetch: false });
  restored = true;
}

// A track put back starts as any other does once it plays, from the player's own button or the system's.
audio.addEventListener("play", () => {
  if (!restored) return;
  restored = false;
  const track = playingTrack();
  if (track) startedPlaying(track);
});

// Where in the track: on a pause, every so often while it plays, and when the page goes out of sight (the app to the
// background, or closed), which may be the last chance.
audio.addEventListener("pause", () => rememberPlaying());
setInterval(() => !audio.paused && rememberPlaying(), 15 * 1000);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && rememberPlaying());

// ---------------------------------------------------------------- locking

async function lock() {
  // Where playing was, while the key to seal it is still there.
  await rememberPlaying();
  session = null;
  forgetReads();
  await api.logout().catch(() => {});
  location.reload();
}

/** Shows the Lock button: from the moment a secret (the master key, a PRF output) is in memory. */
const holdingSecrets = () => {
  lockButton.hidden = false;
};

/** Locks after a while without input, but not while a track plays. */
function watchInactivity() {
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    // Not while a track plays, nor while an upload runs: locking would stop it.
    timer = setTimeout(() => (audio.paused && uploading === null ? lock() : arm()), INACTIVITY_LOCK_MS);
  };
  arm();
  for (const event of ["pointerdown", "keydown"]) document.addEventListener(event, arm, { passive: true });
  audio.addEventListener("pause", arm);
}

/**
 * Keeps the screen on (Screen Wake Lock) until `release()`, so a long upload goes on untouched: a phone whose screen
 * goes off sends the page, and the Android app with it, to the background, which stops it. The browser drops the lock
 * whenever the page is hidden; it is taken again when the page shows. `kept` resolves to whether the browser took it:
 * one may have the API and still refuse.
 */
function keepScreenOn() {
  if (!navigator.wakeLock) return { kept: Promise.resolve(false), release: () => {} };
  let sentinel = null;
  let done = false;
  const take = () => {
    if (done || document.visibilityState !== "visible") return Promise.resolve(false);
    return navigator.wakeLock.request("screen").then(
      (taken) => (done ? taken.release() : (sentinel = taken), true),
      () => false,
    );
  };
  document.addEventListener("visibilitychange", take);
  const kept = take();
  return {
    kept,
    release: () => {
      done = true;
      document.removeEventListener("visibilitychange", take);
      sentinel?.release().catch(() => {});
    },
  };
}

const defaultPasskeyName = () => `Passkey on ${location.hostname}`;

// ---------------------------------------------------------------- unlock

async function showUnlock() {
  const me = await api.me();
  show(
    screens.unlock({
      hasSession: me !== null,
      onPasskey: action(async () => handleUnlock(await flows.unlockWithPasskey())),
      onRecovery: action(async () => recover(await flows.loadKeys(), null)),
      onSetup: action(setup),
      onError: showError,
    }),
  );
}

const showNoLibrary = () => show(screens.message({ title: "No library yet", text: "This account has no library yet. Open a setup link to create one." }));

/** A library whose keys are missing on the server (e2ee-store SDK SPEC §6.2). Creating a new one would get new keys,
 * and the existing library could never be opened again. */
const showKeysMissing = () =>
  show(
    screens.message({
      title: "The library's keys are missing",
      text: "This account has a library, but its keys are missing on the server. Don't create a new library: restore the server's data from a backup first.",
    }),
  );

async function handleUnlock(result) {
  if (result.kind === "unlocked") return openLibrary(result.session);
  if (result.kind === "no-vault") return showNoLibrary();
  if (result.kind === "keys-missing") return showKeysMissing();
  // A passkey without a slot: the recovery key unlocks, then this passkey gets its slot.
  holdingSecrets();
  return recover(result.keys, { credentialId: result.credentialId, prfOutput: result.prfOutput });
}

/** Unlocks with the recovery key; `passkey` (if known) gets a slot afterwards, otherwise a new one is offered. */
function recover(keys, passkey) {
  if (!keys) return showNoLibrary();
  show(
    screens.enterRecoveryKey({
      intro: passkey ? "This passkey isn't set up for the library yet. Enter your recovery key to set it up." : "Enter your recovery key to open your library on this device.",
      onSubmit: action(async (recoveryKey) => {
        const unlocked = await flows.unlockWithRecoveryKey(keys, recoveryKey);
        holdingSecrets();
        if (passkey) return openLibrary(await flows.addPasskeySlot(unlocked, passkey.credentialId, passkey.prfOutput));
        offerPasskey(unlocked);
      }),
      onError: showError,
    }),
  );
}

/** After a recovery-key unlock: set up a passkey on this device, or skip. */
function offerPasskey(unlocked) {
  show(
    screens.createPasskey({
      title: "Create a passkey on this device",
      intro: "With a passkey you can unlock here without the recovery key.",
      defaultName: defaultPasskeyName(),
      onCreate: action(async (name) => {
        const registered = await flows.registerPasskey(name);
        await withPrf(registered, async (prfOutput) => openLibrary(await flows.addPasskeySlot(unlocked, registered.credentialId, prfOutput)));
      }),
      onSkip: () => openLibrary(unlocked),
      onError: showError,
    }),
  );
}

/** Calls `next` with the new passkey's PRF output, asking for one more prompt if registration didn't give it. */
async function withPrf(registered, next) {
  if (registered.prfOutput) return next(registered.prfOutput);
  show(screens.confirmPasskey({ onConfirm: action(async () => next(await flows.prfFromPasskey(registered.credentialId))), onError: showError }));
}

// ---------------------------------------------------------------- setup links

async function setup(token) {
  show(screens.loading("Checking the setup link"));
  try {
    await api.exchangeSetupToken(token);
  } catch (error) {
    if (error.status === 401) {
      return show(screens.message({ title: "Setup link not valid", text: "This setup link has expired or was already used. Ask for a new one." }));
    }
    throw error;
  }
  const keys = await flows.loadKeys();
  if (keys) return recover(keys, null);
  if (await api.getRef("vault")) return showKeysMissing();
  show(
    screens.createPasskey({
      title: "Create your library",
      intro: "First, create a passkey on this device. It unlocks your library.",
      defaultName: defaultPasskeyName(),
      onCreate: action(async (name) => {
        const registered = await flows.registerPasskey(name);
        await withPrf(registered, (prfOutput) => showNewRecoveryKey({ ...registered, prfOutput }));
      }),
      onError: showError,
    }),
  );
}

function showNewRecoveryKey(passkey) {
  const secrets = flows.newSecrets();
  holdingSecrets();
  show(
    screens.showRecoveryKey({
      keyText: formatRecoveryKey(secrets.recoveryKey),
      onConfirm: action(async () => {
        const result = await flows.createVault({ ...secrets, ...passkey });
        if (result.kind === "created") return openLibrary(result.session);
        if (result.kind === "keys-missing") return showKeysMissing();
        show(
          screens.message({
            title: "A library already exists",
            text: "Another device created the library in the meantime. Unlock it with your recovery key instead.",
            actions: [h("button", { type: "button", onclick: () => location.reload() }, "Continue")],
          }),
        );
      }),
      onError: showError,
    }),
  );
}

// ---------------------------------------------------------------- the library

/** e2ee-store SDK SPEC §6.5: compares a session's revision with the highest this device has seen. */
function checkRevision(s) {
  const seen = remembered.get(revisionKey(s));
  const { rolledBack, highest } = rollbackCheck(seen, s.root.revision);
  if (!rolledBack) remembered.set(revisionKey(s), highest);
  return rolledBack ? { seen, got: s.root.revision } : null;
}

function showWarnings() {
  const rollback = session?.rollback;
  // A newer format opens read-only, and says so up front rather than at the first save.
  const readOnly = session && (!session.root.writable || !session.keys.writable);
  replaceChildren(
    warnings,
    rollback &&
      h(
        "p",
        { class: "banner warn", role: "alert", id: "rollback-warning" },
        `The server returned an older version of your library (revision ${rollback.got}; this device has seen ${rollback.seen}). Recent changes may be missing, so saving is paused. `,
        h("button", { type: "button", id: "acknowledge-rollback", onclick: acknowledgeRollback }, "Continue anyway"),
      ),
    readOnly &&
      h("p", { class: "banner warn", role: "status", id: "read-only-warning" }, "This library was saved by a newer version of the app, so it's read-only here. Update the app to make changes."),
  );
}

function acknowledgeRollback() {
  remembered.set(revisionKey(session), session.root.revision);
  session = { ...session, rollback: null };
  showWarnings();
}

async function openLibrary(unlocked) {
  const first = session === null;
  session = { ...unlocked, rollback: checkRevision(unlocked) };
  showWarnings();
  holdingSecrets();
  settingsButton.hidden = false;
  if (first && !session.rollback && isDue(remembered.get(cleanupKey(session)), Date.now())) automaticCleanup();
  await refreshDislikes().catch(() => {});
  await replace({ screen: "home" });
  if (first) restorePlaying().catch(() => {});
}

/** Saves the steps (e2ee-store SDK SPEC §6.4); `onProgress` follows the uploads, `signal` stops them and the save. */
async function save(steps, { onProgress, signal } = {}) {
  if (session.rollback) throw new UserFacingError("Saving is paused until you continue past the warning about an older library.");
  if (!session.root.writable || !session.keys.writable) throw new UserFacingError("This library was saved by a newer version of the app, so it's read-only here. Update the app to make changes.");
  try {
    const { session: saved } = await flows.save(session, steps, { onProgress, signal });
    session = { ...saved, rollback: checkRevision(saved) };
    showWarnings();
  } catch (error) {
    if (error instanceof RollbackError) {
      session = { ...session, rollback: { seen: session.root.revision, got: error.conflict.revision } };
      showWarnings();
    }
    throw error;
  }
}

// ---------------------------------------------------------------- the library's screens (SPEC §5, §7.1)

/** The entries at `path`; none when it isn't there yet (e.g. uploads/ before the first upload). */
async function entriesAt(s, path) {
  try {
    return await flows.list(s, path);
  } catch (error) {
    if (error instanceof TreeError && error.code === "not_found") return [];
    throw error;
  }
}

const readAll = async (opened) => new Uint8Array(await new Response((await opened).stream).arrayBuffer());

/** A package's package.json, read; null when it has none, or not one this version reads. */
async function packageDocOf(s, name) {
  const entry = (await entriesAt(s, [...UPLOADS, name])).find((e) => e.name === PACKAGE_DOC && e.kind === "file");
  return entry ? readPackageDoc(await readAll(flows.read(s, entry))) : null;
}

const packageNames = async (s) => (await entriesAt(s, UPLOADS)).filter((e) => e.kind === "dir").map((e) => e.name);

/** The paths of the files below `path`, relative to it, folder by folder. */
async function filesBelow(s, path, at = []) {
  const entries = await flows.list(s, [...path, ...at]);
  const nested = await Promise.all(entries.map((e) => (e.kind === "dir" ? filesBelow(s, path, [...at, e.name]) : [[...at, e.name]])));
  return nested.flat();
}

/** The tracks below `path` this browser plays, in the order the browser lists them, folder by folder. */
async function tracksBelow(s, path) {
  const entries = await flows.list(s, path);
  const nested = await Promise.all(entries.map((e) => (e.kind === "dir" ? tracksBelow(s, [...path, e.name]) : isAudio(e) && !unplayable(typeOfEntry(e), canPlay) ? [trackOf(e, path)] : [])));
  return nested.flat();
}

/** Lists a folder of the session's tree; one that isn't there lists as empty. */
const listing = () => orEmpty((path) => flows.list(session, path));

// ---------------------------------------------------------------- where the user is (SPEC §7.1)

/**
 * Each screen opened is a step in the browser's history, so back goes back through them, in a browser and in the
 * Android app alike. A screen shown as the outcome of an action (an upload done, a package deleted) takes the place of
 * the step instead, so back doesn't undo it. A place is { screen, path }: "home", "browser" (at `path`), "likes",
 * "add" or "settings".
 */
async function render(place) {
  switch (place?.screen) {
    case "browser":
      return showBrowser(place.path);
    case "likes":
      return showLikes();
    case "dislikes":
      return showDislikes();
    case "add":
      return showAddMusic();
    case "settings":
      return showSettings();
    default:
      return showHome();
  }
}

/** Opens `place`, as a step back undoes. */
const go = (place) => {
  clearBanner();
  history.pushState(place, "");
  return render(place);
};

/** Shows `place` instead of the screen on show, as the same step. */
const replace = (place) => {
  history.replaceState(place, "");
  return render(place);
};

const goHome = () => go({ screen: "home" }).catch(showError);

// Back (or forward) to a step: its screen again, while the library is open. One for something gone since, a deleted
// package say, goes home.
addEventListener("popstate", (event) => {
  if (session === null || !event.state?.screen) return;
  clearBanner();
  render(event.state).catch((error) => (error instanceof TreeError && error.code === "not_found" ? replace({ screen: "home" }) : showError(error)));
});

async function showHome() {
  show(
    libraryScreens.home({
      packages: await packageNames(session),
      onOpen: (name) => go({ screen: "browser", path: [...UPLOADS, name] }),
      onAdd: () => go({ screen: "add" }),
      onBrowse: () => go({ screen: "browser", path: [] }).catch(showError),
      onArtists: () => go({ screen: "browser", path: ARTISTS }),
      onLikes: () => go({ screen: "likes" }),
      onDislikes: () => go({ screen: "dislikes" }),
      onError: showError,
    }),
  );
}

/** A package's tracks (sorting.js's packageTracks), with where each is sorted. */
async function packageTargetsOf(name) {
  const tracks = packageTracks(await packageFiles(listing(), name));
  const targets = packageTargets({ packageName: name, files: tracks });
  return { tracks, targets };
}

async function showBrowser(path) {
  const entries = await flows.list(session, path);
  const inPackage = path[0] === UPLOADS[0] && path.length >= 2;
  const playable = entries.filter((e) => isAudio(e) && !unplayable(typeOfEntry(e), canPlay));
  const sorting = inPackage && (path.length === 2 || path[2] === FILES) ? await packageTargetsOf(path[1]) : null;
  const here = (track) => track.path.slice(0, -1).join("/") === path.slice(3).join("/");
  const targets = new Map(sorting && path[2] === FILES ? sorting.tracks.flatMap((track, i) => (here(track) ? [[track.path.at(-1), sorting.targets[i]]] : [])) : []);
  show(
    libraryScreens.browser({
      path,
      entries,
      details: inPackage && path.length === 2 ? await packageDocOf(session, path[1]) : null,
      albums: inPackage && path.length === 2 ? albumGroups(sorting.targets) : null,
      targets,
      tracks: playable.map((e) => e.name),
      playing: playing(),
      onHome: () => go({ screen: "home" }),
      onOpen: (at) => go({ screen: "browser", path: at }),
      onPlay: async (name) => {
        setQueue(playable.map((e) => trackOf(e, path)), { kind: "folder", path });
        await play(trackOf(entries.find((e) => e.name === name), path));
      },
      onPlayAll: entries.some((e) => e.kind === "dir") || playable.length > 0 ? playAll(path) : null,
      onPlayLiked: (await likedBelow(path)) ? playLiked(path) : null,
      onDelete: deleteAndSort,
      onDownload: (name, onProgress) => download(entries.find((e) => e.name === name), onProgress),
      onSetAlbum: async (group, to) => {
        const { tracks } = await packageTargetsOf(path[1]);
        const set = regroup({ packageName: path[1], files: tracks, group, to });
        await save([setSorting(path[1], set.map(({ path: at, sort }) => ({ path: at, sort }))), sortArtists]);
        await showBrowser(path);
        showNotice(`Set where the tracks of "${group.album}" are sorted.`);
      },
      onError: showError,
    }),
  );
}

/** Saves a file to the device, decrypted (SPEC §7.1). `onProgress(bytes)` hears how much has been read. */
async function download(entry, onProgress) {
  const blob = await readWhole(await flows.read(session, entry), { size: entry.size, type: typeOfEntry(entry), onProgress });
  offer(blob, entry.name);
}

/**
 * Deletes a package, and its tracks from the artists. Its tracks that are liked stay liked: Likes shows them apart
 * (SPEC §5.6). The player stops if it plays one of them, other than from the likes.
 */
async function deleteAndSort(name) {
  const files = await packageFiles(listing(), name);
  await save([deletePackage(name), sortArtists, repointLikes]);
  const ids = new Set(files.map(({ entry }) => entry.id));
  if (ids.has(playingTrack()?.id) && !playing().startsWith(`${LIKES.join("/")}/`)) stop();
  const hashes = new Set(files.map(({ entry }) => entry.sha256));
  const kept = notInPackages((await likedEntries()).filter((entry) => hashes.has(entry.sha256)), await allPackages(listing()));
  await replace({ screen: "home" });
  const liked = kept.length === 1 ? "One of its tracks is liked: it stays in Likes." : `${kept.length} of its tracks are liked: they stay in Likes.`;
  showNotice(`Deleted the package "${name}".${kept.length ? ` ${liked}` : ""}`);
}

/** Dislikes, the newest first, each to undo (SPEC §5.8). */
async function showDislikes() {
  await refreshDislikes();
  show(
    libraryScreens.dislikes({
      tracks: dislikes,
      onHome: () => go({ screen: "home" }),
      onUndislike: async (track) => {
        await save([undislike(track.sha256)]);
        await showDislikes();
        await showLiked();
      },
      onError: showError,
    }),
  );
}

/** Likes, the newest first, with the ones whose package is gone (SPEC §5.6). */
async function showLikes() {
  const entries = newestFirst(await likedEntries());
  const lost = new Set(notInPackages(entries, await allPackages(listing())).map((entry) => [...LIKES, entry.name].join("/")));
  const tracks = entries
    .filter((e) => isAudio(e))
    .map((e) => {
      const tags = entryTags(e);
      return { ...trackOf(e, LIKES), artist: tags.artist || tags.albumArtist, liked: e.modified };
    });
  const playable = tracks.filter((track) => !unplayable(track.type, canPlay));
  show(
    libraryScreens.likes({
      tracks,
      lost,
      playing: playing(),
      onHome: () => go({ screen: "home" }),
      onPlay: async (track) => {
        setQueue(playable, { kind: "likes" });
        await play(track);
      },
      onPlayAll: async () => {
        if (playable.length === 0) throw new UserFacingError("None of these plays in this browser.");
        setQueue(playable, { kind: "likes" });
        await play(firstPlayable(playable));
      },
      onUnlike: async (track) => {
        await save([unlike(track.sha256)]);
        await showLikes();
        await showLiked();
      },
      onError: showError,
    }),
  );
}

/** Plays everything below `path` that plays here, from the first. */
const playAll = (path) => async () => {
  const tracks = await tracksBelow(session, path);
  if (tracks.length === 0) throw new UserFacingError("Nothing here plays in this browser.");
  setQueue(tracks, { kind: "below", path });
  await play(firstPlayable(tracks));
};

/** Plays the liked tracks below `path`, in Play all's order: an artist's, an album's. */
const playLiked = (path) => async () => {
  const tracks = onlyLiked(await tracksBelow(session, path), await likedEntries());
  if (tracks.length === 0) throw new UserFacingError("Nothing here is liked.");
  setQueue(tracks, { kind: "likedBelow", path });
  await play(firstPlayable(tracks));
};

/** Whether `path` is an artist's or an album's, with a liked track below it: where Play likes is offered. */
async function likedBelow(path) {
  if (path[0] !== ARTISTS[0] || path.length < 2) return false;
  return onlyLiked(await tracksBelow(session, path), await likedEntries()).length > 0;
}

/** The package a torrent already filled, if one did: its name and the paths of the files it has. */
async function packageOfTorrent(id) {
  const names = await packageNames(session);
  const docs = await Promise.all(names.map(async (name) => [name, await packageDocOf(session, name)]));
  const match = docs.find(([, doc]) => doc?.torrent?.id === id);
  if (!match) return null;
  const present = await filesBelow(session, [...UPLOADS, match[0], FILES]).catch(() => []);
  return { name: match[0], present: new Set(present.map((path) => path.join("/"))) };
}

const inWebView = /; wv\)/.test(navigator.userAgent);

function showAddMusic() {
  show(
    libraryScreens.addMusic({
      // Android's WebView takes a folder input for one picking files; it picks a folder only through the File System
      // Access API, which the Android app answers (SPEC §7.1).
      folderInput: !inWebView,
      pickFolder: inWebView && typeof window.showDirectoryPicker === "function" ? async () => filesInFolder(await window.showDirectoryPicker({ mode: "read" })) : null,
      prepare: async ({ torrent, files, onProgress }) => {
        const plan = await planUpload({
          files: files.map(picked),
          torrent: torrent && new Uint8Array(await torrent.arrayBuffer()),
          findPackage: packageOfTorrent,
          onProgress,
        });
        const tags = plan.rows.map((row) => row.tags).filter(Boolean);
        return { ...plan, name: defaultPackageName({ torrent: plan.torrent, folder: plan.folder, tags, now: Date.now() }) };
      },
      onUpload: async (plan, name, onProgress) => {
        clearBanner();
        const controller = new AbortController();
        uploading = controller;
        const awake = keepScreenOn();
        awake.kept.then((kept) => {
          if (uploading !== controller) return;
          showNotice(kept ? "The screen stays on until the upload is done." : "Keep the screen on until the upload is done: turning it off stops the upload.");
        });
        try {
          const folder = await uploadPackage(plan, name, onProgress, controller.signal);
          const done = plan.into ? `Added to the package "${folder}".` : `Uploaded the package "${folder}".`;
          // Its tracks' SHA-256s are known now, so the same bytes already sorted aren't sorted twice (SPEC §5.5).
          const sorted = await save([sortArtists, repointLikes]).then(
            () => null,
            (error) => error,
          );
          // Saved just as the user left the screen: it stays saved, and where they went stays on screen.
          if (!controller.signal.aborted) await replace({ screen: "browser", path: [...UPLOADS, folder] });
          if (sorted) showError(new UserFacingError(`${done} Sorting it into the artists failed (${sorted.message}): Sort again in the settings tries again.`));
          else showNotice(done);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          showNotice("The upload was cancelled. Nothing of it was saved.");
        } finally {
          awake.release();
          if (uploading === controller) uploading = null;
        }
      },
      // Leaving is back: where Add music was opened from.
      onCancel: () => history.back(),
      onHome: goHome,
      onError: showError,
    }),
  );
}

/** Stores what the plan says, as a new package named `name` or into the one it completes; → the package's name. */
async function uploadPackage(plan, name, onProgress, signal) {
  const rows = plan.rows.filter(stored);
  const files = rows.map((row) => ({
    path: row.path,
    source: row.file.source,
    app: { type: row.type, ...(row.tags ? { tags: row.tags } : {}), ...(row.sort && Object.keys(row.sort).length ? { sort: row.sort } : {}) },
  }));
  const missing = plan.rows.filter((row) => row.status === "missing").map((row) => row.path.join("/"));
  const now = Date.now();
  const before = plan.into ? await packageDocOf(session, plan.into) : null;
  const folder = plan.into ?? freeName(name, await packageNames(session), { extension: false });
  const doc = before
    ? { ...before, updated: new Date(now).toISOString(), files: before.files + rows.length, bytes: before.bytes + rows.reduce((sum, row) => sum + row.file.size, 0), missing }
    : packageDoc({ name: folder, source: plan.source, torrent: plan.torrent, files: rows.map((row) => row.file), missing, uploaded: now });
  await save([savePackage({ name: folder, into: plan.into, files, doc, torrent: plan.into ? null : (plan.torrent?.bytes ?? null) })], { onProgress, signal });
  return folder;
}

// ---------------------------------------------------------------- settings

/** Runs `fn`; if the server wants a recent login first (e2ee-store/backend/SPEC.md §6.5), asks for one and runs it again. */
async function withStepUp(fn) {
  try {
    return await fn();
  } catch (error) {
    // Too old a session, or one not created with a passkey (e.g. from a setup token): log in with a passkey.
    if (!(error instanceof api.ApiError && ["reauth_required", "passkey_session_required"].includes(error.code))) throw error;
    return new Promise((resolve, reject) => {
      show(
        screens.confirmIdentity({
          onConfirm: async () => {
            await flows.reauthenticate(session);
            fn().then(resolve, reject);
          },
          onCancel: () => {
            showSettings().then(resolve, reject);
          },
          onError: showError,
        }),
      );
    });
  }
}

async function showSettings() {
  show(screens.loading("Loading settings"));
  // The keys may have changed on another device (e.g. it added its passkey's slot) since this session loaded them.
  const [{ passkeys }, keys] = await Promise.all([api.passkeys(), flows.loadKeys()]);
  if (keys) session = { ...session, keys };
  show(
    screens.settings({
      host: location.hostname,
      passkeys,
      slots: Object.keys(session.keys.doc.passkeys),
      lastCleanup: remembered.get(cleanupKey(session)),
      onAddPasskey: action(async () => showAddPasskey()),
      onSetUp: action(async (passkey) => {
        session = await flows.addPasskeySlot(session, passkey.id, await flows.prfFromPasskey(passkey.id));
        await showSettings();
        showNotice(`"${passkey.name}" can now unlock the library.`);
      }),
      onDeletePasskey: action((passkey) => withStepUp(() => deletePasskey(passkey))),
      onAddDevice: action(() => withStepUp(addDevice)),
      onReplaceRecoveryKey: action(async () => replaceRecoveryKey()),
      onTestRecoveryKey: (recoveryKey) => flows.testRecoveryKey(session, recoveryKey),
      onResort: action(async () => {
        await save([sortArtists, repointLikes]);
        showNotice("Sorted every package's tracks into artists and albums again.");
      }),
      onCleanup: action(manualCleanup),
      onCheckDuplicates: action(async () => {
        const found = duplicates(await walk(listing(), []));
        show(screens.duplicatesReport({ found, onDone: () => showSettings().catch(showError) }));
      }),
      onBack: () => history.back(),
      onError: showError,
    }),
  );
  if (!keys) showError(new UserFacingError("The library's keys are missing on the server. Restore the server's data from a backup; this session still works until it's locked."));
}

function showAddPasskey() {
  show(
    screens.createPasskey({
      title: "Add a passkey on this device",
      intro: "The new passkey can unlock the library on this device.",
      defaultName: defaultPasskeyName(),
      onCreate: action((name) =>
        withStepUp(async () => {
          const registered = await flows.registerPasskey(name);
          await withPrf(registered, async (prfOutput) => {
            session = await flows.addPasskeySlot(session, registered.credentialId, prfOutput);
            await showSettings();
            showNotice(`"${name}" was added.`);
          });
        }),
      ),
      onSkip: () => showSettings(),
      onError: showError,
    }),
  );
}

async function deletePasskey(passkey) {
  await api.deletePasskey(passkey.id);
  // Deleting the passkey this session was created with ends the session; cleanup removes its slot later.
  if (passkey.current) return lock();
  if (session.keys.doc.passkeys[passkey.id]) session = await flows.removePasskeySlot(session, passkey.id);
  await showSettings();
  showNotice(`"${passkey.name}" was deleted.`);
}

async function addDevice() {
  const created = await api.createSetupToken();
  show(screens.setupLink({ token: created.token, expiresAt: created.expires_at, links: created.links, onDone: () => showSettings().catch(showError), onError: showError }));
}

function replaceRecoveryKey() {
  const recoveryKey = generateRecoveryKey();
  show(
    screens.showRecoveryKey({
      keyText: formatRecoveryKey(recoveryKey),
      confirmLabel: "Use this recovery key",
      onConfirm: action(async () => {
        session = await flows.replaceRecoveryKey(session, recoveryKey);
        await showSettings();
        showNotice("The recovery key was replaced. The old one no longer works.");
      }),
      onCancel: () => showSettings().catch(showError),
      onError: showError,
    }),
  );
}

async function manualCleanup() {
  if (session.rollback) throw new UserFacingError("Cleanup is paused while the warning about an older library is shown.");
  const progress = screens.cleanupProgress();
  show(progress.element);
  const { session: next, report } = await flows.maintain(session, "manual", progress.update);
  session = { ...session, keys: next.keys };
  remembered.set(cleanupKey(session), report);
  show(screens.cleanupReport({ report, onDone: () => showSettings().catch(showError) }));
}

/** In the background after the first unlock, at most once a day per device; failures are retried next time. */
async function automaticCleanup() {
  const { session: next, report } = await flows.maintain(session, "automatic");
  if (session) {
    session = { ...session, keys: next.keys };
    remembered.set(cleanupKey(session), report);
  }
}

// ---------------------------------------------------------------- start

// Any request that finds the session gone locks, whatever screen is showing.
api.setUnauthenticatedHandler(lock);
lockButton.addEventListener("click", lock);
settingsButton.addEventListener("click", () => go({ screen: "settings" }).catch(showError));

async function start() {
  // From the start, not just once the library opens: secrets are in memory earlier on some paths.
  watchInactivity();
  const token = parseSetupFragment(location.hash);
  if (token) {
    history.replaceState(null, "", location.pathname + location.search);
    return setup(token);
  }
  return showUnlock();
}

start().catch(showError);
