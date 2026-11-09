"""End-to-end: every track at the same loudness (web SPEC §5.9), with the real backend and Chromium as in
test_playback.py.

  tones at three levels uploaded → each measured as it is uploaded, and played turned down to the target, a quiet one
  as it is → one that couldn't be measured plays at the usual level → Measure loudness in the settings measures it,
  downloading it → measuring again finds nothing left

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_loudness.py    # after `make deps`
"""

import sys

from playwright.sync_api import expect

from harness import Backend, create_library, harness, home, new_device, open_package, play_button, upload
from test_playback import tone

# Peaks of 0.8, 0.4, 0.2 and 0.02 of full scale: -2, -8, -14 and -34 dBFS; each 6 dB apart but the last.
LOUD, HALF, QUARTER, QUIET = 26214, 13107, 6554, 655


def volume_of(page, package: str, name: str) -> float:
    """From home: plays `name` of `package`; → the volume the player set for it."""
    home(page)
    open_package(page, package, "files")
    play_button(page, name).click()
    expect(page.locator("#now-playing")).to_have_text(name.removesuffix(".wav"))
    page.wait_for_function("() => document.getElementById('audio').currentTime > 0", timeout=20_000)
    volume = page.evaluate("document.getElementById('audio').volume")
    page.evaluate("document.getElementById('audio').pause()")
    return volume


def run(browser, backend: Backend, port: int) -> None:
    device = new_device(browser, f"http://localhost:{port}")
    page = device.page
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    create_library(page, backend.setup_token("user", "create", "alice"))

    # --- measured as they are uploaded: turned down to the target, by their loudness; a quiet one isn't turned up
    upload(page, [("loud.wav", tone(3, amplitude=LOUD), "audio/wav"), ("half.wav", tone(3, amplitude=HALF), "audio/wav"), ("quiet.wav", tone(3, amplitude=QUIET), "audio/wav")], name="Levels")
    loud = volume_of(page, "Levels", "loud.wav")
    half = volume_of(page, "Levels", "half.wav")
    quiet = volume_of(page, "Levels", "quiet.wav")
    # A 440 Hz sine at -2 dBFS from both speakers is some -2.5 LUFS: 15.5 dB over -18.
    assert 0.14 < loud < 0.2, loud
    assert abs(half / loud - 2) < 0.05, (loud, half)
    assert quiet == 1, quiet
    print("  ok    tracks are measured as they're uploaded, and played turned down to the same loudness; a quiet one as it is")

    # --- one that couldn't be measured plays at the usual level: the median of those measured
    page.evaluate("() => { window.webAudio = window.OfflineAudioContext; window.OfflineAudioContext = class { constructor() { throw new Error('no Web Audio'); } }; }")
    home(page)
    upload(page, [("later.wav", tone(3, amplitude=QUARTER), "audio/wav")], name="Later")
    page.evaluate("() => { window.OfflineAudioContext = window.webAudio; }")
    usual = volume_of(page, "Later", "later.wav")
    assert abs(usual - half) < 0.001, (usual, half)
    print("  ok    a track that couldn't be measured plays at the usual level")

    # --- Measure loudness in the settings measures what isn't yet, downloading it; then there's nothing left
    home(page)
    page.click("#settings")
    page.click("#measure-loudness")  # the harness accepts the confirmation
    page.wait_for_selector("#loudness-report")
    expect(page.locator("#loudness-measured")).to_have_text("1")
    expect(page.locator("#loudness-failed")).to_have_text("0")
    page.click("#done")
    page.click("#back")
    later = volume_of(page, "Later", "later.wav")
    assert abs(later / loud - 4) < 0.1, (loud, later)
    home(page)
    page.click("#settings")
    page.click("#measure-loudness")
    expect(page.locator("#notice")).to_contain_text("The loudness of every track is measured.")
    print("  ok    Measure loudness measures the tracks that aren't yet, and then finds none left")

    assert not errors, errors


if __name__ == "__main__":
    sys.exit(harness(run))
