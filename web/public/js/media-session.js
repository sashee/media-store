// The Media Session (SPEC §6.2): what the system shows of the player, and its buttons: desktop Chrome's media controls,
// and in the Android app a notification and the lock screen, through its bridge. The standard API only; without it,
// nothing happens.

const SEEK_OFFSET_S = 10;

const supported = () => "mediaSession" in navigator;

/**
 * Connects the <audio> element to the Media Session: its state and position go out, and the system's buttons come in.
 * `onPrevious`, `onNext` and `onStop` are the app's; play, pause and seeking act on the element. `onError` gets what
 * fails, e.g. a play() the browser refuses; not one a new load interrupts.
 */
export function connectMediaSession(audio, { onPrevious, onNext, onStop, onError }) {
  if (!supported()) return;
  const session = navigator.mediaSession;
  const clamp = (time) => Math.max(0, Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time));
  const seek = (time) => {
    audio.currentTime = clamp(time);
  };
  const handlers = {
    play: () => audio.play().catch((error) => error?.name === "AbortError" || onError(error)),
    pause: () => audio.pause(),
    stop: onStop,
    previoustrack: onPrevious,
    nexttrack: onNext,
    seekto: ({ seekTime }) => seek(seekTime),
    seekbackward: ({ seekOffset }) => seek(audio.currentTime - (seekOffset ?? SEEK_OFFSET_S)),
    seekforward: ({ seekOffset }) => seek(audio.currentTime + (seekOffset ?? SEEK_OFFSET_S)),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // An action this browser doesn't know: its button just doesn't show.
    }
  }

  // The system moves the position along by itself while playing; it needs it again only when that changes otherwise.
  const position = () => {
    if (Number.isFinite(audio.duration)) session.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: clamp(audio.currentTime) });
  };
  for (const event of ["loadedmetadata", "durationchange", "seeked", "ratechange", "play", "pause"]) audio.addEventListener(event, position);
  audio.addEventListener("play", () => (session.playbackState = "playing"));
  audio.addEventListener("pause", () => (session.playbackState = "paused"));
}

/**
 * Shows `track` as the one in the player; null for none. `status` goes where an artist would: what shuffle and repeat
 * are (queue.js), as the system's controls have no place of their own for them.
 */
export function showTrack(track, status = "") {
  if (!supported()) return;
  navigator.mediaSession.metadata = track ? new MediaMetadata({ title: track.title, artist: status }) : null;
  if (!track) navigator.mediaSession.playbackState = "none";
}
