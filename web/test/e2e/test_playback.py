"""End-to-end: the real backend behind socat (as the iroh shim reaches it), Chromium with a virtual authenticator
that supports PRF, and playing what was uploaded (web SPEC §6, §7):

  setup link → library → a package of tracks → play, seek, end → lock → unlock → play again

Also checks what the Service Worker answers for play URLs (206 ranges, 200, 416, nothing while locked), that no
plaintext reaches any stored blob, the player's controls, the queue with the Media Session: next, previous, moving on
at a track's end, and the system's buttons, called the way the Android app's bridge will; the worker's cache of
encrypted bytes: reads of what was fetched don't reach the server, the next track's start is fetched before it plays,
and locking empties it; the traffic counter; and shuffle and repeat. Uploading itself is test_upload.py's.

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_playback.py    # after `make deps`
"""

import io
import math
import os
import re
import struct
import sys
import wave

from playwright.sync_api import expect

from harness import Backend, create_library, harness, lock, new_device, open_package, play_button, unlock, upload

SECONDS = 2
PACKAGE = "Tones"


def tone(seconds: float, rate: int = 22050) -> bytes:
    """A WAV of a 440 Hz sine: about three of the SDK's 64 KiB chunks for two seconds."""
    samples = b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(int(seconds * rate)))
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples)
    return out.getvalue()


def tagged(wav: bytes, **fields: str) -> bytes:
    """`wav` with a RIFF LIST/INFO chunk of tags: INAM (title), IART (artist), IPRD (album), ITRK (track)."""
    def chunk(chunk_id: bytes, data: bytes) -> bytes:
        return chunk_id + struct.pack("<I", len(data)) + data + (b"\0" if len(data) % 2 else b"")

    ids = {"title": b"INAM", "artist": b"IART", "album": b"IPRD", "track": b"ITRK"}
    info = chunk(b"LIST", b"INFO" + b"".join(chunk(ids[key], value.encode() + b"\0") for key, value in fields.items()))
    body = wav[8:] + info
    return b"RIFF" + struct.pack("<I", len(body)) + body


def fetch(page, url: str, range_header: str | None = None) -> dict:
    """The Service Worker's answer to a request from the page."""
    return page.evaluate(
        """async ([url, range]) => {
            const response = await fetch(url, { headers: range ? { Range: range } : {} });
            const body = [...new Uint8Array(await response.arrayBuffer())];
            return { status: response.status, headers: Object.fromEntries(response.headers), body };
        }""",
        [url, range_header],
    )


# Records the Media Session's action handlers as the page sets them, so the test can press the system's buttons.
RECORD_MEDIA_ACTIONS = """
window.mediaActions = {};
const setActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
navigator.mediaSession.setActionHandler = (action, handler) => {
  window.mediaActions[action] = handler;
  setActionHandler(action, handler);
};
"""


def press(page, action: str, details: dict | None = None) -> None:
    """A button of the system's media controls."""
    page.evaluate("([action, details]) => window.mediaActions[action]({ action, ...details })", [action, details or {}])


class BlobLog:
    """The blob reads that reached the backend, from its log (next to its database, where the harness keeps it)."""

    def __init__(self, backend: Backend):
        self.path = os.path.join(os.path.dirname(backend.database), "server.log")

    def lines(self) -> list[str]:
        with open(self.path) as log:
            return [line for line in log if "GET /api/v1/blobs/" in line]

    def count(self, blob_id: str) -> int:
        return sum(blob_id in line for line in self.lines())


def blob_of(url: str) -> str:
    return re.search(r"/play/([0-9a-f]{64})", url).group(1)


def playing(page, title: str) -> None:
    """Waits until `title` is in the player and playing."""
    expect(page.locator("#now-playing")).to_have_text(title)
    page.wait_for_function("() => { const a = document.getElementById('audio'); return a.currentTime > 0.1 && !a.paused; }", timeout=20_000)


def run(browser, backend: Backend, port: int) -> None:
    wav = tone(SECONDS)
    a_wav = tagged(tone(5), title="A one", artist="Tester", album="Tones", track="1")
    tracks = [("A one.wav", a_wav), ("B two.wav", tone(2)), ("C three.wav", tone(5)), ("D four.wav", wav)]
    device = new_device(browser, f"http://localhost:{port}")
    page = device.page
    page.context.add_init_script(RECORD_MEDIA_ACTIONS)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    token = backend.setup_token("user", "create", "alice")
    create_library(page, token)
    expect(page.locator("#packages")).to_contain_text("Nothing uploaded yet")
    print("  ok    library created from a setup link")

    # --- a package of tracks
    upload(page, [(name, data, "audio/wav") for name, data in tracks] + [("notes.txt", b"not music at all", "text/plain")], name=PACKAGE)
    page.locator("li[data-entry='files'] button").click()
    expect(page.locator("#entries li[data-track]")).to_have_count(4)
    expect(page.locator("li[data-entry='notes.txt'] button[data-action='play']")).to_have_count(0)
    expect(page.locator("li[data-entry='A one.wav']")).to_contain_text("→ Tester / Tones / 01 A one.wav")
    expect(page.locator("li[data-entry='B two.wav']")).to_contain_text("→ Tester / Tones / B two.wav")
    blobs = backend.blob_contents()
    for secret in [b"RIFF", b"WAVE", b"Tester", b"not music", wav[1000:1032]]:
        assert not any(secret in blob for blob in blobs), f"{secret!r} is stored in plaintext"
    print("  ok    a package of tracks: its files, their sort targets, nothing of it stored in plaintext")

    # --- playing and seeking, the last track in its folder
    play_button(page, "D four.wav").click()
    page.wait_for_function("() => { const a = document.getElementById('audio'); return a.currentTime > 0.2 && !a.paused; }", timeout=20_000)
    expect(page.locator("#now-playing")).to_have_text("D four")
    duration = page.evaluate("document.getElementById('audio').duration")
    assert abs(duration - SECONDS) < 0.1, duration
    page.evaluate("document.getElementById('audio').currentTime = 1.5")
    page.wait_for_function("() => document.getElementById('audio').ended", timeout=20_000)
    print("  ok    the track plays, seeks and ends")

    # --- what the worker answers
    url = page.evaluate("document.getElementById('audio').src")
    assert "/play/" in url, url
    size = len(wav)
    partial = fetch(page, url, "bytes=70000-70099")
    assert partial["status"] == 206, partial["status"]
    assert bytes(partial["body"]) == wav[70000:70100]
    assert partial["headers"]["content-range"] == f"bytes 70000-70099/{size}"
    assert partial["headers"]["content-type"] == "audio/wav"
    suffix = fetch(page, url, "bytes=-10")
    assert (suffix["status"], bytes(suffix["body"])) == (206, wav[-10:])
    whole = fetch(page, url)
    assert (whole["status"], bytes(whole["body"])) == (200, wav)
    assert whole["headers"]["accept-ranges"] == "bytes"
    assert fetch(page, url, f"bytes={size}-")["status"] == 416
    assert fetch(page, url.replace("/play/", "/play/0"))["status"] == 404
    print("  ok    the worker answers ranges (206), the whole track (200) and past its end (416)")

    # --- locked: the worker has no key, and nothing is played
    lock(page)
    assert page.evaluate("navigator.serviceWorker.controller !== null")
    assert fetch(page, url, "bytes=0-99")["status"] == 403
    print("  ok    after locking, the worker plays nothing")

    unlock(page)
    open_package(page, PACKAGE, "files")
    play_button(page, "D four.wav").click()
    page.wait_for_function("() => document.getElementById('audio').currentTime > 0.2", timeout=20_000)
    page.evaluate("document.getElementById('audio').pause()")
    print("  ok    unlocked again, it plays again")

    # --- locked and unlocked again: the player is as it was left, paused, only its start fetched; kept sealed
    position = page.evaluate("document.getElementById('audio').currentTime")
    lock(page)
    assert not any(secret in page.evaluate("Object.values(localStorage).join(' ')") for secret in ["D four", PACKAGE, "uploads"])
    unlock(page)
    expect(page.locator("#now-playing")).to_have_text("D four")
    page.wait_for_function("() => document.getElementById('audio').currentTime > 0")
    restored = page.evaluate("(({ paused, preload, currentTime }) => [paused, preload, currentTime])(document.getElementById('audio'))")
    assert restored[:2] == [True, "metadata"], restored
    assert abs(restored[2] - position) < 0.05, (restored, position)
    page.click("#play-pause")
    page.wait_for_function(f"() => document.getElementById('audio').currentTime > {position + 0.1}", timeout=20_000)
    page.evaluate("document.getElementById('audio').pause()")
    open_package(page, PACKAGE, "files")
    print("  ok    locked and unlocked again, the player picks up where it stopped, kept sealed on the device")

    # --- the queue: the folder's tracks, in its order
    play_button(page, "A one.wav").click()
    playing(page, "A one")
    assert page.evaluate("[navigator.mediaSession.metadata.title, navigator.mediaSession.playbackState]") == ["A one", "playing"]
    expect(page.locator("#duration")).to_have_text("0:05")
    page.click("#play-pause")
    page.wait_for_function("() => document.getElementById('audio').paused")
    expect(page.locator("#play-pause")).to_have_attribute("aria-label", "Play")
    page.evaluate("() => { const seek = document.getElementById('seek'); seek.value = '3'; seek.dispatchEvent(new Event('change')); }")
    page.wait_for_function("() => Math.abs(document.getElementById('audio').currentTime - 3) < 0.1")
    expect(page.locator("#elapsed")).to_have_text("0:03")
    expect(page.locator(".banner.error")).to_have_count(0)  # a seek while paused cancels reads; that's no error
    page.click("#play-pause")
    page.wait_for_function("() => !document.getElementById('audio').paused")
    expect(page.locator("#play-pause")).to_have_attribute("aria-label", "Pause")
    print("  ok    the player's own controls: play and pause, the seek bar, and the times")
    page.click("#next")
    playing(page, "B two")
    playing(page, "C three")  # B ended
    print("  ok    next, and the next track when one ends")

    press(page, "previoustrack")
    expect(page.locator("#now-playing")).to_have_text("B two")
    playing(page, "C three")
    page.evaluate("document.getElementById('audio').currentTime = 3.5")
    page.wait_for_function("() => document.getElementById('audio').currentTime > 3.5")
    press(page, "previoustrack")
    page.wait_for_function("() => document.getElementById('audio').currentTime < 1")
    expect(page.locator("#now-playing")).to_have_text("C three")
    print("  ok    previous: the track before, or this one from the start once it has played a while")

    press(page, "pause")
    page.wait_for_function("() => document.getElementById('audio').paused && navigator.mediaSession.playbackState === 'paused'")
    press(page, "play")
    page.wait_for_function("() => !document.getElementById('audio').paused && navigator.mediaSession.playbackState === 'playing'")
    press(page, "seekto", {"seekTime": 2})
    page.wait_for_function("() => { const t = document.getElementById('audio').currentTime; return t >= 2 && t < 3; }")
    press(page, "nexttrack")
    playing(page, "D four")
    press(page, "nexttrack")
    expect(page.locator("#now-playing")).to_have_text("D four")
    press(page, "stop")
    expect(page.locator("#player")).to_be_hidden()
    assert page.evaluate("navigator.mediaSession.metadata") is None
    print("  ok    the system's buttons: play, pause, seek, next (nothing after the last), previous and stop")

    # --- the worker's cache of encrypted bytes
    log = BlobLog(backend)
    play_button(page, "A one.wav").click()
    playing(page, "A one")
    url_a = page.evaluate("document.getElementById('audio').src")
    a_id = blob_of(url_a)
    page.wait_for_timeout(500)  # the read of the whole track ends in the cache
    fetched = log.count(a_id)
    assert fetched >= 1
    for start, end in [(0, 99), (100_000, 100_099), (len(a_wav) - 100, len(a_wav) - 1)]:
        answer = fetch(page, url_a, f"bytes={start}-{end}")
        assert (answer["status"], bytes(answer["body"])) == (206, a_wav[start : end + 1]), (start, end)
    assert log.count(a_id) == fetched, "what was fetched is read from the cache, not the server"
    print("  ok    reads of a track already fetched don't reach the server")

    before_next = len(log.lines())
    page.click("#next")
    playing(page, "B two")
    b_id = blob_of(page.evaluate("document.getElementById('audio').src"))
    first_read_of_b = next(i for i, line in enumerate(log.lines()) if b_id in line)
    assert first_read_of_b < before_next, "the next track's start was fetched while the one before played"
    print("  ok    the next track's start is fetched before it plays")

    page.evaluate("document.getElementById('audio').pause()")
    lock(page)
    unlock(page)
    answer = fetch(page, url_a, "bytes=0-99")
    assert (answer["status"], bytes(answer["body"])) == (206, a_wav[:100])
    assert log.count(a_id) > fetched, "locking emptied the cache"
    print("  ok    locking empties the cache")

    # --- the traffic counter
    expect(page.locator("#traffic")).to_be_visible()
    open_package(page, PACKAGE, "files")
    play_button(page, "C three.wav").click()
    playing(page, "C three")
    page.wait_for_function("() => /↓ [1-9]/.test(document.getElementById('traffic').textContent)", timeout=10_000)
    page.wait_for_function("() => document.getElementById('traffic').textContent === '↓ 0 B/s'", timeout=10_000)
    print("  ok    the counter shows what is fetched, and goes back to nothing")

    # --- repeat and shuffle, and what the notification shows of them
    # Whether the track is liked comes first, once known: none of these is.
    shows = lambda line: page.wait_for_function(f"() => navigator.mediaSession.metadata?.artist === {line!r}")
    shows("♡ Not liked")
    page.click("#repeat")
    page.click("#repeat")
    expect(page.locator("#repeat")).to_have_attribute("data-mode", "one")
    shows("♡ Not liked · Repeat one")
    play_button(page, "D four.wav").click()  # 2 s, and the last
    playing(page, "D four")
    page.wait_for_timeout(2500)
    assert page.evaluate("!document.getElementById('audio').paused"), "the last track plays again and again"
    expect(page.locator("#now-playing")).to_have_text("D four")

    # Paused, so that the track doesn't end, and move on, while the modes change.
    page.evaluate("document.getElementById('audio').pause()")
    page.click("#repeat")
    page.click("#repeat")
    expect(page.locator("#repeat")).to_have_attribute("data-mode", "all")
    page.click("#next")
    playing(page, "A one")
    print("  ok    repeat one plays the track again; repeat all goes from the last to the first")

    page.click("#shuffle")
    expect(page.locator("#shuffle")).to_have_attribute("aria-pressed", "true")
    shows("♡ Not liked · Shuffle · Repeat all")
    titles = ["A one"]
    for _ in range(3):
        page.click("#next")
        page.wait_for_function("(before) => document.getElementById('now-playing').textContent !== before", arg=titles[-1])
        titles.append(page.inner_text("#now-playing"))
    assert sorted(titles) == ["A one", "B two", "C three", "D four"], titles
    page.click("#next")
    expect(page.locator("#now-playing")).to_have_text("A one")
    print("  ok    shuffled, next goes through every track once, then round again")

    page.evaluate("document.getElementById('audio').pause()")
    lock(page)
    expect(page.locator("#traffic")).to_be_hidden()
    unlock(page)
    expect(page.locator("#shuffle")).to_have_attribute("aria-pressed", "true")
    expect(page.locator("#repeat")).to_have_attribute("data-mode", "all")
    print("  ok    shuffle and repeat are remembered; the counter shows only while unlocked")

    assert not errors, errors


if __name__ == "__main__":
    sys.exit(harness(run))
