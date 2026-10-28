"""End-to-end: the library sorted into artists and albums, and likes (web SPEC §5.4–§5.6), with the real backend and
Chromium as in test_playback.py.

  a tagged album with an untagged track and a cover → its albums in the preview → artists/ after the upload
  → an untagged package, its album set in the preview → the same bytes again, sorted once → an album set afterwards
  → playing from the artists → likes, newest first, unliking → deleting a package: its copies go, a duplicate comes
  back, a liked track stays in Likes, apart → that track uploaded again: its like takes the new copy, and the
  duplicate check finds nothing stored twice → sorting again (in the settings) changes nothing

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_library.py    # after `make deps`
"""

import sys

from playwright.sync_api import expect

from harness import Backend, choose, create_library, enter, harness, home, new_device, open_package, play_button, upload
from test_playback import tagged, tone


def names(page) -> list[str]:
    """The entries of the folder on screen."""
    return page.eval_on_selector_all("#entries li[data-entry]", "items => items.map((li) => li.dataset.entry)")


def artists(page, *path: str) -> list[str]:
    """From anywhere: home, Artists, and the folders `path` below it; → its entries."""
    home(page)
    page.click("#open-artists")
    expect(page.locator("#breadcrumbs .crumb").last).to_have_text("artists")
    enter(page, *path)
    return names(page)


def set_album(page, albums: str, group: str, artist: str, album: str) -> None:
    """In the albums list `albums` (an id), sets the album `group` ("Artist / Album") to `artist` and `album`."""
    row = page.locator(f"#{albums} li[data-album='{group}']")
    row.locator("button[data-action='edit-album']").click()
    row.locator(".album-artist").fill(artist)
    row.locator(".album-name").fill(album)
    row.locator("button[data-action='save-album']").click()


def albums(page, albums: str) -> list[str]:
    return page.eval_on_selector_all(f"#{albums} li[data-album]", "items => items.map((li) => li.dataset.album)")


def likes(page, section: str = "likes") -> list[str]:
    return page.eval_on_selector_all(f"#{section} li[data-like]", "items => items.map((li) => li.dataset.like)")


def run(browser, backend: Backend, port: int) -> None:
    device = new_device(browser, f"http://localhost:{port}")
    page = device.page
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    create_library(page, backend.setup_token("user", "create", "alice"))
    opening = tagged(tone(5), title="Opening", artist="Band", album="Debut", track="1")

    # --- a tagged album: an untagged track joins it, its cover comes along
    page.click("#add-music")
    choose(page, [("01.wav", opening, "audio/wav"), ("02 Second.wav", tone(5), "audio/wav"), ("cover.jpg", b"\xff\xd8 a cover", "image/jpeg")])
    assert albums(page, "upload-albums") == ["Band / Debut"]
    expect(page.locator("#upload-albums li[data-album='Band / Debut']")).to_contain_text("2 tracks")
    expect(page.locator("li[data-path='02 Second.wav'] .target")).to_have_text("→ Band / Debut / 02 Second.wav")
    page.fill("#package-name", "Debut release")
    page.click("#upload-start")
    page.wait_for_selector("#package-details")
    assert albums(page, "package-albums") == ["Band / Debut"]
    assert artists(page) == ["Band"]
    assert artists(page, "Band", "Debut") == ["01 Opening.wav", "02 Second.wav", "cover.jpg"]
    print("  ok    an upload is sorted into artists/: an untagged track with its album, the cover next to them")

    # --- an untagged package, its album set in the preview
    home(page)
    page.click("#add-music")
    choose(page, [("x.wav", tone(1), "audio/wav")])
    page.fill("#package-name", "Mixtape")
    assert albums(page, "upload-albums") == ["Unknown artist / Mixtape"]
    set_album(page, "upload-albums", "Unknown artist / Mixtape", "DJ Someone", "Tape One")
    assert albums(page, "upload-albums") == ["DJ Someone / Tape One"]
    expect(page.locator("li[data-path='x.wav'] .target")).to_have_text("→ DJ Someone / Tape One / x.wav")
    page.click("#upload-start")
    page.wait_for_selector("#package-details")
    assert artists(page) == ["Band", "DJ Someone"]
    assert artists(page, "DJ Someone", "Tape One") == ["x.wav"]
    print("  ok    an album set in the preview is where its tracks go")

    # --- the same bytes again are sorted once
    home(page)
    page.click("#add-music")
    choose(page, [("again.wav", opening, "audio/wav")])
    page.fill("#package-name", "Again")
    page.click("#upload-start")
    page.wait_for_selector("#package-details")
    assert artists(page, "Band", "Debut") == ["01 Opening.wav", "02 Second.wav", "cover.jpg"]
    print("  ok    the same bytes in another package aren't sorted twice")

    # --- an album set after the upload moves its tracks
    home(page)
    open_package(page, "Mixtape")
    set_album(page, "package-albums", "DJ Someone / Tape One", "DJ Someone", "Tape Two")
    expect(page.locator("#notice")).to_contain_text("Set where the tracks of")
    assert albums(page, "package-albums") == ["DJ Someone / Tape Two"]
    assert artists(page, "DJ Someone") == ["Tape Two"]
    print("  ok    an album set on the package's page moves its tracks, and the old album goes")

    # --- playing from the artists, and likes
    artists(page, "Band", "Debut")
    page.click("#play-all")
    expect(page.locator("#now-playing")).to_have_text("Opening")
    expect(page.locator("#like")).to_have_attribute("aria-pressed", "false")
    page.click("#like")
    expect(page.locator("#like")).to_have_attribute("aria-pressed", "true")
    # The notification says it too, so a like needn't be looked up in the app.
    page.wait_for_function("() => navigator.mediaSession.metadata?.artist === '♥ Liked'")
    page.click("#next")
    expect(page.locator("#now-playing")).to_have_text("02 Second")
    expect(page.locator("#like")).to_have_attribute("aria-pressed", "false")
    page.click("#like")
    expect(page.locator("#like")).to_have_attribute("aria-pressed", "true")
    page.evaluate("document.getElementById('audio').pause()")
    home(page)
    page.click("#open-likes")
    page.wait_for_selector("#likes-screen")
    assert likes(page) == ["02 Second.wav", "Band - Opening.wav"], likes(page)
    page.locator("#likes li[data-like='Band - Opening.wav'] button[data-action='unlike']").click()
    expect(page.locator("#likes li[data-like]")).to_have_count(1)
    expect(page.locator("#like")).to_have_attribute("aria-pressed", "true")
    print("  ok    likes: ♡ in the player, newest first, unliking")

    # --- only the liked ones of an album, or of an artist: Play likes, where there are any
    assert artists(page, "Band", "Debut") == ["01 Opening.wav", "02 Second.wav", "cover.jpg"]
    page.click("#play-liked")
    expect(page.locator("#now-playing")).to_have_text("02 Second")
    page.click("#next")
    page.wait_for_timeout(300)
    expect(page.locator("#now-playing")).to_have_text("02 Second")  # the only liked one: nothing after it
    page.evaluate("document.getElementById('audio').pause()")
    artists(page, "Band")
    expect(page.locator("#play-liked")).to_be_visible()
    artists(page, "DJ Someone")
    expect(page.locator("#play-all")).to_be_visible()
    expect(page.locator("#play-liked")).to_have_count(0)
    print("  ok    Play likes plays an album's or an artist's liked tracks alone, offered only where some are")

    # --- disliking: on to the next at once, gone past by next, previous and Play all, listed apart, and undone there
    artists(page, "Band", "Debut")
    page.click("#play-all")
    expect(page.locator("#now-playing")).to_have_text("Opening")
    page.click("#dislike")
    expect(page.locator("#now-playing")).to_have_text("02 Second")
    expect(page.locator("#dislike")).to_have_attribute("aria-pressed", "false")
    page.click("#previous")
    page.wait_for_timeout(300)
    expect(page.locator("#now-playing")).to_have_text("02 Second")  # not back to the disliked one
    page.evaluate("document.getElementById('audio').pause()")
    page.click("#play-all")
    expect(page.locator("#now-playing")).to_have_text("02 Second")
    page.evaluate("document.getElementById('audio').pause()")
    play_button(page, "01 Opening.wav").click()  # on purpose: it plays
    expect(page.locator("#now-playing")).to_have_text("Opening")
    expect(page.locator("#dislike")).to_have_attribute("aria-pressed", "true")
    page.wait_for_function("() => navigator.mediaSession.metadata?.artist === '👎 Disliked'")
    page.evaluate("document.getElementById('audio').pause()")
    home(page)
    page.click("#open-dislikes")
    page.wait_for_selector("#dislikes-screen")
    expect(page.locator("#dislikes li[data-dislike]")).to_have_count(1)
    expect(page.locator("#dislikes li[data-dislike]")).to_contain_text("Opening")
    page.locator("#dislikes button[data-action='undislike']").click()
    expect(page.locator("#dislikes li[data-dislike]")).to_have_count(0)
    # Back to what played before, for the delete below.
    artists(page, "Band", "Debut")
    play_button(page, "02 Second.wav").click()
    expect(page.locator("#now-playing")).to_have_text("02 Second")
    page.evaluate("document.getElementById('audio').pause()")
    print("  ok    a dislike goes on to the next track, is gone past by every list, plays on purpose, and is undone in Dislikes")

    # --- deleting a package: its copies go, a duplicate comes back, its liked track stays in Likes
    home(page)
    open_package(page, "Debut release")
    page.click("#delete-package")  # the harness accepts the confirmation
    expect(page.locator("#notice")).to_contain_text("One of its tracks is liked: it stays in Likes.")
    expect(page.locator("#player")).to_be_hidden()
    assert artists(page, "Band", "Debut") == ["01 Opening.wav"]
    home(page)
    page.click("#open-likes")
    page.wait_for_selector("#likes-screen")
    assert likes(page, "likes-lost") == ["02 Second.wav"]
    page.locator("#likes-lost li[data-like='02 Second.wav'] button[data-action='play']").click()
    page.wait_for_function("() => document.getElementById('audio').currentTime > 0.1", timeout=20_000)
    page.evaluate("document.getElementById('audio').pause()")
    print("  ok    a deleted package's copies go and a duplicate takes its place; its liked track stays, apart, and plays")

    # --- the liked track uploaded again: its like takes the new copy, so nothing is stored twice
    home(page)
    upload(page, [("02 Second.wav", tone(5), "audio/wav")], name="Again")
    home(page)
    page.click("#open-likes")
    page.wait_for_selector("#likes-screen")
    assert likes(page) == ["02 Second.wav"], likes(page)
    expect(page.locator("#likes-lost")).to_have_count(0)
    page.click("#settings")
    page.click("#check-duplicates")
    expect(page.locator("#duplicates-none")).to_have_text("No file is stored twice.")
    page.click("#done")
    page.click("#back")
    print("  ok    a liked track uploaded again takes its like back, on the new copy: nothing is stored twice")

    # --- sorting again changes nothing
    home(page)
    page.click("#settings")
    page.click("#resort")
    expect(page.locator("#notice")).to_contain_text("Sorted every package's tracks")
    page.click("#back")
    # "Again", the liked track uploaded alone and untagged, is by an unknown artist.
    assert artists(page) == ["Band", "DJ Someone", "Unknown artist"], artists(page)
    assert artists(page, "Band", "Debut") == ["01 Opening.wav"]
    print("  ok    sorting again from the uploads gives the same artists")

    assert not errors, errors


if __name__ == "__main__":
    sys.exit(harness(run))
