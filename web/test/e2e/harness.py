"""The media library's browser-test helpers, on top of e2ee-store's harness (e2ee_store_harness, which must be on
PYTHONPATH). Used by the test_*.py scripts next to it."""

import os

import e2ee_store_harness
from e2ee_store_harness import Backend, Device, new_device  # noqa: F401 (used by the tests)
from playwright.sync_api import expect

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
# The app's static files with the SDK inside: web/public (with its sdk link) in development, the package in Nix.
STATIC = os.environ.get("STATIC_DIR", os.path.join(ROOT, "web", "public"))


def harness(run, extra_env: dict | None = None) -> int:
    return e2ee_store_harness.harness(run, STATIC, extra_env)


def create_passkey(page) -> None:
    page.click("#create-passkey")
    # Some authenticators only return PRF output at sign-in: then the app asks for one more prompt.
    page.wait_for_selector("#confirm-passkey, #recovery-key")
    if page.is_visible("#confirm-passkey"):
        page.click("#confirm-passkey")


def create_library(page, token: str) -> str:
    """Opens a setup link on a fresh device, creates the library and returns the recovery key."""
    page.goto(f"/#setup={token}")
    page.wait_for_selector("#create-passkey")
    create_passkey(page)
    recovery_key = page.inner_text("#recovery-key").strip()
    page.check("#saved-recovery-key")
    page.click("#create-library")
    page.wait_for_selector("#add-music")
    return recovery_key


def unlock(page) -> None:
    page.goto("/")
    page.click("#unlock")
    page.wait_for_selector("#add-music")


def lock(page) -> None:
    page.click("#lock")
    page.wait_for_selector("#unlock")


def picks(files: list[tuple[str, bytes, str]]) -> list[dict]:
    """Files for an <input type=file>: (name, bytes, MIME type)."""
    return [{"name": name, "mimeType": mime, "buffer": data} for name, data, mime in files]


def choose(page, files=None, torrent: bytes | None = None, folder: str | None = None) -> None:
    """On the Add music screen: a torrent, then files (or a folder); waits for the preview."""
    if torrent is not None:
        page.set_input_files("#upload-torrent", files=[{"name": "release.torrent", "mimeType": "application/x-bittorrent", "buffer": torrent}])
    if folder is not None:
        page.set_input_files("#upload-folder", folder)
    else:
        page.set_input_files("#upload-files", files=picks(files))
    page.wait_for_selector("#upload-rows")


def upload(page, files=None, torrent: bytes | None = None, folder: str | None = None, name: str | None = None) -> None:
    """From home: Add music, the picks, the package's name, Upload; ends on the package's page."""
    page.click("#add-music")
    choose(page, files, torrent, folder)
    if name is not None:
        page.fill("#package-name", name)
    expect(page.locator("#upload-start")).to_be_enabled()
    page.click("#upload-start")
    page.wait_for_selector("#package-details")


def enter(page, *names: str) -> None:
    """Opens folders from the one on screen, one after another."""
    for name in names:
        page.locator(f"li[data-entry='{name}'] button").click()
        expect(page.locator("#breadcrumbs .crumb").last).to_have_text(name)


def home(page) -> None:
    """Back to the home screen, from the browser; nothing if it is on screen already."""
    if page.locator("#home-screen").count() == 0:
        page.click("#go-home")
    page.wait_for_selector("#home-screen")


def open_package(page, name: str, *below: str) -> None:
    """From home: a package, and the folders below it."""
    page.locator(f"li[data-package='{name}'] button").click()
    page.wait_for_selector("#package-details")
    enter(page, *below)


def play_button(page, name: str):
    return page.locator(f"li[data-entry='{name}'] button[data-action='play']")
