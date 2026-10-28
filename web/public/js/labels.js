// The app's namespace (e2ee-store/sdk/SPEC.md §2), in a module of its own so the Service Worker can import it without
// the flows. Fixed forever: every key and blob of a library is bound to it.

import { labels } from "../sdk/labels.js";

export const LABELS = labels("media-store");
