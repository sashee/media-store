// The traffic counters (SPEC §7.1): what goes to and comes from the server, as a rate over the last two seconds, and as
// amounts over the last minute and since the app started. Plain functions of data: the samples are { at, down, up },
// `at` in milliseconds, taken from the events of the requests the page and the worker watch (requests.js).

import { formatBytes } from "../sdk/maintenance.js";

/** The window the rate is averaged over. */
export const WINDOW_MS = 2000;

/** The window the recent amounts are summed over. */
export const MINUTE_MS = 60 * 1000;

/** The samples still in the window of `window` milliseconds ending at `now`. */
export const recent = (samples, now, window = WINDOW_MS) => samples.filter(({ at }) => at > now - window);

/** Bytes received per second over the rate's window ending at `now`. */
export const rate = (samples, now) => recent(samples, now).reduce((sum, { down }) => sum + down, 0) / (WINDOW_MS / 1000);

/** What the samples add up to: { down, up }. */
export const total = (samples) => samples.reduce((sum, { down, up }) => ({ down: sum.down + down, up: sum.up + up }), { down: 0, up: 0 });

/** `amounts` ({ down, up }) with the samples' added. */
export const plus = (amounts, samples) => {
  const more = total(samples);
  return { down: amounts.down + more.down, up: amounts.up + more.up };
};

/** "↓ 1.2 MB/s" */
export const formatRate = (bytesPerSecond) => `↓ ${formatBytes(Math.round(bytesPerSecond))}/s`;

const amounts = ({ down, up }) => `↓ ${formatBytes(down)} ↑ ${formatBytes(up)}`;

/** "Last min ↓ 45.2 MB ↑ 1.2 MB · since start ↓ 320 MB ↑ 8.0 MB": one line on a phone. */
export const formatUsage = ({ minute, started }) => `Last min ${amounts(minute)} · since start ${amounts(started)}`;

/** The sample a request's event (requests.js) makes: its body going up as it is sent, its answer's coming down; else null. */
export function sampleOf(event) {
  if (event.type === "sent" && event.up > 0) return { at: event.at, down: 0, up: event.up };
  if (event.type === "bytes") return { at: event.at, down: event.bytes, up: 0 };
  return null;
}
