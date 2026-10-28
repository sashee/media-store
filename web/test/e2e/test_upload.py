"""End-to-end: uploading packages (web SPEC §5, §7.1), with the real backend and Chromium as in test_playback.py.

  files picked one by one → a folder → a torrent, its files fitted to it, downloaded, completed later → deleting a package

Checks the preview (paths, what happens to each file, where it would be sorted), what the package holds afterwards,
its package.json, and that none of it, the torrent included, is stored in plaintext.

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_upload.py    # after `make deps`
"""

import datetime
import hashlib
import os
import re
import sys
import tempfile

from playwright.sync_api import expect

from harness import Backend, choose, create_library, enter, harness, home, new_device, open_package, play_button
from test_playback import tone


def bencode(value) -> bytes:
    if isinstance(value, int):
        return f"i{value}e".encode()
    if isinstance(value, str):
        value = value.encode()
    if isinstance(value, bytes):
        return f"{len(value)}:".encode() + value
    if isinstance(value, list):
        return b"l" + b"".join(bencode(v) for v in value) + b"e"
    return b"d" + b"".join(bencode(k) + bencode(value[k]) for k in sorted(value)) + b"e"


def torrent(name: str, files: list[tuple[list[str], bytes]], piece_length: int = 16384) -> bytes:
    """A v1 torrent of `files` (path below the folder `name`, bytes), from a private tracker."""
    stream = b"".join(data for _, data in files)
    pieces = b"".join(hashlib.sha1(stream[at : at + piece_length]).digest() for at in range(0, len(stream), piece_length))
    info = {"name": name, "piece length": piece_length, "pieces": pieces, "files": [{"length": len(data), "path": path} for path, data in files]}
    return bencode({"announce": "https://tracker.example/announce?passkey=very-secret-key", "info": info})


# Holds the page's blob uploads, as a slow network would, until they are aborted: a cancel then finds one in flight.
HOLD_UPLOADS = """() => {
  window.holdUploads = true;
  window.heldUploads = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    if (!window.holdUploads || init.method !== "PUT" || !String(input).includes("/api/v1/blobs/")) return realFetch(input, init);
    window.heldUploads += 1;
    return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason)));
  };
}"""


# A stand-in for the Screen Wake Lock API, recording what is taken and released.
WAKE_LOCK = """() => {
  window.wakeLocks = [];
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request: async (type) => (window.wakeLocks.push(`${type} taken`), { release: async () => window.wakeLocks.push("released") }) },
  });
}"""


def rows(page) -> list[tuple[str, str]]:
    """The preview: each file's path and what happens to it."""
    return page.eval_on_selector_all("#upload-rows li", "items => items.map((li) => [li.dataset.path, li.dataset.status])")


def run(browser, backend: Backend, port: int) -> None:
    device = new_device(browser, f"http://localhost:{port}")
    page = device.page
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    create_library(page, backend.setup_token("user", "create", "alice"))

    # --- files picked one by one: all of them, flat, a name twice made unique
    page.click("#add-music")
    choose(page, [("song.wav", tone(0.5), "audio/wav"), ("song.wav", tone(0.7), "audio/wav"), ("cover.jpg", b"\xff\xd8 not really a jpeg", "image/jpeg")])
    assert rows(page) == [["song.wav", "new"], ["song (2).wav", "new"], ["cover.jpg", "new"]]
    today = f"Upload {datetime.datetime.now(datetime.timezone.utc).date().isoformat()}"
    expect(page.locator("#package-name")).to_have_value(today)
    expect(page.locator("li[data-path='song.wav'] .target")).to_have_text(f"→ Unknown artist / {today} / song.wav")
    page.fill("#package-name", "Singles")
    expect(page.locator("li[data-path='song.wav'] .target")).to_have_text("→ Unknown artist / Singles / song.wav")
    expect(page.locator("#upload-summary")).to_contain_text("3 files to upload")
    # The screen kept on while it uploads: a stand-in for the browser's wake lock records it.
    page.evaluate(WAKE_LOCK)
    page.click("#upload-start")
    page.wait_for_selector("#package-details")
    assert page.evaluate("window.wakeLocks") == ["screen taken", "released"], page.evaluate("window.wakeLocks")
    expect(page.locator("#package-details")).to_contain_text("files picked one by one")
    expect(page.locator("#package-details")).to_contain_text("Files: 3")
    enter(page, "files")
    expect(page.locator("#entries li")).to_have_count(3)
    print("  ok    files picked one by one: a package of all of them, flat, names made unique; the screen kept on meanwhile")

    # --- a folder: its files below it, its subfolders kept
    with tempfile.TemporaryDirectory() as directory:
        album = os.path.join(directory, "Folder Album")
        os.makedirs(os.path.join(album, "CD2"))
        for path, data in [("01 One.wav", tone(0.5)), (os.path.join("CD2", "01 Two.wav"), tone(0.5)), ("cover.jpg", b"jpeg")]:
            with open(os.path.join(album, path), "wb") as out:
                out.write(data)
        home(page)
        page.click("#add-music")
        choose(page, folder=album)
        assert sorted(rows(page)) == [["01 One.wav", "new"], ["CD2/01 Two.wav", "new"], ["cover.jpg", "new"]]
        expect(page.locator("#package-name")).to_have_value("Folder Album")
        expect(page.locator("li[data-path='CD2/01 Two.wav'] .target")).to_have_text("→ Unknown artist / Folder Album / 2-01 Two.wav")
        expect(page.locator("li[data-path='01 One.wav'] .target")).to_have_text("→ Unknown artist / Folder Album / 01 One.wav")
        # The files are read when they are uploaded: the folder has to be there until then.
        page.click("#upload-start")
        page.wait_for_selector("#package-details")
    expect(page.locator("#package-details")).to_contain_text("a folder")
    enter(page, "files", "CD2")
    expect(page.locator("li[data-entry='01 Two.wav']")).to_be_visible()
    print("  ok    a folder: the package is named after it, and keeps its subfolders")

    # --- a torrent: files fitted to it by their bytes, whatever they were called
    intro, outro, cover, notes = tone(1), tone(1.5), b"c" * 2000, b"tracklist: intro, outro\n"
    release = torrent("Release", [(["CD1", "01 Intro.wav"], intro), (["CD2", "01 Outro.wav"], outro), (["cover.jpg"], cover), (["notes.txt"], notes)])
    home(page)
    page.click("#add-music")
    choose(page, [("x.wav", intro, "audio/wav"), ("y.wav", outro, "audio/wav"), ("junk.wav", tone(0.7), "audio/wav")], torrent=release)
    assert rows(page) == [["CD1/01 Intro.wav", "checked"], ["CD2/01 Outro.wav", "checked"], ["cover.jpg", "missing"], ["notes.txt", "missing"], ["junk.wav", "unused"]]
    expect(page.locator("#package-name")).to_have_value("Release")
    expect(page.locator("li[data-path='CD1/01 Intro.wav']")).to_contain_text("from x.wav")
    expect(page.locator("li[data-path='CD2/01 Outro.wav'] .target")).to_have_text("→ Unknown artist / Release / 2-01 Outro.wav")
    expect(page.locator("#upload-summary")).to_contain_text("2 files to upload")
    expect(page.locator("#upload-summary")).to_contain_text("2 missing · 1 left out")
    page.click("#upload-start")
    page.wait_for_selector("#package-details")
    expect(page.locator("#package-details")).to_contain_text("Release (4 files)")
    expect(page.locator("#package-missing")).to_have_text("cover.jpg, notes.txt")
    expect(page.locator("li[data-entry='package.torrent']")).to_be_visible()
    print("  ok    a torrent: its paths, files checked by their hashes, extras left out, missing ones noted")

    # --- downloading: the files come back decrypted, as they were picked
    for at, name, picked in [([], "package.torrent", release), (["files", "CD1"], "01 Intro.wav", intro)]:
        enter(page, *at)
        with page.expect_download() as saved:
            page.click(f"li[data-entry='{name}'] [data-action='download']")
        assert saved.value.suggested_filename == name
        with open(saved.value.path(), "rb") as file:
            assert file.read() == picked, f"{name} came back changed"
    expect(page.locator("li[data-entry='01 Intro.wav'] [data-action='download']")).to_have_text("Download")
    print("  ok    downloading the torrent and a track gives back their bytes")

    # --- the same torrent again completes its package
    home(page)
    page.click("#add-music")
    choose(page, [("x.wav", intro, "audio/wav"), ("folder.jpg", cover, "image/jpeg"), ("notes.txt", notes, "text/plain")], torrent=release)
    expect(page.locator("#upload-into")).to_contain_text('"Release"')
    assert rows(page) == [["CD1/01 Intro.wav", "present"], ["CD2/01 Outro.wav", "present"], ["cover.jpg", "size"], ["notes.txt", "size"]]
    page.click("#upload-start")
    page.wait_for_selector("#package-details")
    expect(page.locator("#package-missing")).to_have_count(0)
    expect(page.locator("#package-details")).to_contain_text("Files: 4")
    home(page)
    expect(page.locator("#packages li[data-package]")).to_have_count(3)
    open_package(page, "Release", "files")
    expect(page.locator("#entries li")).to_have_count(4)
    print("  ok    the same torrent again adds what its package lacked, nothing twice")

    blobs = backend.blob_contents()
    for secret in [b"very-secret-key", b"tracklist", b"Release", b"RIFF", intro[5000:5032]]:
        assert not any(secret in blob for blob in blobs), f"{secret!r} is stored in plaintext"
    print("  ok    nothing of it is stored in plaintext, the torrent and its tracker key included")

    # --- cancelling an upload: the save stops, and nothing of it is kept
    page.evaluate(HOLD_UPLOADS)
    home(page)
    page.click("#add-music")
    choose(page, [("never.wav", tone(1), "audio/wav")])
    page.click("#upload-start")
    page.wait_for_function("() => window.heldUploads > 0")
    page.locator("#add-music-screen button", has_text="Cancel").click()
    expect(page.locator("#notice")).to_contain_text("The upload was cancelled")
    page.evaluate("window.holdUploads = false")
    expect(page.locator("#packages li[data-package]")).to_have_count(3)
    page.wait_for_timeout(500)
    expect(page.locator("#packages li[data-package]")).to_have_count(3)
    print("  ok    cancelling an upload stops it, and saves nothing")

    # --- a playlist isn't a track, and a track that can't be decoded is skipped
    home(page)
    page.click("#add-music")
    choose(page, [("album.m3u", b"#EXTM3U\nbroken.wav\ngood.wav\n", "audio/x-mpegurl"), ("broken.wav", b"RIFF not really a wave file at all", "audio/wav"), ("good.wav", tone(1), "audio/wav")])
    expect(page.locator("li[data-path='album.m3u'] .target")).to_have_count(0)
    page.fill("#package-name", "Mixed")
    page.click("#upload-start")
    page.wait_for_selector("#package-details")
    enter(page, "files")
    expect(play_button(page, "album.m3u")).to_have_count(0)
    page.click("#play-all")
    expect(page.locator(".banner.error")).to_contain_text('"broken" can\'t be played in this browser, so it was skipped')
    expect(page.locator("#now-playing")).to_have_text("good")
    page.wait_for_function("() => document.getElementById('audio').currentTime > 0.1")
    page.evaluate("document.getElementById('audio').pause()")
    print("  ok    a playlist isn't played; a track that can't be decoded is skipped, saying so")

    # --- deleting a package, while one of its tracks plays
    home(page)
    open_package(page, "Singles", "files")
    play_button(page, "song.wav").click()
    expect(page.locator("#now-playing")).to_have_text("song")
    page.locator("#breadcrumbs .crumb", has_text="Singles").click()
    # Its save's uploads held in the network, as a stalled connection holds them: the counter says they wait.
    held, holding = [], [True]
    page.route("**/api/v1/blobs/*", lambda route: held.append(route) if holding[0] and route.request.method == "PUT" else route.continue_())
    page.click("#delete-package")  # the harness accepts the confirmation
    expect(page.locator("#requests")).to_contain_text(re.compile(r"Requests: \d+ of \d+ answered · \d+ waiting"))
    holding[0] = False
    for route in held:
        route.continue_()
    expect(page.locator("li[data-package='Singles']")).to_have_count(0)
    expect(page.locator("#player")).to_be_hidden()
    expect(page.locator("#notice")).to_contain_text('Deleted the package "Singles"')
    expect(page.locator("#requests")).not_to_contain_text("waiting")
    print("  ok    deleting a package removes it, and stops the track it was playing; the counter shows its requests waiting")

    expect(page.locator("#usage")).to_contain_text(re.compile(r"since start ↓ [1-9][\d.]* [KM]?B ↑ [1-9][\d.]* [KM]?B"))
    print("  ok    the usage line counts what went up and came down")

    assert not errors, errors


if __name__ == "__main__":
    sys.exit(harness(run))
