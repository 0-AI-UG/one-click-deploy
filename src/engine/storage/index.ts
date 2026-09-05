import { localDirectoryStorage } from "./local-directory.ts";
import { providerBlockStorage } from "./provider-block.ts";
import { registerStorageDriver } from "./registry.ts";

registerStorageDriver(localDirectoryStorage);
registerStorageDriver(providerBlockStorage("hetzner"));

export {
  defaultStorageDriverForServer,
  listStorageDrivers,
  requireStorageDriver,
  __replaceStorageDriversForTest,
} from "./registry.ts";
export type { StorageDriver, StorageVolume } from "./contracts.ts";
