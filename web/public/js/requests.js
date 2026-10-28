// The request counter (SPEC §7.1): how many requests to the server a burst of work has sent, how many are answered, and
// how long the oldest unanswered one has waited, so that a slow network reads as slow rather than stuck. Plain
// functions of data, and `counting`, which wraps `fetch` to feed them. The worker's play requests aren't the page's
// fetches; the traffic counter shows those.

/** How long the line stays after the last request ends; a pause this long also starts a new burst. */
export const LINGER_MS = 3000;

/** A wait shorter than this isn't worth saying. */
const MENTION_WAIT_MS = 2000;

/** Nothing sent yet. `waiting` holds { id, at } per request without an answer. */
export const NONE = { sent: 0, answered: 0, failed: 0, cancelled: 0, waiting: [], last: -Infinity };

/** The counts once request `id` is sent at `at`. A burst that ended a while ago starts again from zero. */
export function sent(state, id, at) {
  const current = state.waiting.length === 0 && at - state.last > LINGER_MS ? NONE : state;
  return { ...current, sent: current.sent + 1, waiting: [...current.waiting, { id, at }], last: at };
}

/** The counts once request `id` ends at `at`, `outcome` being "answered" (any response), "failed" or "cancelled". */
export function ended(state, id, at, outcome) {
  if (!state.waiting.some((request) => request.id === id)) return state;
  return { ...state, [outcome]: state[outcome] + 1, waiting: state.waiting.filter((request) => request.id !== id), last: at };
}

/** "Requests: 4 of 7 answered · 3 waiting, the longest 37 s"; null when there is nothing to show at `now`. */
export function describe(state, now) {
  if (state.waiting.length === 0 && now - state.last > LINGER_MS) return null;
  const longest = state.waiting.reduce((most, { at }) => Math.max(most, now - at), 0);
  const waiting = state.waiting.length > 0 && `${state.waiting.length} waiting${longest >= MENTION_WAIT_MS ? `, the longest ${Math.floor(longest / 1000)} s` : ""}`;
  return [
    `Requests: ${state.answered} of ${state.sent} answered`,
    waiting,
    state.failed > 0 && `${state.failed} failed`,
    state.cancelled > 0 && `${state.cancelled} cancelled`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Whether a fetch of `input` is a request to the server's API, the ones counted. */
export const isApiRequest = (input, base) => new URL(input instanceof Request ? input.url : String(input), base).pathname.startsWith("/api/");

/**
 * `fetch`, telling `onRequest({ id, at })` when an API request is sent and `onEnd({ id, at, outcome })` when it ends:
 * with a response of any status, without one, or aborted.
 */
export function counting(fetch, { base, now, onRequest, onEnd }) {
  let next = 0;
  return (input, init) => {
    if (!isApiRequest(input, base)) return fetch(input, init);
    const id = next++;
    onRequest({ id, at: now() });
    const answer = fetch(input, init);
    answer.then(
      () => onEnd({ id, at: now(), outcome: "answered" }),
      (error) => onEnd({ id, at: now(), outcome: error?.name === "AbortError" ? "cancelled" : "failed" }),
    );
    return answer;
  };
}
