// The library's screens (SPEC §7.1): home, adding music, the browser and likes. Each returns an element; actions are
// passed in, nothing here talks to the server.

import { formatBytes } from "../../sdk/maintenance.js";
import { albumGroups, packageTargets, regroup, shownTarget } from "../sorting.js";
import { fromInput, stored } from "../upload-plan.js";
import { busy, h } from "./dom.js";

const section = (title, ...children) => h("section", { class: "card" }, h("h2", {}, title), ...children);

const actionButton = (label, action, onError, props = {}) => {
  const button = h("button", { type: "button", ...props }, label);
  button.addEventListener("click", () => busy(button, action, onError));
  return button;
};

// ---------------------------------------------------------------- home

export function home({ packages, onOpen, onAdd, onBrowse, onArtists, onLikes, onDislikes, onError }) {
  const open = (id, label, onClick) => h("li", {}, h("button", { type: "button", class: "row-main", id, onclick: () => onClick().catch(onError) }, label));
  return h(
    "div",
    { id: "home-screen" },
    section(
      "Library",
      h("ul", { class: "rows", id: "library" }, open("open-artists", "🎤 Artists", onArtists), open("open-likes", "♥ Likes", onLikes), open("open-dislikes", "👎 Dislikes", onDislikes)),
    ),
    section(
      "Uploads",
      h(
        "ul",
        { class: "rows", id: "packages" },
        packages.length
          ? packages.map((name) => h("li", { "data-package": name }, h("button", { type: "button", class: "row-main", onclick: () => onOpen(name).catch(onError) }, "📦 ", name)))
          : h("li", { class: "muted empty" }, "Nothing uploaded yet"),
      ),
      h("div", { class: "actions" }, h("button", { type: "button", class: "primary", id: "add-music", onclick: onAdd }, "Add music"), h("button", { type: "button", id: "browse", onclick: onBrowse }, "Browse everything")),
    ),
  );
}

// ---------------------------------------------------------------- albums

/**
 * The albums a package's tracks go to (sorting.js's albumGroups), each with Edit: its artist and album, as typed, an
 * empty field going back to what the tags and folders say. `onSave(group, { artist, album })` sets them.
 */
function albums({ id, groups, onSave, onError }) {
  const row = (group) => {
    const li = h("li", { "data-album": `${group.artist} / ${group.album}` });
    const view = () =>
      li.replaceChildren(
        h("span", { class: "row-main" }, h("strong", {}, group.artist), " / ", group.album),
        h("button", { type: "button", "data-action": "edit-album", onclick: edit }, "Edit"),
        h("span", { class: "muted" }, group.tracks === 1 ? "1 track" : `${group.tracks} tracks`),
      );
    const edit = () => {
      const artist = h("input", { class: "album-artist", value: group.artist, maxlength: 200 });
      const album = h("input", { class: "album-name", value: group.album, maxlength: 200 });
      const saveButton = actionButton("Save", () => onSave(group, { artist: artist.value, album: album.value }), onError, { class: "primary", "data-action": "save-album" });
      li.replaceChildren(
        h(
          "form",
          { class: "album-form", onsubmit: (event) => (event.preventDefault(), saveButton.click()) },
          h("label", {}, "Artist", artist),
          h("label", {}, "Album", album),
          h("p", { class: "muted" }, "Leave a field empty for what the tags say."),
          h("div", { class: "actions" }, saveButton, h("button", { type: "button", onclick: view }, "Cancel")),
        ),
      );
      artist.focus();
    };
    view();
    return li;
  };
  return h("ul", { class: "rows albums", id }, groups.length ? groups.map(row) : h("li", { class: "muted empty" }, "No tracks to sort"));
}

// ---------------------------------------------------------------- adding music

const STATUS = {
  new: "to upload",
  checked: "to upload · matches the torrent",
  size: "to upload · matches the torrent's size, its hash can't be checked alone",
  present: "already in the package",
  missing: "missing",
  unused: "not in the torrent: left out",
};

/**
 * Adding music: a torrent (optional), files or a folder, then a preview of what will be stored and where it would be
 * sorted, with the albums to correct. `prepare({ torrent, files })` makes the plan (upload-plan.js), `files` as
 * [{ file, path }]; `onUpload(plan, name, onProgress)` stores it, with the albums as set. A folder is picked with a
 * folder input where `folderInput` says it picks folders, or else with `pickFolder()` → [{ file, path }], if given.
 */
export function addMusic({ folderInput: folderPicks, pickFolder, prepare, onUpload, onCancel, onHome, onError }) {
  // What is picked, while this screen is open: the newest pick of files or a folder wins.
  let picks = { torrent: null, files: [] };
  let plan = null;
  const status = h("p", { class: "muted", id: "upload-status", role: "status" });
  const preview = h("div", { id: "upload-preview" });
  const torrentInput = h("input", { type: "file", id: "upload-torrent", accept: ".torrent,application/x-bittorrent" });
  const filesInput = h("input", { type: "file", id: "upload-files", multiple: true });
  const folderInput = h("input", { type: "file", id: "upload-folder", webkitdirectory: true });

  const replan = async () => {
    plan = null;
    preview.replaceChildren();
    if (picks.files.length === 0) return (status.textContent = picks.torrent ? "Now pick the files: they are fitted to the torrent." : "");
    try {
      plan = await prepare({ ...picks, onProgress: (text) => (status.textContent = text) });
      status.textContent = "";
      preview.replaceChildren(planView(plan));
    } catch (error) {
      status.textContent = "";
      onError(error);
    }
  };
  torrentInput.addEventListener("change", () => ((picks = { ...picks, torrent: torrentInput.files[0] ?? null }), replan()));
  filesInput.addEventListener("change", () => ((picks = { ...picks, files: [...filesInput.files].map(fromInput) }), replan()));
  folderInput.addEventListener("change", () => ((picks = { ...picks, files: [...folderInput.files].map(fromInput) }), replan()));
  // A folder from pickFolder, shown as a file input shows what it has: a button, and what was picked.
  const folderPicked = h("span", { id: "upload-folder-picked" }, "No folder chosen");
  const folderButton =
    pickFolder &&
    actionButton(
      "Choose Folder",
      async () => {
        let files;
        try {
          files = await pickFolder();
        } catch (error) {
          // Closing the picker isn't an error.
          if (error?.name === "AbortError") return;
          throw error;
        }
        picks = { ...picks, files };
        folderPicked.textContent = files.length ? `${files[0].path[0]}: ${files.length === 1 ? "1 file" : `${files.length} files`}` : "An empty folder";
        await replan();
      },
      onError,
      { id: "upload-folder-picker" },
    );

  function planView(initial) {
    // The plan as it is about to be uploaded: its rows get `sort` as the albums are set here.
    let current = initial;
    const nameInput = h("input", { id: "package-name", value: current.name, maxlength: 200, disabled: current.into !== null });
    const packageName = () => current.into ?? (nameInput.value.trim() || current.name);
    const rows = h("ul", { class: "rows", id: "upload-rows" });
    const groups = h("div", {});
    const sorted = () => current.rows.filter((row) => row.tags && stored(row));
    const render = () => {
      const tracks = sorted();
      const targets = packageTargets({ packageName: packageName(), files: tracks.map((row) => ({ path: row.path, tags: row.tags, sort: row.sort ?? {} })) });
      const targetOf = new Map(tracks.map((row, i) => [row, targets[i]]));
      rows.replaceChildren(...current.rows.map((row) => planRow(row, targetOf.get(row) ?? null)));
      groups.replaceChildren(albums({ id: "upload-albums", groups: albumGroups(targets), onSave: setAlbum, onError }));
    };
    const setAlbum = async (group, to) => {
      const tracks = sorted();
      const set = regroup({ packageName: packageName(), files: tracks.map((row) => ({ path: row.path, tags: row.tags, sort: row.sort ?? {} })), group, to });
      const sortOf = new Map(tracks.map((row, i) => [row, set[i].sort]));
      current = { ...current, rows: current.rows.map((row) => (sortOf.has(row) ? { ...row, sort: sortOf.get(row) } : row)) };
      render();
    };
    nameInput.addEventListener("input", render);
    render();
    const toStore = current.rows.filter(stored);
    const bytes = toStore.reduce((sum, row) => sum + row.file.size, 0);
    const count = (status) => current.rows.filter((row) => row.status === status).length;
    const progress = h("progress", { id: "upload-progress", max: 1, value: 0, hidden: true });
    const start = actionButton(
      "Upload",
      async () => {
        progress.hidden = false;
        await onUpload(current, packageName(), ({ bytes: done, totalBytes }) => (progress.value = totalBytes ? done / totalBytes : 0));
      },
      onError,
      { class: "primary", id: "upload-start", disabled: toStore.length === 0 },
    );
    return section(
      "Preview",
      current.into
        ? h("p", { id: "upload-into" }, `This torrent's package is already here: the files it lacks are added to "${current.into}".`)
        : h("label", {}, "Package name", nameInput),
      current.torrent && h("p", { class: "muted" }, `Torrent: ${current.torrent.name}, ${current.torrent.files} files.`),
      h("h3", {}, "Albums"),
      h("p", { class: "muted" }, "Where the tracks will be sorted. If the tags got it wrong, edit it here, or later on the package's page."),
      groups,
      h("h3", {}, "Files"),
      rows,
      h(
        "p",
        { id: "upload-summary" },
        [`${toStore.length} files to upload (${formatBytes(bytes)})`, count("missing") && `${count("missing")} missing`, count("unused") && `${count("unused")} left out`, count("present") && `${count("present")} already there`].filter(Boolean).join(" · "),
      ),
      progress,
      h("div", { class: "actions" }, start, h("button", { type: "button", onclick: onCancel }, "Cancel")),
    );
  }

  return h(
    "div",
    { id: "add-music-screen" },
    h("nav", { class: "breadcrumbs" }, h("button", { type: "button", id: "go-home", onclick: onHome }, "Home")),
    section(
      "Add music",
      h("p", { class: "muted" }, "Everything picked together is uploaded as one package. With a torrent, the files are fitted to it: they get its folders and names, and files it doesn't list are left out. Files are encrypted on this device before they're uploaded."),
      h("label", {}, "Torrent (optional)", torrentInput),
      h("label", {}, "Files", filesInput),
      folderPicks && h("label", {}, "Or a folder", folderInput),
      !folderPicks && folderButton && h("label", {}, "Or a folder", h("span", { class: "file-picker" }, folderButton, folderPicked)),
      status,
    ),
    preview,
  );
}

/** One file of the plan: its path, what happens to it, and where it would be sorted (`target`, or null). */
function planRow(row, sortTo) {
  const target = sortTo && shownTarget(sortTo);
  return h(
    "li",
    { "data-path": row.path.join("/"), "data-status": row.status, class: row.status },
    h("strong", {}, row.path.join("/")),
    h("span", { class: "muted" }, [STATUS[row.status], row.file && row.file.name !== row.path.at(-1) && `from ${row.file.name}`, row.file && formatBytes(row.file.size)].filter(Boolean).join(" · ")),
    target && h("span", { class: "target", "data-target": target }, `→ ${target}`),
  );
}

// ---------------------------------------------------------------- the browser

const shown = (path) => (path.length ? path.join(" / ") : "Library");

/**
 * A directory of the tree: breadcrumbs, its entries, and for a package its package.json and its albums. `targets` maps
 * a file's name to where it is sorted; `tracks` are the names of its playable files; `playing` is the path of the
 * track in the player. `albums` (a package's, or null) can be set with `onSetAlbum(group, { artist, album })`. Every
 * file can be saved to the device with `onDownload(name, onProgress)`, `onProgress(bytes)` saying how much is read.
 */
export function browser({ path, entries, details, albums: groups = null, targets, tracks, playing, onHome, onOpen, onPlay, onPlayAll, onPlayLiked, onDelete, onSetAlbum, onDownload, onError }) {
  const crumbs = [[], ...path.map((_, i) => path.slice(0, i + 1))];
  const row = (entry) => {
    const full = [...path, entry.name].join("/");
    if (entry.kind === "dir") {
      return h("li", { "data-entry": entry.name }, h("button", { type: "button", class: "row-main", onclick: () => onOpen([...path, entry.name]).catch(onError) }, "📁 ", entry.name));
    }
    const target = targets.get(entry.name);
    const playable = tracks.includes(entry.name);
    return h(
      "li",
      { "data-entry": entry.name, ...(playable ? { "data-track": full } : {}), class: full === playing ? "playing" : "" },
      playable ? h("button", { type: "button", class: "row-main", "data-action": "play", onclick: () => onPlay(entry.name).catch(onError) }, "▶ ", entry.name) : h("span", { class: "row-main" }, entry.name),
      downloadButton(entry, onDownload, onError),
      h("span", { class: "muted" }, formatBytes(entry.size)),
      target && h("span", { class: "target" }, `→ ${shownTarget(target)}`),
    );
  };
  return h(
    "div",
    { id: "browser" },
    h(
      "nav",
      { class: "breadcrumbs", id: "breadcrumbs" },
      h("button", { type: "button", id: "go-home", onclick: () => onHome().catch(onError) }, "Home"),
      crumbs.map((crumb) => h("button", { type: "button", class: "crumb", onclick: () => onOpen(crumb).catch(onError) }, crumb.length ? crumb.at(-1) : "Library")),
    ),
    details && packageDetails(details, onDelete, onError),
    groups &&
      section(
        "Albums",
        h("p", { class: "muted" }, "Where this package's tracks are sorted, under Artists. If the tags got it wrong, set the artist and album here."),
        albums({ id: "package-albums", groups, onSave: onSetAlbum, onError }),
      ),
    section(
      shown(path),
      // Above the list, so a long one needn't be scrolled through to play it.
      (onPlayAll || onPlayLiked) &&
        h(
          "div",
          { class: "actions" },
          onPlayAll && actionButton("Play all", onPlayAll, onError, { id: "play-all" }),
          // Only the liked tracks below, where any are (an artist's, an album's).
          onPlayLiked && actionButton("♥ Play likes", onPlayLiked, onError, { id: "play-liked" }),
        ),
      h("ul", { class: "rows", id: "entries" }, entries.length ? entries.map(row) : h("li", { class: "muted empty" }, "Empty")),
    ),
  );
}

/** Download: saves the file to the device. While it is read, the button says how far along it is. */
function downloadButton(entry, onDownload, onError) {
  const label = "Download";
  const button = h("button", { type: "button", "data-action": "download", "aria-label": `Download ${entry.name}` }, label);
  const progress = (bytes) => (button.textContent = `${entry.size ? Math.floor((100 * bytes) / entry.size) : 100}%`);
  button.addEventListener("click", () => busy(button, () => onDownload(entry.name, progress).finally(() => (button.textContent = label)), onError));
  return button;
}

function packageDetails(doc, onDelete, onError) {
  const line = (label, value) => value !== null && value !== undefined && value !== "" && h("li", {}, h("span", { class: "label" }, `${label}: `), value);
  return section(
    `Package: ${doc.name}`,
    h(
      "ul",
      { class: "report", id: "package-details" },
      line("Uploaded", new Date(doc.uploaded).toLocaleString()),
      doc.updated !== doc.uploaded && line("Completed", new Date(doc.updated).toLocaleString()),
      line("From", { files: "files picked one by one", folder: "a folder", torrent: "files fitted to a torrent" }[doc.source] ?? doc.source),
      doc.torrent && line("Torrent", `${doc.torrent.name} (${doc.torrent.files} files)`),
      line("Files", `${doc.files} (${formatBytes(doc.bytes)})`),
      doc.missing.length > 0 && line("Missing from the torrent", h("span", { id: "package-missing" }, doc.missing.join(", "))),
    ),
    h(
      "div",
      { class: "actions" },
      actionButton("Delete package", async () => {
        if (window.confirm(`Delete the package "${doc.name}" and all its files?`)) await onDelete(doc.name);
      }, onError, { id: "delete-package" }),
    ),
  );
}

// ---------------------------------------------------------------- likes

/**
 * Likes, the newest first (`likes`, entries of lists/likes/ as `tracks`: trackOf's, by name). `lost` are the names
 * of those whose package is gone: they are listed apart too, as they play only from here now.
 */
export function likes({ tracks, lost, playing, onHome, onPlay, onPlayAll, onUnlike, onError }) {
  const row = (track) =>
    h(
      "li",
      { "data-like": track.name.split("/").at(-1), "data-track": track.name, class: track.name === playing ? "playing" : "" },
      h("button", { type: "button", class: "row-main", "data-action": "play", onclick: () => onPlay(track).catch(onError) }, "▶ ", track.title),
      actionButton("Unlike", () => onUnlike(track), onError, { "data-action": "unlike", "aria-label": `Unlike ${track.title}` }),
      h("span", { class: "muted" }, [track.artist, `liked ${new Date(track.liked).toLocaleDateString()}`, lost.has(track.name) && "not in any package"].filter(Boolean).join(" · ")),
    );
  const gone = tracks.filter((track) => lost.has(track.name));
  return h(
    "div",
    { id: "likes-screen" },
    h("nav", { class: "breadcrumbs" }, h("button", { type: "button", id: "go-home", onclick: () => onHome().catch(onError) }, "Home")),
    section(
      "Likes",
      tracks.length > 0 && h("div", { class: "actions" }, actionButton("Play all", onPlayAll, onError, { id: "play-likes" })),
      h("ul", { class: "rows", id: "likes" }, tracks.length ? tracks.map(row) : h("li", { class: "muted empty" }, "Nothing liked yet: ♡ in the player likes what plays.")),
    ),
    gone.length > 0 &&
      section(
        "Not in any package",
        h("p", { class: "muted" }, "Their packages were deleted, so these tracks are only kept here now. They still play; an unliked one is deleted for good at the next cleanup."),
        h("ul", { class: "rows", id: "likes-lost" }, gone.map(row)),
      ),
  );
}

// ---------------------------------------------------------------- dislikes

/**
 * Dislikes, the newest first (dislikes.js's, as { sha256, title, artist, disliked }): tracks no list plays unless they
 * are started on purpose, each with Undo, which lets lists play it again.
 */
export function dislikes({ tracks, onHome, onUndislike, onError }) {
  const row = (track) =>
    h(
      "li",
      { "data-dislike": track.sha256 },
      h("span", { class: "row-main" }, track.title || "(no title)"),
      actionButton("Undo", () => onUndislike(track), onError, { "data-action": "undislike", "aria-label": `Undo the dislike of ${track.title}` }),
      h("span", { class: "muted" }, [track.artist, track.disliked && `disliked ${new Date(track.disliked).toLocaleDateString()}`].filter(Boolean).join(" · ")),
    );
  return h(
    "div",
    { id: "dislikes-screen" },
    h("nav", { class: "breadcrumbs" }, h("button", { type: "button", id: "go-home", onclick: () => onHome().catch(onError) }, "Home")),
    section(
      "Dislikes",
      h("p", { class: "muted" }, "No list plays these: next and previous go past them, and Play all starts after them. They still play when started on purpose."),
      h("ul", { class: "rows", id: "dislikes" }, tracks.length ? tracks.map(row) : h("li", { class: "muted empty" }, "Nothing disliked: 👎 in the player dislikes what plays, and goes on to the next.")),
    ),
  );
}

