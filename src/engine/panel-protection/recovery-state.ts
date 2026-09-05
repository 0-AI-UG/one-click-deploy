import { existsSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../shared/paths.ts";
export const recoveryMarker = path.join(DATA_DIR, "recovery-pending.json");
export const recoveryPending = () => existsSync(recoveryMarker);
