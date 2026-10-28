// The player's own controls (SPEC §7.1): play/pause, and a seek bar with the times, over the <audio> element, which
// shows none of its own. Next, previous, shuffle and repeat are main.js's.

/** Seconds as "m:ss", or "h:mm:ss" from an hour on; "0:00" for what isn't a time (yet). */
export function clock(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const [hours, minutes, rest] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** Wires the controls to `audio`. `onError` gets a play() the browser refuses. */
export function connectPlayerBar(audio, { seek, elapsed, duration, playPause, onError }) {
  // While the bar is dragged, it shows where it would go; the track seeks once it is let go, not at every step.
  let dragging = false;
  const showTime = () => {
    const length = Number.isFinite(audio.duration) ? audio.duration : 0;
    seek.max = String(length);
    if (!dragging) seek.value = String(Math.min(audio.currentTime, length));
    elapsed.textContent = clock(dragging ? Number(seek.value) : audio.currentTime);
    duration.textContent = clock(length);
  };
  const showPlaying = () => {
    playPause.textContent = audio.paused ? "▶" : "⏸";
    playPause.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  };
  for (const event of ["timeupdate", "durationchange", "loadedmetadata", "seeked", "emptied"]) audio.addEventListener(event, showTime);
  for (const event of ["play", "pause", "ended", "emptied"]) audio.addEventListener(event, showPlaying);
  seek.addEventListener("input", () => {
    dragging = true;
    showTime();
  });
  seek.addEventListener("change", () => {
    dragging = false;
    audio.currentTime = Number(seek.value);
    showTime();
  });
  playPause.addEventListener("click", () => (audio.paused ? audio.play().catch(onError) : audio.pause()));
  showTime();
  showPlaying();
}
