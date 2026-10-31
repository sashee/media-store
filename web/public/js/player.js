// The page's side of playback (SPEC §6): it registers the Service Worker (sw.js), makes sure the worker controls the
// page before anything is played, and answers the play URLs the worker passes on. The decrypting happens here, so the
// key never leaves the page.

import { isEvent } from "./requests.js";

const WORKER = "/sw.js";

/**
 * Starts the worker. `respond(url, range)` answers a play URL whose request had the Range header `range` (or none),
 * with a Response. `onError(message, url)` gets what couldn't be played, and its play URL: a failed read, before or
 * while the bytes go out.
 * `onRequests(events)` hears how the worker's requests to the server went since it last said (requests.js).
 * Resolves once the worker controls this page: only then may a play URL be used, or it would go to the server.
 */
export async function startPlayback({ respond, onError, onRequests = () => {} }) {
  if (!("serviceWorker" in navigator)) throw new Error("This browser can't play tracks: it doesn't support Service Workers.");
  const container = navigator.serviceWorker;
  container.addEventListener("message", (event) => {
    if (event.data?.type === "play" && event.ports[0]) answer(event.data, event.ports, { respond, onError });
    if (event.data?.type === "requests" && Array.isArray(event.data.events)) onRequests(event.data.events.filter(isEvent));
  });
  container.startMessages();
  const registration = await container.register(WORKER, { type: "module", scope: "/" });
  await container.ready;
  if (container.controller) return;
  // Loaded without the worker, e.g. by a reload that bypassed it: the worker takes the page over when asked.
  const controlled = new Promise((resolve) => container.addEventListener("controllerchange", resolve, { once: true }));
  registration.active.postMessage({ type: "claim" });
  await controlled;
}

/** Empties the worker's cache of what was read: on locking. */
export function forgetReads() {
  navigator.serviceWorker?.controller?.postMessage({ type: "forget" });
}

/** At the start of a track, how much of the next one is fetched ahead, so a skip to it starts at once (SPEC §6.3). */
export const NEXT_START_BYTES = 512 * 1024;

/** How long before a track ends the next one's share (`aheadBytes`) is fetched. */
export const AHEAD_LEAD_S = 30;

/**
 * How much of the next track, of `size` bytes, is fetched as the current one nears its end: a share of its file, so
 * about the same share of its length whatever its bitrate; at least its start, at most what the worker fetches in one go.
 */
export const aheadBytes = (size, { share = 0.2, min = NEXT_START_BYTES, max = 32 * 1024 * 1024 } = {}) => Math.max(min, Math.min(max, Math.round(size * share)));

/** Whether a track at `currentTime` of `duration` seconds is near enough its end for the next one's share. */
export const nearEnd = (currentTime, duration, lead = AHEAD_LEAD_S) => Number.isFinite(duration) && duration - currentTime <= lead;

/** Tells the worker which blob plays now (null: none), so it stops reading the others ahead. */
export function playingNow(id) {
  navigator.serviceWorker?.controller?.postMessage({ type: "playing", id });
}

/**
 * Answers a play URL over the first port: status, headers and the body, which moves to the worker as a stream. The
 * second, from a worker that has one, hears at once that this page is on it: the answer can then wait for the bytes
 * as long as the cache tries for them (sw.js).
 */
async function answer({ url, range }, [port, working], { respond, onError }) {
  working?.postMessage("working");
  // Which play URL failed goes with it: a track left behind failing is no news (main.js).
  const report = (message) => onError(message, url);
  let response;
  try {
    response = await respond(new URL(url), range);
  } catch (error) {
    report(error?.message ?? String(error));
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    response = new Response("Can't play this track", { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const body = response.body && reportingErrors(response.body, report);
  port.postMessage({ status: response.status, headers: [...response.headers], body }, body ? [body] : []);
}

/**
 * `stream`, with a failure while it is read passed to `onError`. The player going away isn't one: a seek, a pause or
 * a new track cancels its request, which may error or close this stream while a read is still under way. That read's
 * bytes then have nowhere to go, and are dropped.
 */
export function reportingErrors(stream, onError) {
  const reader = stream.getReader();
  let gone = false;
  return new ReadableStream(
    {
      async pull(controller) {
        let next;
        try {
          next = await reader.read();
        } catch (error) {
          if (!gone && error?.name !== "AbortError") onError(error?.message ?? String(error));
          controller.error(error);
          return;
        }
        try {
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch {
          // Closed or errored meanwhile, from the other side.
          reader.cancel().catch(() => {});
        }
      },
      cancel: (reason) => {
        gone = true;
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
