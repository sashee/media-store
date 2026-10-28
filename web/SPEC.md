# Media Library Specification

Status: **Draft v0.3** (2026-10-25)

## 1. Purpose & scope

A web-based media library with end-to-end encryption: music now, video later. It runs entirely in the browser and is built on [e2ee-store](https://github.com/sashee/e2ee-store) (pinned in `nix/e2ee-store.nix`):

- its backend (`backend/SPEC.md` there, "backend SPEC") stores the data as opaque blobs and refs;
- its SDK (`sdk/SPEC.md` there, "SDK SPEC") encrypts it end to end and handles passkeys, keys, saving, recovery and cleanup.

This document covers what the library adds. Everything in it is implemented in the frontend.

Scope for v0.3:

- One library per user, unlocked with a passkey through the WebAuthn PRF extension, with a recovery key for new devices and recovery. The account screens are pw-mgr's.
- Uploading packages: files, a folder (not in Android's WebView yet), or files fitted to a torrent, stored together with what they are, and a preview of where each track will be sorted, from its tags.
- Sorting into artists and albums, kept in line with the packages, with the artist and album of a package's album settable at the upload and later.
- Likes, newest first, which outlive the package they came from.
- Browsing the library, and playing a file, a folder, an album, an artist, a package or the likes.
- Playing a track, with seeking, without downloading it whole first.
- Playing on: next and previous through the library, the next track when one ends, shuffle and repeat, and the system's media controls through the Media Session API.
- A counter of the bytes per second fetched from the server, for information.
- Deleting a package; cleanup removes what nothing reaches any more.

Not yet (§10): lists of one's own, video, offline use.

## 2. Key decisions

| #  | Topic        | Decision |
|----|--------------|----------|
| M1 | SDK          | Keys, encryption, the tree and the account flows are e2ee-store's SDK, with the namespace `media-store` (§4). This app adds the library's layout, playback and the UI. |
| M2 | Packages     | What is uploaded together stays together, as uploaded, with what it is next to it (§5.1). Files are offloadable (SDK SPEC §6.13), so a server with a storage backend can keep them outside its database. |
| M3 | Formats      | Only what the browser plays natively is played, checked with `canPlayType`; other files are kept in their package. Nothing is transcoded. |
| M8 | Torrents     | A .torrent shapes a package: picked files are fitted to it by their sizes and hashes (§5.2), so its folders and names survive a phone's picker, which picks files, not folders. Nothing is downloaded or contacted. |
| M9 | Sorting      | Where a track belongs (artist, album, name) is a pure function of its tags, its place in the package and what the user set (§5.4). `artists/` follows from `uploads/` alone (§5.5): copies of the entries, so the same blobs, rebuilt by diffing whenever a package changes. |
| M10 | Likes       | A like is a copy of the track's entry in `lists/likes/`, its `modified` the time of the like (§5.6). It keeps the blob alive, so a like outlives its package; the app shows such likes apart instead of removing them. |
| M4 | Playback     | A Service Worker answers the `<audio>` element's requests, `Range` included, with the track decrypted in ranges by the page (§6). No `blob:` URL, so nothing waits for the whole file and nothing whole sits in memory. |
| M5 | Keys         | The worker never has a key. It passes each play request to the page that made it, which decrypts and answers; a locked page answers 403. |
| M6 | Locking      | As pw-mgr: Lock logs out and reloads. Inactivity locks after 15 minutes without input, but not while a track plays. |
| M7 | Tech stack   | Plain JavaScript (ES modules), HTML and CSS. No runtime dependencies and no build step. |

## 3. Architecture

- **Serving:** the backend serves the web package from its `static_dir`, so the app, the worker and the API share one origin. The package is `web/public/` plus the SDK at `sdk/`; in development, `web/public/sdk` links to it (`make deps`).
- **Origins:** on the iroh path that's `http://localhost:PORT` or `http://<label>.localhost:PORT`; on the direct path it's `https://<public host>`. Both are secure contexts, which Service Workers need.
- **Routing:** no URL routes; screen state lives in memory. The fragment is only for setup links (SDK SPEC §6.2). `/play/…` URLs are the worker's (§6).
- **Pure core:** the modules that decide (library, packages, torrents, tags, sorting, the upload plan, the queue) are plain functions of data, used by the page, the worker and the unit tests. Network, WebAuthn, the DOM and the worker stay in the edge modules.

```
web/
  SPEC.md
  package.nix             the web package: public/ plus the SDK at sdk/
  public/                 served as static_dir
    index.html            the page, with the player outside the screens
    style.css
    sw.js                 the Service Worker: plays tracks (§6)
    sdk/                  development link to e2ee-store's SDK (not in git)
    js/
      main.js             startup, the screen state machine, the player
      labels.js           the namespace (§4), apart so the worker imports it without the flows
      flows.js            the SDK's flows, configured with it
      library.js          names, types, tracks for the player, play URLs (pure)
      packages.js         packages: their names, package.json, saving and deleting one, their files (§5.1)
      bencode.js          reading bencoded data, the .torrent format (pure)
      torrent.js          reading torrents, and fitting files to them (§5.2)
      tags.js             tags inside audio files (§5.3)
      sorting.js          where a track is sorted, and the artists/ tree that follows (§5.4, §5.5, pure)
      artists.js          the save step that brings artists/ in line with uploads/ (§5.5)
      likes.js            likes: their names and order, liking and unliking (§5.6)
      upload-plan.js      what an upload would store, for the preview (§5.1–§5.4)
      player.js           the page's side of the worker: registering it, answering play requests
      blob-cache.js       the worker's cache of encrypted blob bytes (§6.3)
      ranges.js           Range requests answered from range reads (pure but for Response)
      queue.js            what plays next and previous, shuffled or not, and what repeats (pure)
      traffic.js          the traffic counter's rate (pure)
      media-session.js    the player in the Media Session: state out, the system's buttons in
      ui/                 screens and components: library-screens.js has home, adding music, the browser and likes
  test/
    unit/                 node --test
    e2e/                  Playwright with Chromium, on e2ee-store's harness
```

## 4. Cryptography

All of it is the SDK's (SDK SPEC §2–§3), with the namespace `media-store`. The namespace can never change: every key and blob of a library is bound to it, and a unit test pins it.

## 5. The library

The tree (SDK SPEC §5):

```
/uploads/<package>/files/…           the files of an upload, at their paths in it
/uploads/<package>/package.json      what the package is
/uploads/<package>/package.torrent   the torrent that shaped it, if one did
/artists/<artist>/<album>/…          copies of the tracks, sorted (§5.5)
/lists/likes/…                       copies of the liked tracks (§5.6)
/lists/dislikes.json                 the disliked tracks (§5.8)
```

`uploads/` is the source of truth. `artists/` follows from it alone, and `lists/likes/` from what the user liked. Copies are entries of the same blobs, so they cost no storage, and a save that writes many of them lands at once.

### 5.1 Packages

- **What a package is:** everything picked in one go, from three sources:
  - files picked one by one, flat in `files/`;
  - a folder, at its paths below it: the folder names the package;
  - files fitted to a torrent (§5.2), at the torrent's paths below its folder.
- **Everything is kept:** a package holds every file picked, audio or not (covers, booklets, `.cue`, `.log`, playlists), or, with a torrent, every file the torrent lists that was picked. Only tracks this browser plays are played. A track is an audio file that isn't a playlist: `.m3u`, `.m3u8`, `.pls` and `.xspf`, and the types they come with, such as `audio/x-mpegurl`, are lists of tracks even though their type says audio, and a browser that streams HLS even says it can play them.
- **Names:** cleaned as file names are (NFC, no `/` or control characters, at most 200 bytes of UTF-8); a name twice in one folder becomes `name (2).ext`. The package's own name defaults to its torrent's, else its folder's, else the album most of its files' tags name, else `Upload <date>`, and the user can change it; a name another package has gets ` (2)`.
- **Entries:** each file's entry has `app: { type, tags, sort }`: its MIME type (the browser's, else from its extension), for audio its tags (§5.3), and `sort` when the user set its artist or album (§5.4).
- **package.json:** `{ version: 1, name, uploaded, updated, source ("files", "folder" or "torrent"), torrent ({ name, id, files } or null), files, bytes, missing }`, `missing` being the torrent's paths the package lacks.
- **One save per package** (SDK SPEC §6.4): its files (offloadable), package.json and the torrent (not offloadable). A failed upload is simply retried.
- **Cancelling:** leaving the Add music screen while it uploads (Cancel, or any other screen) aborts the save: nothing of it is saved, and the blobs already uploaded are left for cleanup. A save that went through just before is kept, and the screen the user went to stays. The upload's progress shows as it goes. While it runs, the screen is kept on (Screen Wake Lock, taken again whenever the page shows, as browsers drop it while it's hidden), so it goes on untouched: a phone whose screen goes off sends the page, and the Android app, to the background, which stops it. A notice says whether the browser keeps the screen on, or that the user has to. `max_blob_size` limits each file; the module and `config.toml` set it to 256 MiB. Files are read whole to be uploaded, which is the SDK's way.
- **Deleting** a package removes all of it and its copies in `artists/`, in one save, and stops the player if it was playing one of its tracks other than from the likes. Its liked tracks stay liked (§5.6), and the notice says how many. The blobs nothing reaches any more stay until cleanup (SDK SPEC §6.11).

### 5.2 Torrents

A torrent lists a release's files, their paths, their sizes, and hashes of their bytes. The picked files are fitted to it, whatever they were called:

- **Reading:** bencode (BEP 3), v1 (`files` or `length`, `pieces`), v2 (BEP 52's `file tree` and `pieces root`) and hybrids. Paths are below the torrent's folder; a single-file torrent's one path is its name. Padding files (BEP 47) are left out. The torrent's id is its infohash: v1's if it has one, else v2's.
- **Fitting:** each picked file is a candidate for the torrent's files of its size. Its hashes then decide:
  - v2: the file's own `pieces root`, the merkle root of SHA-256 over its 16 KiB blocks, so every file is checked exactly;
  - v1: hashes are over the files joined together, so a file is checked by the first, middle and last of the pieces wholly inside it; a file without such a piece (a small one) by the pieces it shares with its neighbours, once those are picked too.
- **Results**, each shown in the preview: *checked* (the hashes confirm it), *size* (a small v1 file the hashes can't tell alone: placed by its size, and by its name among files of the same size), *missing* (not picked), *left out* (picked, not in the torrent; not stored). A file of the right size whose hashes disagree is left out. One file can fill several entries when the torrent holds the same bytes twice.
- **Completing:** a torrent whose id a package already has adds the files that package lacks to it, rather than making another package; what it has is shown as *already in the package*.
- **Nothing else:** no download, no tracker, no peer. The torrent is stored with its package, encrypted like everything else, tracker key and all.

### 5.3 Tags

Read in the browser, from only the parts of a file that hold them, with no dependencies: ID3v2.2–2.4 (with ID3v1 as a fallback) for MP3, the Vorbis comment of FLAC, the comment packets of Ogg Vorbis and Opus, MP4's `moov/udta/meta/ilst`, and RIFF `LIST/INFO` for WAV. What is kept: title, artist, album artist, album, track and disc numbers with their totals, and the year. Text is cleaned (control characters, at most 300 characters). Anything malformed yields no tags, never an error, and no tag block is read past 16 MiB.

### 5.4 Where a track is sorted

`artists/<artist>/<album>/<name>`, from the track's tags, its path in the package, the package's name and what the user set (`js/sorting.js`):

- **artist:** what the user set, else the album artist, else the artist, else the folder above the album's folder, else "Unknown artist";
- **album:** what the user set, else the album, else the folder the file is in (a disc folder such as `CD2` doesn't count), else the package's name;
- **name:** `<track> <title><extension>`, the track number two digits wide, with `<disc>-` first on a multi-disc album (a disc total over 1, a disc over 1, or a disc folder). The title is the tag's, else the file name's without a leading number, which becomes the track number if no tag gives one.
- **Untagged tracks in a tagged album:** a track without an artist or album gets the one the tagged tracks in its folder (disc folders aside) all agree on, if they do. Singles of different artists picked together don't agree, so an untagged one among them stays unknown.
- A `/` in a tag becomes `∕`, which reads the same (AC∕DC); names are cleaned as in §5.1.
- **Setting the artist and album:** the preview, and a package's page, list the albums its tracks go to, each with its track count and Edit: artist and album, as typed. Each track of that album keeps a `sort` in its entry's `app` only for what differs from what its tags and folders say, so an emptied field, or one set back, goes back to them. In the preview it is part of the upload; on a package's page, one save sets it and re-sorts. It changes nothing but the sorting.

### 5.5 Artists

`artists/` is a function of `uploads/` (`sortLibrary`): every package's tracks at their targets (§5.4), as copies of their entries with their `app`, so playing one from there is playing the same blob.

- **Order:** packages by name, their files by path. What comes first keeps its name; a different track with the same name in the same album gets ` (2)`.
- **The same bytes once:** tracks with the same SHA-256 (the entries' plaintext hash) are sorted once, from the first package. When that package goes, the next copy takes its place.
- **Covers:** an album gets the picture named `cover`, `folder`, `front`, `albumart` or `album` (JPEG, PNG, WebP or GIF), in that order of preference, nearest to its first track: in the track's folder or one above it, within its package. It is copied as `cover.<ext>`.
- **Kept in line:** a save step (`sortArtists`) lists `uploads/` and `artists/`, works out the tree that should be, and writes only the difference (`treeChanges`): folders nothing belongs in any more are removed whole, and files already as they should be aren't written again, so a save changes only the directories it must. It runs in the save that deletes a package or sets an album, and in its own save right after an upload: the upload's entries get their SHA-256s only when they are stored, and duplicates are found by them. If that second save fails, the package is saved unsorted, the page says so, and **Sort again** in the settings (the same step) catches up. Anything in `artists/` that doesn't follow from `uploads/` is removed.
- **Cost:** the step reads every directory under `uploads/` and `artists/`. The SDK keeps directories it has read in memory (they never change), so after the first time in a session that's mostly the changed ones. Writes on a tx are worked out every 200, as a long chain of them would overflow the stack.

### 5.6 Likes

- **A like** is a copy of the track's entry in `lists/likes/`, named `<artist> - <title><extension>` (or the title alone, ` (2)` for a name taken), its `modified` the time of the like. Likes are listed by it, the newest first.
- **What is liked** is the bytes, by SHA-256: the same track in its package, in `artists/` or in another package is liked once, and the player's ♥ shows it whichever it plays from. Liking it again does nothing; unliking removes every like of those bytes.
- **Outliving the package:** a like keeps its blob reachable, so deleting the package leaves it playing. It isn't removed: Likes lists the likes whose bytes no package has under **Not in any package**, and unliking one there lets cleanup delete its blob.
- **Following the bytes** (`repointLikes`): a like whose own blob no package has any more, but whose bytes a package has, takes that package's blob (the first by package name and path, as sorting picks), keeping its name and when it was liked. So a package uploaded again after it was deleted takes its likes back without storing their tracks twice, and a like of a deleted package's track moves to another package with the same bytes; the old blob, reached by nothing then, goes at the next cleanup. It runs in the save that sorts the artists (after an upload, a delete, and Sort again), which reads every package anyway, so it costs one more directory, `lists/likes/`, and a write only when a like moves.

### 5.7 Duplicates

The same bytes, by the SHA-256 their entries record, in more than one blob are stored twice. Copies of an entry (in `artists/` and the likes) share its blob and aren't duplicates; the same track uploaded in two packages is, and so is a like left on an old blob. **Check for duplicates** in the settings walks the whole tree and lists each set of bytes stored more than once, with the blobs holding them, the paths reaching each, and what they cost beyond one copy (`js/duplicates.js`). It only reports: deciding which copy goes is the user's.

### 5.8 Dislikes

- **A dislike** is of the bytes, by SHA-256, like a like: the same track in any package, in `artists/` or uploaded again is disliked once. 👎 in the player dislikes what plays and goes on to the next track at once (or stops, with none after it); pressed again, it takes the dislike back.
- **What it does:** no list plays a disliked track. Next and previous go past it, Play all and Play likes start after it, and the next track's prefetch skips it (§6.1, §6.3). Started on purpose, a tap on it, it still plays, and next moves on from it.
- **Liked or disliked:** a track is one or the other. Disliking takes back its like, and liking takes back its dislike, in the same save.
- **Kept** in `lists/dislikes.json`: `{ version: 1, tracks: [{ sha256, title, artist, disliked }] }`, the newest first, what the Dislikes screen shows. Unlike a like, a dislike is no copy of the track's entry, so it keeps nothing stored: a disliked track whose package goes is gone. It is read after the unlock and again after every change.

## 6. Playback

`sw.js` is a module Service Worker at the root scope. It handles two kinds of `GET` on this origin: play URLs, `/play/<blob id>?salt=…&size=…&type=…`, and ranged reads of blobs, `/api/v1/blobs/<id>` with `Range` (§6.3). Every other request goes to the network as usual.

- **Play URLs** (`library.js`) carry what is needed from the track's entry: the blob ID, its salt, the plaintext size and the type.
- **Answered by the page:** the worker passes each play request, its URL and its `Range`, to the page that made it (`FetchEvent.clientId`) over a `MessageChannel`, and waits up to 10 s. The page answers with the status, the headers and the body as a stream, which moves to the worker (a transferable stream), and the worker responds with them. The page checks the URL's shape (anything else is a 404) and answers 403 while locked. The decrypting happens in the page, so the key never leaves it.
- **Ranges:** `rangeResponse` (`js/ranges.js`) answers from the SDK's `read` (SDK SPEC §6.12), pinned to the entry's salt: 206 for one range, 200 without one, 416 past the end, each with `Accept-Ranges: bytes` and `Cache-Control: no-store`. Only the chunks a range touches are read and decrypted; cancelling the request cancels the read.
- **Errors:** a read that fails is answered with its HTTP status (e.g. 410 for a lost file, 503 for unreachable storage) or 500, and the page shows the SDK's message, also for a read that fails after the bytes started. The `<audio>` element itself only learns that it can't play. A request the player cancels (a seek, a pause, another track) is no failure: a read still under way then has nowhere to go, and its bytes are dropped (`reportingErrors` in `player.js`).
- **Control:** a play URL is only used once the worker controls the page; otherwise the request would reach the server, which has no such route. The worker takes over at once (`skipWaiting`, `clients.claim`); a page loaded without it, e.g. by a hard reload, asks it to claim.
- **The player** is an `<audio>` outside the screens, so playback goes on in the settings, with Previous and Next buttons beside it.

### 6.1 The queue

- **What plays next** is the tracks of what playing was started from, in the browser's order (by name): a folder's (an album's) when a file in it is played, or everything below a folder (an artist, a package) with Play all; the liked ones of those, in the same order, with Play likes (an artist's, an album's); or the likes, the newest first. Disliked tracks are gone past, except the one playing when it was started on purpose (§5.8). Or shuffled.
- **Shuffle** makes a random order of the library when it is turned on (or first needed), starting with the track that plays; turning it off and on makes a new one. The order is the only thing stored, as names: tracks deleted since are left out, and tracks added since come at its end.
- **Repeat** is off, all or one, in that order on its button. All goes from the last track to the first, and previous from the first to the last. One plays the track again when it ends; next and previous still move, as with all.
- **Next** plays the track after the current one; after the last, nothing happens unless repeating. A track that ends moves on the same way, so without repeat, playback stops after the last track.
- **Previous** plays the current track from the start once it has played longer than 3 s, or when it is the first and nothing repeats; otherwise the track before it.
- Shuffle and repeat are remembered on the device (`localStorage`); they aren't secret.
- Deleting the package of the track that plays stops the player, unless it plays from the likes (§5.1).
- **A track the browser can't decode** (the `<audio>` element's `MEDIA_ERR_SRC_NOT_SUPPORTED` or `MEDIA_ERR_DECODE`) is skipped: the page says which, and the next track plays. A network error isn't skipped. When every track of the queue has failed in a row, playing stops instead of going round.

### 6.2 The Media Session

The player is described to the system with the standard Media Session API, so whatever shows media controls can show it: desktop Chrome itself, and the Android app (sashee/iroh-webview-app), whose bridge relays it to Android's media session: the notification, the lock screen and a headset's buttons, with the app kept running while it plays. Nothing here is specific to either.

- **Out:** the track's title (`MediaMetadata`), the playback state (playing, paused, none when stopped), and the position (`setPositionState`) whenever it changes other than by playing on: on loading, seeking, a rate change, play and pause.
- **Liked, shuffle and repeat** have no place in the Media Session API, so the system's controls have no buttons for them. What they are shows as the metadata's artist, the notification's second line: "♥ Liked", "♡ Not liked" or "👎 Disliked" (once the likes are read, so a like needn't be looked up in the app), then "Shuffle", "Repeat all" or "Repeat one", joined by " · ". Liking or unliking in the page changes it at once. A car or headset display shows it as the artist too.
- **In:** `play` and `pause` act on the `<audio>` element; `previoustrack` and `nexttrack` are §6.1's; `seekto`, `seekbackward` and `seekforward` (10 s unless the system says otherwise) move within the track; `stop` empties the player. An action the browser doesn't know is left out, so its button doesn't show.
- **Without a tap:** an action from the system isn't a tap in the page. Chromium normally lets an element that a tap started play again, and the player reuses one `<audio>` for every track. The Android app can also let an endpoint play without taps.

### 6.3 The cache

The worker keeps the encrypted bytes the page's reads fetch, in memory, so that seeking, going back and the next track's start don't wait for the network (`js/blob-cache.js`). It is not for offline use: it holds the tracks around the one playing, and nothing survives the worker.

- **What goes through it:** the page's ranged reads of blobs, which are the SDK's reads behind play requests. The SDK doesn't know it is there: the cache answers with the same 206 the server would, and the SDK checks every chunk and pins the salt as always. Every other request, ranged or not, goes to the server.
- **Pieces:** a blob is kept as pieces of 256 KiB of its encrypted bytes, partially: what was fetched is there, and every read adds to it. A read takes the pieces it can from the cache, waits for those already on their way, and fetches each missing stretch in one request, rounded out to whole pieces and at most 32 MiB long. A fetch runs to its end even when its read is cancelled, which is what reads the current track ahead: the `<audio>` element asks for the rest of the track. It stops early where another fetch got first, so a seek ahead fetches from its own place and nothing is fetched twice.
- **The next track:** the page fetches the start of the next one in the queue (§6.1) and drops it; the worker keeps it. Twice: 512 KiB when a track starts, so a skip to the next starts at once; and once the track is 30 s or less from its end (at once for a shorter one), a fifth of the next one's file (`aheadBytes`: at least 512 KiB, at most 32 MiB, one fetch of the worker's). A share of the file is about the same share of the track's length whatever its bitrate, some 45 s of a 4-minute track, so a hi-res track gets as long a head start as a CD one, and only a track about to play costs that much. Not when the next track is this one again (repeat one).
- **Another track:** when another track starts, or playing stops, the page tells the worker which blob plays now, and the read-ahead of every other one stops: a track skipped would otherwise go on downloading up to 32 MiB for nothing. What was fetched of it stays, so going back is quick; the next track's start is fetched after the message, so it isn't stopped. A seek doesn't stop anything: the fetch that was reading ahead stops where the new one started. The player's request for the track left behind may still be open then, and fail as its read stops; only a failure of the track playing is said ("Can't play this track"), as the worker's errors reach the page as a plain network error, whatever they were.
- **Limits:** at most 3 blobs, which with the read-ahead are the previous, current and next track, and at most 100 MiB; the least recently used blob, and then piece, goes first.
- **Gone:** when the page locks, it tells the worker to empty the cache. Android or the browser may stop an idle worker, which empties it too; the next read fetches again.
- **What the server sees:** fewer reads, and the next track's start read early.
- **Counted:** every byte the cache fetches from the server is counted, and the worker tells the pages how many about twice a second while there are any. The page counts its own requests too (§7.1).

### 6.4 Picking up where it stopped

When the library opens (an unlock, not a reload while unlocked), the player is as it was left: the track that played, in the queue it played from, at where it stopped, paused. Pressing play goes on from there, and next and previous go through the same queue (`js/resume.js`).

- **What is kept:** the queue's source (a folder's tracks, everything below a folder as Play all plays them, the liked ones of those as Play likes does, or the likes), the track's name in it and its blob, the position, and the track's length. Shuffle and repeat are kept apart, as before (§6.1).
- **When:** as a track starts, on a pause, every 15 s while it plays, when the page goes out of sight (the app to the background, or closed), and just before locking. Stopping (the system's stop, or deleting the package playing) forgets it.
- **Encrypted:** it names folders and tracks, which are the library's, so it is sealed with AES-GCM under a key derived from the master key (HKDF, `media-store resume v1`) and kept in `localStorage` under the library's state ID. The master key is never stored, so the state opens only once the library is unlocked; another library's key, a tampered or an old value opens to nothing.
- **Made again:** the queue is made from its source as the library is now, and the track is found in it by its name, else by its blob. When the source or the track is gone, nothing is put back.
- **Fetched:** only the track's start, for its length and the time to show, until it plays; a position in its last second starts it over.

## 7. User interface

### 7.1 Screens

- **Unlock:** passkey, recovery key, or a pasted setup link or token (for the Android app, which has no address bar).
- **Setup:** setup link → passkey → recovery key, shown once → the library. On an existing library: recovery key → a passkey on this device.
- **Home:** the library (Artists, Likes and Dislikes), then the packages, Add music and Browse everything.
- **Add music:** a torrent (optional), then files, or a folder: with a folder input, or in the Android app, whose WebView takes a folder input for one picking files, with **Pick a folder**, the File System Access picker (`showDirectoryPicker`), which the app answers with the system's folder picker. Either way the files keep their paths below the folder's name. A preview follows: the package's name, the albums its tracks will go to, each with Edit (§5.4), each file with what happens to it (§5.2) and where it will be sorted, and a summary; then Upload, with its progress. A torrent a package already has says it will complete that package.
- **Browser:** breadcrumbs (Home, Library, then the path), a folder's entries, for a package its package.json (when, from what, its torrent, its files, what it misses), Delete package, and its albums with Edit (§5.4). Files show their size and, in a package, where they are sorted; audio this browser plays has Play, and a folder with any below it Play all, above its entries so a long list needn't be scrolled. Every file has Download (§7.4). Artists open here, at `artists/`: an artist's albums, an album's tracks and cover; an artist or an album with a liked track below it has **♥ Play likes** next to Play all, which plays only those (§5.6: liked by their bytes, wherever from).
- **Likes:** the likes, the newest first, each with its artist, when it was liked, Play and Unlike; Play all, above them; and those whose package is gone under Not in any package (§5.6).
- **Dislikes:** the disliked tracks, the newest first, each with its artist, when it was disliked, and Undo (§5.8).
- **Player:** at the bottom of every screen once a track is picked: its title with ♡ (♥ when liked: a tap likes or unlikes it) and 👎 (faint until disliked: a tap dislikes it, and goes on to the next, or takes the dislike back); a seek bar across the whole width, with the time played and the track's length under it; and a row of Shuffle, Previous, Play/Pause, Next and Repeat (🔁, 🔂 for one), the on ones highlighted. The `<audio>` element plays, hidden: these drive it (`ui/player-bar.js`). Dragging the bar only moves it; the track seeks when it is let go. Volume is the system's.
- **Traffic counters** (`js/traffic.js`), updated every second:
  - in the header while unlocked, "↓ 1.2 MB/s": the bytes received from the server in the last 2 s, per second;
  - under the header, "Last minute: ↓ 45.2 MB ↑ 1.2 MB · since the app started: ↓ 320 MB ↑ 8.0 MB": what was received and sent. The amounts since the start are kept in `sessionStorage`, so they last across the reloads that lock, for as long as the app (the browser tab) runs.

  Both count the page's requests, by wrapping `fetch` (a request's body as it is sent, a response's as it arrives), and the worker's reads, which it reports (§6.3).
- **Request counter** (`js/requests.js`): under the header, while the page waits on the server and for 3 s after, "Requests: 4 of 7 answered · 3 waiting, the longest 37 s", with how many failed or were cancelled when any did. It counts the page's API requests, from the first of a burst of work to the last; a pause of 3 s starts a new count. A stalled connection shows as a request waiting longer and longer, even when the browser re-sends it underneath. The line keeps its place while empty, so nothing moves when it shows.
- **Settings:** passkeys (add, set up, delete), add a device, test and replace the recovery key, Sort again (§5.5), cleanup with its report, Check for duplicates (§5.7). As pw-mgr's, without its import and explorer.
- **Warnings:** a rollback (SDK SPEC §6.5) pauses saving until acknowledged; a library from a newer version is read-only.

### 7.2 Messages

Errors show in a banner. The SDK's errors show their own messages, which never come from the server; anything else is "Something went wrong: …".

### 7.3 Locking

Locking logs out and reloads the page, so the keys and the plaintext leave memory. It happens on the Lock button, after 15 minutes without input unless a track is playing or an upload runs, and when the session expires (any 401). A session lasts 24 hours from the unlock, playing or not (`session_ttl`, which the module and `config.toml` set; the backend's own default is 4 hours). The worker holds no key, so locking needs nothing from it.

### 7.4 Downloads

**Download** saves a file to the device as it was uploaded: read whole and decrypted in the page (`js/saving.js`), into a Blob, which the browser keeps out of the page's memory (on disk when it is large), then offered as a download with a link to its `blob:` URL, called by the file's name. The button shows how much is read meanwhile. The Android app's WebView can't save a `blob:` URL itself; the app's download bridge takes the link's click and saves the Blob in Downloads (sashee/iroh-webview-app).

## 8. Security notes

The SDK SPEC's (§8) apply. In addition:

- **Play URLs** contain a blob ID, its salt, the size and the type. They never leave the browser: the worker answers them, and they're only used once it controls the page. The server knows the first two anyway; the type is the one thing it doesn't.
- **The worker** never has a key: it passes play requests to the page and the page's answers back. Its cache (§6.3) holds encrypted bytes, as the server stores them, in memory only, and is emptied on locking.
- **What the server sees:** files are uploaded and read like any blob (SDK SPEC §8), so their padded sizes and when they are played, by ranges. A package's files are uploaded together, and their sizes can identify a release.
- **Torrents** are only read. A private tracker's torrent carries the user's key in its announce URL: it is stored encrypted with its package, and never sent anywhere.
- **Tags and file contents** are parsed in the page, as untrusted input: malformed tags give none.
- **Downloads** (§7.4) are decrypted in the page, like playing, and the plaintext then is on the device: the user asked for it there. The server sees a file read whole, as it would see one played through.
- **What the device keeps** (`localStorage`, in the browser's or the app's private storage): shuffle and repeat; the highest revision seen and the last cleanup's report, under the library's state ID; and what played (§6.4), sealed with a key from the master key, so nothing of the library is on the device in the clear. What shows is only that something was kept, and when.
- **Sorting and likes** write directories only, encrypted like everything else: the server sees that a save wrote some directory blobs, and their padded sizes, not what they list. A copy is an entry of a blob the server already has; it learns nothing from it.

## 9. Testing

- **Unit tests** (`node --test`, `web/test/unit`): the namespace; types, titles, names and free names; tracks from entries, with odd `app` data; walking a folder; play URLs and what isn't one; playlists aren't tracks; bencode, and what isn't; torrents v1, v2, hybrid and single-file, padding, infohashes; fitting files to them: by bytes whatever their names, wrong bytes left out, small files by their neighbours or else by size and name, the same bytes twice, v2's roots; tags in ID3v2.2/2.3/2.4 (encodings, numbers, big pictures skipped), ID3v1, FLAC, Ogg Opus and Vorbis across pages, MP4 with `moov` after the audio, RIFF INFO, and broken ones; sort targets from tags, from folders and file names, discs, slashes, what the user set, and untagged tracks in a tagged folder; albums grouped and set, back to the tags when emptied; the sorted library: copies, the same bytes once, names made unique, covers; the changes between two trees; sorting a stored tree: once, again without changes, after a package is deleted (a hidden duplicate comes back), after an album is set, and 5000 tracks without overflowing the stack; likes: names, newest first, liking once, unliking, likes no package has, only the liked tracks of a list, dislikes read with care, disliked once, the newest first, and taken back, next and previous going past them but not past the one played on purpose, a like moving to a package's copy of its bytes (and one whose blob a package has staying); duplicates: copies of an entry aren't, the same bytes in two blobs are, with their paths and cost; package names, paths, package.json, saving and completing and deleting packages; the upload plan for files, folders, torrents, and a torrent its package already has; the `Range` header's grammar and responses; reading a file whole for a download, its progress, and a read of the wrong size; the queue with repeat and shuffle; the traffic rate, the last minute's amounts and those since the start, and what the metering `fetch` counts up and down; the request counter: a burst's answers, waits, failures and cancellations, a new burst after a pause, and which requests count; a folder from `showDirectoryPicker`, walked with its paths; what played, kept: its source, the track found again by name or blob, where to start, sealed and opened only with its key; the player's times; the cache against a stand-in server.
- **Browser tests**, the real backend behind socat, Chromium with a virtual PRF authenticator:
  - `test_playback.py`: setup link → library → a package of tracks, one tagged → their sort targets → no plaintext in any blob → play, seek, end → the worker's 206, 200, 416 and 404 → locked, the worker answers 403 → unlock, play again → locked and unlocked again: the track back in the player, paused where it stopped, nothing of it readable in `localStorage`, and play goes on from there → the player's controls → the queue: next, the next track when one ends, previous before and after 3 s → the Media Session's title, state and actions as the system calls them, and its second line saying the track isn't liked → the cache: reads of a track already fetched don't reach the server (counted in the backend's log), the next track's start is fetched before it plays, and locking empties it → the counter → repeat one, repeat all, shuffle and the notification's line → shuffle and repeat remembered.
  - `test_upload.py`: files picked one by one (a name twice made unique, the default name, renaming it updates the targets) → a folder (named after it, subfolders kept, a disc folder in the targets) → a torrent: files fitted by their bytes under other names, missing ones noted, an extra left out, the torrent stored → the torrent and a track downloaded, their bytes as picked → the same torrent again completes the package, small files placed by size → nothing in plaintext, the torrent's tracker key included → cancelling an upload in flight saves nothing → a playlist has no Play and no sort target, and a track that can't be decoded is skipped with a message → deleting a package stops the track it was playing, and while its save's uploads are held the request counter shows them waiting → the usage line has counted data both ways.
  - `test_library.py`: a tagged album with an untagged track and a cover: its albums in the preview, then `artists/` after the upload → an untagged package, its album set in the preview → the same bytes in another package sorted once → an album set on a package's page moves its tracks → playing from the artists → likes from the player, newest first, unliking → the notification's line saying ♥ Liked → Play likes on an album plays its liked track alone, offered for an artist with a like and not for one without → 👎 on a track goes on to the next, previous and Play all go past it, a tap plays it and the notification says so, and Dislikes lists it and takes it back → deleting a package: its copies go, the duplicate takes their place, its liked track stays in Likes, apart, and plays → that track uploaded again takes its like back, and Check for duplicates finds nothing stored twice → Sort again changes nothing.
- **VM test** (`nix/tests/lib.nix`): e2ee-store's instance test on the `media-store` instance, and that it serves this app.
- **e2ee-store's checks** an app reruns: its SDK's unit tests, its browser test and its S3 VM test, with this repository's nixpkgs.

## 10. Future work

- Lists of one's own: `lists/<name>/`, as copies of the tracks' entries, ordered by name prefixes.
- Covers in the album view and in the Media Session's artwork (the notification and the lock screen), decrypted by the page; pictures inside tags (ID3 `APIC`, FLAC `PICTURE`) as covers.
- Setting an album's artist and album from the album's own view, not only from its packages.
- Uploading large files without reading them whole into memory.
- Video, with the same worker; full screen in the Android app needs `onShowCustomView` there.
- Sharing the account screens with pw-mgr through e2ee-store, and `ranges.js` too once another app serves files to the browser.
