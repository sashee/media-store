// The screens (SPEC §7). Each returns an element; actions are passed in, nothing here talks to the server. The account
// screens are pw-mgr's, worded for a library.

import { parseRecoveryKey } from "../../sdk/recovery-key.js";
import { parseSetupInput } from "../../sdk/setup-link.js";
import { formatBytes, summary } from "../../sdk/maintenance.js";
import { copySecret } from "./clipboard.js";
import { busy, h } from "./dom.js";

const section = (title, ...children) => h("section", { class: "card" }, h("h2", {}, title), ...children);

/** A button that runs an async action, disabled while it runs. */
const actionButton = (label, action, onError, props = {}) => {
  const button = h("button", { type: "button", ...props }, label);
  button.addEventListener("click", () => busy(button, action, onError));
  return button;
};

/** A copy button that says "Copied" for 2 seconds. */
function copyButton(label, getText, onError) {
  const button = h("button", { type: "button", class: "copy", "data-copy": label }, label);
  button.addEventListener("click", async () => {
    try {
      await copySecret(getText());
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = label), 2000);
    } catch (error) {
      onError(error);
    }
  });
  return button;
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "never");

export const loading = (text) => section(text, h("p", { class: "muted" }, "Please wait…"));

export const message = ({ title, text, actions = [] }) => section(title, h("p", {}, text), h("div", { class: "actions" }, actions));

// ---------------------------------------------------------------- unlocking and setting up (e2ee-store/sdk/SPEC.md §6.1–§6.9)

export function unlock({ hasSession, onPasskey, onRecovery, onSetup, onError }) {
  // For browsers without an address bar (the Android app): paste the setup link or token here.
  const setupInput = h("input", { id: "setup-input", autocomplete: "off", spellcheck: "false", placeholder: "Setup link or token" });
  const problem = h("p", { class: "error", role: "alert" });
  const useSetup = async () => {
    const token = parseSetupInput(setupInput.value);
    problem.textContent = token ? "" : "That isn't a setup link or token.";
    if (token) await onSetup(token);
  };
  return h(
    "div",
    {},
    section(
      "Unlock your library",
      h("p", {}, "Use your passkey to unlock."),
      h("div", { class: "actions" }, actionButton("Unlock with passkey", onPasskey, onError, { class: "primary", id: "unlock" }), hasSession && h("button", { type: "button", onclick: onRecovery }, "Use recovery key")),
    ),
    section(
      "New here or on a new device?",
      h("p", { class: "muted" }, "Paste the setup link or token you got. For an existing library you'll also need your recovery key."),
      h("label", {}, "Setup link or token", setupInput),
      problem,
      h("div", { class: "actions" }, actionButton("Continue", useSetup, onError, { id: "use-setup" })),
    ),
  );
}

export function createPasskey({ title, intro, defaultName, onCreate, onSkip, onError }) {
  const name = h("input", { id: "passkey-name", value: defaultName, maxlength: 64, required: true });
  return section(
    title,
    h("p", {}, intro),
    h("label", {}, "Passkey name", name),
    h("div", { class: "actions" }, actionButton("Create passkey", () => onCreate(name.value.trim() || defaultName), onError, { class: "primary", id: "create-passkey" }), onSkip && h("button", { type: "button", onclick: onSkip }, "Skip")),
  );
}

export const confirmPasskey = ({ onConfirm, onError }) =>
  section(
    "One more step",
    h("p", {}, "Your browser didn't return the passkey's key yet. Use the new passkey once more to set it up."),
    h("div", { class: "actions" }, actionButton("Use the new passkey", onConfirm, onError, { class: "primary", id: "confirm-passkey" })),
  );

export function showRecoveryKey({ keyText, onConfirm, onCancel, confirmLabel = "Create library", onError }) {
  const confirmButton = actionButton(confirmLabel, onConfirm, onError, { class: "primary", id: "create-library", disabled: true });
  const saved = h("input", { type: "checkbox", id: "saved-recovery-key", onchange: (e) => (confirmButton.disabled = !e.target.checked) });
  return section(
    "Your recovery key",
    h("p", {}, "Save this key somewhere safe, outside this browser. You need it to set up a new device or if you lose your passkeys. It is shown only once."),
    h("code", { class: "recovery-key", id: "recovery-key" }, keyText),
    h("div", { class: "actions" }, copyButton("Copy recovery key", () => keyText, onError)),
    h("label", { class: "check" }, saved, "I have saved my recovery key"),
    h("div", { class: "actions" }, confirmButton, onCancel && h("button", { type: "button", onclick: onCancel }, "Cancel")),
  );
}

export function enterRecoveryKey({ intro, onSubmit, onError }) {
  const input = h("textarea", { id: "recovery-key-input", rows: 2, autocomplete: "off", spellcheck: "false" });
  const problem = h("p", { class: "error", role: "alert" });
  const submit = async () => {
    const key = parseRecoveryKey(input.value);
    problem.textContent = key ? "" : "A recovery key is 64 hex characters.";
    if (key) await onSubmit(key);
  };
  return section(
    "Enter your recovery key",
    h("p", {}, intro),
    h("label", {}, "Recovery key", input),
    problem,
    h("div", { class: "actions" }, actionButton("Unlock", submit, onError, { class: "primary", id: "unlock-recovery" })),
  );
}

// ---------------------------------------------------------------- settings (e2ee-store/sdk/SPEC.md §6.6–§6.11)

export function settings({ host, passkeys, slots, lastCleanup, onAddPasskey, onSetUp, onDeletePasskey, onAddDevice, onReplaceRecoveryKey, onTestRecoveryKey, onResort, onCleanup, onCheckDuplicates, onBack, onError }) {
  const canUnlockCount = passkeys.filter((p) => slots.includes(p.id)).length;
  const passkeyRow = (p) => {
    const canUnlock = slots.includes(p.id);
    return h(
      "li",
      { "data-passkey": p.name },
      h("strong", {}, p.name),
      h("span", { class: "muted" }, ` · ${p.rp_id} · created ${when(p.created_at)} · last used ${when(p.last_used_at)}`),
      h("div", { class: "badges" }, p.current && h("span", { class: "badge" }, "this session"), h("span", { class: canUnlock ? "badge" : "badge warn" }, canUnlock ? "can unlock" : "not set up")),
      h(
        "div",
        { class: "actions" },
        !canUnlock && p.rp_id === host && actionButton("Set up", () => onSetUp(p), onError, { "data-action": "set-up" }),
        !canUnlock && p.rp_id !== host && h("span", { class: "muted" }, `Set it up on ${p.rp_id}`),
        actionButton("Delete", async () => {
          const last = canUnlock && canUnlockCount === 1;
          const warning = last ? " It's the last passkey that can unlock the library: afterwards you'll need the recovery key." : "";
          if (window.confirm(`Delete the passkey "${p.name}"?${warning}`)) await onDeletePasskey(p);
        }, onError, { "data-action": "delete" }),
      ),
    );
  };
  return h(
    "div",
    { id: "settings-screen" },
    h("div", { class: "toolbar" }, h("button", { type: "button", id: "back", onclick: onBack }, "← Back to the library")),
    section(
      "Passkeys",
      h("ul", { class: "passkeys", id: "passkeys" }, passkeys.map(passkeyRow)),
      h("div", { class: "actions" }, actionButton("Add a passkey on this device", onAddPasskey, onError, { id: "add-passkey" })),
    ),
    section(
      "Add a device",
      h("p", {}, "Creates a setup link for another device, valid for 15 minutes. On that device you'll also need your recovery key."),
      h("div", { class: "actions" }, actionButton("Create setup link", onAddDevice, onError, { id: "add-device" })),
    ),
    section(
      "Recovery key",
      recoveryKeyTest(onTestRecoveryKey, onError),
      h("p", {}, "Replace your recovery key, e.g. if you lost the old one. The old key stops working."),
      h("div", { class: "actions" }, actionButton("Create a new recovery key", onReplaceRecoveryKey, onError, { id: "replace-recovery-key" })),
    ),
    section(
      "Artists",
      h("p", {}, "Every upload is sorted into artists and albums by itself. Sort again rebuilds them from all the packages, e.g. after an update that sorts differently."),
      h("div", { class: "actions" }, actionButton("Sort again", onResort, onError, { id: "resort" })),
    ),
    section(
      "Storage",
      h("p", { class: "muted", id: "last-cleanup" }, lastCleanup ? `Last cleanup: ${summary(lastCleanup)}` : "No cleanup has run on this device yet."),
      h("div", { class: "actions" }, actionButton("Clean up now", onCleanup, onError, { id: "cleanup" })),
      h("p", {}, "Check for duplicates looks for files stored more than once: the same bytes in two places that don't share their storage."),
      h("div", { class: "actions" }, actionButton("Check for duplicates", onCheckDuplicates, onError, { id: "check-duplicates" })),
    ),
  );
}

/** What Check for duplicates found (duplicates.js): each set of the same bytes, the blobs holding them and their paths. */
export function duplicatesReport({ found, onDone }) {
  const total = found.reduce((sum, { size, blobs }) => sum + size * (blobs.length - 1), 0);
  const group = ({ size, blobs }) =>
    h(
      "li",
      { "data-duplicate": blobs[0].paths[0] },
      h("strong", {}, blobs[0].paths[0].split("/").at(-1)),
      h("span", { class: "muted" }, ` · ${formatBytes(size)}, stored ${blobs.length} times`),
      h("ol", {}, blobs.map(({ paths }) => h("li", {}, paths.join(", ")))),
    );
  return section(
    "Duplicates",
    found.length === 0
      ? h("p", { id: "duplicates-none" }, "No file is stored twice.")
      : [
          h("p", { id: "duplicates-summary" }, `${found.length === 1 ? "1 file is" : `${found.length} files are`} stored more than once, taking ${formatBytes(total)} more than once would.`),
          h("ul", { class: "report", id: "duplicates" }, found.map(group)),
        ],
    h("div", { class: "actions" }, h("button", { type: "button", id: "done", onclick: onDone }, "Done")),
  );
}

export function setupLink({ token, expiresAt, links, onDone, onError }) {
  const fragment = `/#setup=${token}`;
  const countdown = h("p", { class: "muted", id: "setup-expiry" });
  const tick = () => {
    const left = Math.max(0, Date.parse(expiresAt) - Date.now());
    countdown.textContent = left > 0 ? `Valid for ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")} more.` : "Expired.";
    if (left > 0 && (countdown.isConnected || !countdown.dataset.started)) {
      countdown.dataset.started = "1";
      setTimeout(tick, 1000);
    }
  };
  tick();
  const row = (label, text, id) => h("div", { class: "field" }, h("span", { class: "label" }, label), h("div", { class: "value" }, h("code", { class: "wrap", id }, text), copyButton("Copy", () => text, onError)));
  return section(
    "Setup link",
    h("p", {}, "On the new device, paste this on the start page (or open the link), then enter your recovery key."),
    row("Token", token, "setup-token"),
    row("For an iroh address (append to it)", fragment, "setup-fragment"),
    links.map((link) => row("Link", link, null)),
    countdown,
    h("p", { class: "muted" }, "Anyone with this link and your recovery key can open your library. Only send it to yourself."),
    h("div", { class: "actions" }, h("button", { type: "button", id: "done", onclick: onDone }, "Done")),
  );
}

export const confirmIdentity = ({ onConfirm, onCancel, onError }) =>
  section(
    "Confirm it's you",
    h("p", {}, "This needs a recent login. Use your passkey to continue."),
    h("div", { class: "actions" }, actionButton("Use passkey", onConfirm, onError, { class: "primary", id: "confirm-identity" }), h("button", { type: "button", onclick: onCancel }, "Cancel")),
  );

export function cleanupProgress() {
  const status = h("p", { id: "cleanup-status" }, "Starting…");
  return { element: section("Cleaning up", status), update: (text) => (status.textContent = text) };
}

export function cleanupReport({ report, onDone }) {
  const line = (label, value) => h("li", {}, h("span", { class: "label" }, `${label}: `), value);
  const count = ({ count, bytes }) => `${count} (${formatBytes(bytes)})`;
  return section(
    report.error ? "Cleanup stopped" : "Cleanup finished",
    h(
      "ul",
      { class: "report", id: "cleanup-report" },
      line("Blobs found", `${report.blobs_total} (${formatBytes(report.bytes_total)})`),
      line("Kept (the current library and keys)", count(report.kept)),
      line("Deleted", h("span", { id: "cleanup-deleted" }, count(report.deleted))),
      line("Too recent to delete (under 24 hours)", count(report.too_recent)),
      line("Passkey slots removed", String(report.slots_removed)),
      line("Failed", String(report.failed.length)),
      report.failed.map((f) => h("li", { class: "error" }, `${f.id.slice(0, 12)}…: ${f.error}`)),
      report.error && h("li", { class: "error" }, `Stopped: ${report.error}`),
    ),
    h("div", { class: "actions" }, h("button", { type: "button", id: "done", onclick: onDone }, "Done")),
  );
}

/** Checks the recovery key the user wrote down against the library. The key isn't kept. */
function recoveryKeyTest(onTest, onError) {
  const input = h("input", { id: "test-recovery-key", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "64 hex characters" });
  const result = h("p", { id: "recovery-test-result", role: "status" });
  const test = async () => {
    const key = parseRecoveryKey(input.value);
    input.value = "";
    if (!key) return (result.textContent = "A recovery key is 64 hex characters.");
    const outcome = await onTest(key);
    result.textContent = {
      ok: "This recovery key opens your library.",
      wrong: "This key does NOT open your library. Check what you wrote down, or create a new recovery key.",
      missing: "The library has no recovery slot on the server. Create a new recovery key.",
    }[outcome];
    result.className = outcome === "ok" ? "" : "error";
  };
  return h(
    "div",
    {},
    h("p", {}, "Check that the recovery key you saved still opens the library."),
    h("label", {}, "Recovery key", input),
    h("div", { class: "actions" }, actionButton("Test recovery key", test, onError, { id: "test-recovery" })),
    result,
  );
}
