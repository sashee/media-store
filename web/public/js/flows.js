import { makeFlows } from "../sdk/flows.js";
import { LABELS } from "./labels.js";

// One upload at a time: an album's tracks go up one after another.
export const flows = makeFlows({ labels: LABELS, parallelUploads: 1 });
