// Copying secrets (SPEC §9.3): cleared after 30 seconds, best effort.

const CLEAR_AFTER_MS = 30_000;
let pendingClear = null;

export async function copySecret(text) {
  await navigator.clipboard.writeText(text);
  clearTimeout(pendingClear);
  // Only if the page still has focus: browsers refuse clipboard writes otherwise. The clipboard can't be
  // read without a prompt, so this may also clear something copied elsewhere since.
  pendingClear = setTimeout(() => {
    if (document.hasFocus()) navigator.clipboard.writeText("").catch(() => {});
  }, CLEAR_AFTER_MS);
}
