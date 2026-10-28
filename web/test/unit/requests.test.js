import { test } from "node:test";
import assert from "node:assert/strict";

import { counting, describe, ended, isApiRequest, LINGER_MS, NONE, sent } from "../../public/js/requests.js";

const base = "http://a1b2c3d4e5f60718.localhost:24680/";

test("a burst says how many of its requests are answered, and how many wait", () => {
  const three = [0, 1, 2].reduce((state, id) => sent(state, id, 1000), NONE);
  assert.equal(describe(three, 1000), "Requests: 0 of 3 answered · 3 waiting");
  const one = ended(three, 1, 1500, "answered");
  assert.equal(describe(one, 1500), "Requests: 1 of 3 answered · 2 waiting");
});

test("a long wait says how long the oldest has waited", () => {
  const state = sent(sent(NONE, 0, 1000), 1, 30_000);
  assert.equal(describe(state, 38_400), "Requests: 0 of 2 answered · 2 waiting, the longest 37 s");
});

test("failures and cancellations are said, and only when there are any", () => {
  const state = [0, 1, 2].reduce((s, id) => sent(s, id, 0), NONE);
  const done = ended(ended(ended(state, 0, 10, "answered"), 1, 20, "failed"), 2, 30, "cancelled");
  assert.equal(describe(done, 40), "Requests: 1 of 3 answered · 1 failed · 1 cancelled");
});

test("the line goes a while after the last request ends, and the next burst counts from zero", () => {
  const done = ended(sent(NONE, 0, 0), 0, 100, "answered");
  assert.equal(describe(done, 100 + LINGER_MS), "Requests: 1 of 1 answered");
  assert.equal(describe(done, 101 + LINGER_MS), null);
  assert.equal(describe(sent(done, 1, 200 + LINGER_MS), 200 + LINGER_MS), "Requests: 0 of 1 answered · 1 waiting");
});

test("a request sent soon after the last one ended belongs to the same burst", () => {
  const done = ended(sent(NONE, 0, 0), 0, 100, "answered");
  assert.equal(describe(sent(done, 1, 500), 500), "Requests: 1 of 2 answered · 1 waiting");
});

test("an end for a request not waiting changes nothing", () => {
  const state = sent(NONE, 0, 0);
  assert.equal(ended(state, 7, 10, "answered"), state);
});

test("only the API's requests are counted", () => {
  assert.equal(isApiRequest("/api/v1/me", base), true);
  assert.equal(isApiRequest(new Request(`${base}api/v1/blobs/x`), base), true);
  assert.equal(isApiRequest("/sdk/api.js", base), false);
  assert.equal(isApiRequest("/play/x?salt=y", base), false);
});

test("the counting fetch reports each API request's start and how it ended", async () => {
  const events = [];
  const responses = { "/api/ok": () => Promise.resolve(new Response("x", { status: 404 })), "/api/down": () => Promise.reject(new TypeError("Failed to fetch")), "/api/gone": () => Promise.reject(new DOMException("aborted", "AbortError")), "/index.html": () => Promise.resolve(new Response("page")) };
  const fetch = counting((input) => responses[input](), {
    base,
    now: () => 5,
    onRequest: (request) => events.push(["sent", request.id]),
    onEnd: ({ id, outcome }) => events.push([outcome, id]),
  });
  assert.equal((await fetch("/api/ok")).status, 404);
  await assert.rejects(fetch("/api/down"), TypeError);
  await assert.rejects(fetch("/api/gone"), { name: "AbortError" });
  assert.equal(await (await fetch("/index.html")).text(), "page");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [["sent", 0], ["answered", 0], ["sent", 1], ["failed", 1], ["sent", 2], ["cancelled", 2]]);
});
