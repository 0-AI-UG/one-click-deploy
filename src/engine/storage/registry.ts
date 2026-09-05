import type { ServerRow } from "../../shared/db.ts";
import type { StorageDriver } from "./contracts.ts";
import { assignedProvider } from "../../shared/provider-connections.ts";

const drivers = new Map<string, StorageDriver>();

export function registerStorageDriver(driver: StorageDriver): void {
  if (!/^[a-z][a-z0-9-]*$/.test(driver.id)) throw new Error(`Invalid storage driver id: ${driver.id}`);
  if (drivers.has(driver.id)) throw new Error(`Storage driver already registered: ${driver.id}`);
  drivers.set(driver.id, driver);
}

export function requireStorageDriver(id: string): StorageDriver {
  const driver = drivers.get(id);
  if (!driver) throw new Error(`Storage driver is not installed: ${id || "(empty)"}`);
  return driver;
}

export function listStorageDrivers(): StorageDriver[] {
  return [...drivers.values()];
}

export function defaultStorageDriverForServer(server: ServerRow): StorageDriver {
  const infrastructureProvider = assignedProvider("infrastructure");
  const preferred = server.ownership === "managed" && infrastructureProvider?.kind === server.provider
    ? `${infrastructureProvider.kind}-block`
    : "local-directory";
  const driver = drivers.get(preferred) ?? drivers.get("local-directory");
  if (!driver || !driver.supports(server)) {
    throw new Error(`No compatible storage driver is installed for server ${server.name}`);
  }
  return driver;
}

export function __replaceStorageDriversForTest(next: StorageDriver[]): void {
  drivers.clear();
  for (const driver of next) registerStorageDriver(driver);
}
