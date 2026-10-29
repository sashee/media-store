# media-store

A web-based media library with end-to-end encryption: music for now, video later.

- [e2ee-store](https://github.com/sashee/e2ee-store) is everything that isn't specific to this app: the Rust
  backend (passkey users and git-like per-user storage), the browser SDK (keys, encryption, saving, recovery,
  cleanup, range reads), and the NixOS module. It is pinned in `nix/e2ee-store.nix`.
- `web/` is the library, written in plain JavaScript and run entirely in the browser, on the SDK. The page decrypts
  tracks in ranges and a Service Worker hands them to the player, keeping the encrypted bytes around the playing track
  in memory. See `web/SPEC.md`.

## Development

Everything is built with Nix, no flake: nixpkgs from `nix/pkgs.nix` (the `nixos-26.05` branch, used only for this
repository's own builds; hosts build with their own), and e2ee-store pinned in `nix/e2ee-store.nix`:

```sh
make check               # both packages and every check in the Nix sandbox (what CI runs)
make package             # result/ = the backend, result-2/ = the frontend's static files
```

`nix-build nix -A checks.<name>` runs one check: `web-unit`, `e2e-playback`, `e2e-upload`, `e2e-library`, `vm`, and e2ee-store's
`e2ee-store-sdk-unit`, `e2ee-store-browser` and `e2ee-store-vm-s3`, which this repository reruns with its own nixpkgs.
Building the backend runs e2ee-store's Rust suite.

For development, the Makefile enters the dev shell (`shell.nix`) by itself. Nix builds the backend and
the SDK into `data/` (`make deps`, which every target below runs), and `web/public/sdk` links to the SDK:

```sh
make test                # frontend unit tests
make e2e                 # the browser tests
make run                 # backend on ./data/backend.sock, reachable at http://localhost:8081 via socat
make user NAME=alice     # create a user; open http://localhost:8081/#setup=<token>
make setup-token NAME=alice   # a new setup link for an existing user (e.g. another device)
```

Local settings are in `config.toml` (backend SPEC §10); it allows uploads of up to 256 MiB, and sessions of 24 hours.

To work on e2ee-store at the same time, use a checkout of it instead of the pinned builds: `make -C ../e2ee-store
build`, then e.g. `make run BACKEND=../e2ee-store/backend/target/debug/backend SDK=../e2ee-store/sdk/src`.

To use the phone through the Android app (sashee/iroh-webview-app), run `make iroh` next to `make run`. It
exposes `./data/backend.sock` over iroh with a persistent identity (`./data/iroh-secret`) and prints the ticket
to paste into the app. The app has no address bar, so paste the setup token on the app's start screen.

## Deployment

`nix/module.nix` is a plain NixOS module (no flake), with the backend from the e2ee-store version it pins. The
packages are built with the host's own nixpkgs:

```nix
imports = [ "${media-store}/nix/module.nix" ];
services.media-store.enable = true;
services.media-store.settings.public_hosts = [ "media.example.com" ];   # optional; backend SPEC §10
```

The backend listens on `/run/media-store/backend.sock`. Only members of the `media-store` group can connect, so
whatever exposes it (`iroh-uds-listen`, a reverse proxy) joins that group. The data is in `/var/lib/media-store`.
Uploads may be up to 256 MiB (`max_blob_size`), and a session lasts 24 hours (`session_ttl`), so music doesn't stop
for a new unlock every 4 hours, the backend's default. Tracks are offloadable, so a storage backend
(`services.media-store.storageBackends`, with `settings.blob_target`) can keep them outside the database, or keep
copies in several places.
Run admin commands as root through the wrapper, which switches to the service user: `sudo media-store user create
alice`.

A host repository runs every check, with its own nixpkgs and its machine for the VM tests:
`import "${media-store}/nix/tests" { inherit pkgs; machineModules = [ <host config> ]; }` gives one derivation per
check: media-store's (`vm`, `web-unit`, `e2e-playback`, `e2e-upload`, `e2e-library`) and the e2ee-store ones it reruns
(`e2ee-store-*`).

## Status

Done:
- the account: setup link, passkey with PRF, recovery key, unlock, lock, a second device, settings (passkeys, add
  device, recovery key, cleanup), from pw-mgr
- uploading packages: files, a folder (in desktop browsers), or files fitted to a .torrent by their hashes, kept
  together under `uploads/<package>/` with a `package.json`; a torrent's package can be completed later
- tags read in the browser (MP3, FLAC, Ogg, MP4, WAV), and a preview of where each track will be sorted
  (artist / album / name), with its albums to correct
- sorting into `artists/<artist>/<album>/`: copies of the tracks (the same blobs), brought in line with the packages
  whenever one changes, the same bytes once, with the album's cover; the artist and album can be set per album of a
  package, at the upload or later
- likes (♥ in the player) in `lists/likes/`, newest first; likes whose package was deleted stay, shown apart
- a browser of the library: packages, folders and files, with their sort targets; playing a file, a folder or a
  package; downloading any file, decrypted, the torrent included; deleting a package
- playing through the Service Worker, with seeking, without downloading a track whole first
- next and previous through what is playing, moving on when a track ends, and the system's media controls through the
  Media Session API (desktop Chrome shows them)
- a cache of the encrypted bytes around the playing track, in the Service Worker's memory: seeking and going back
  don't wait for the network, and the next track's start is fetched ahead
- shuffle and repeat (off, all, one) in the player, shown in the notification's second line
- a counter of the bytes per second fetched from the server

In the Android app (sashee/iroh-webview-app), playing goes on in the background, with a notification and lock-screen
controls, through its Media Session bridge; downloads land in Downloads through its download bridge.

Not yet (`web/SPEC.md` §10): lists of one's own, covers in the player, picking folders on Android, video.
