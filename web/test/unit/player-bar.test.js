import { test } from "node:test";
import assert from "node:assert/strict";

import { clock } from "../../public/js/ui/player-bar.js";

test("times read as m:ss, and h:mm:ss from an hour on", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(5.9), "0:05");
  assert.equal(clock(65), "1:05");
  assert.equal(clock(600), "10:00");
  assert.equal(clock(3600 + 62), "1:01:02");
  assert.equal(clock(NaN), "0:00", "before the track's length is known");
  assert.equal(clock(Infinity), "0:00");
  assert.equal(clock(-3), "0:00");
});
