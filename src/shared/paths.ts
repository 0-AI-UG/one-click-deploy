import path from "path";
import { homedir } from "os";

// Data dir for the panel. Override with OCD_DATA_DIR — the Docker container
// sets it to /app/data (mounted to a persistent volume).
export const DATA_DIR: string =
  process.env.OCD_DATA_DIR || path.join(homedir(), ".ocp");

export const SSH_DIR: string = path.join(DATA_DIR, "ssh");
