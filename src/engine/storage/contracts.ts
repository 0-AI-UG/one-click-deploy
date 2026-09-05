import type { ServerRow } from "../../shared/db.ts";

export type StorageVolume = {
  id: string;
  name: string;
  sizeGb: number;
  location: string;
  attachedServerId: string | null;
  hostPath: string;
};

export interface StorageDriver {
  readonly id: string;
  readonly name: string;
  readonly portable: boolean;
  supports(server: ServerRow): boolean;
  create(input: { server: ServerRow; name: string; sizeGb: number }): Promise<StorageVolume>;
  inspect(volumeId: string, server?: ServerRow): Promise<StorageVolume>;
  list(server?: ServerRow): Promise<StorageVolume[]>;
  attach(volumeId: string, server: ServerRow): Promise<void>;
  detach(volumeId: string, server?: ServerRow): Promise<void>;
  resize(volumeId: string, sizeGb: number, server?: ServerRow): Promise<void>;
  rename(volumeId: string, name: string, server?: ServerRow): Promise<void>;
  delete(volumeId: string, server?: ServerRow): Promise<void>;
  ensureMount(input: {
    server: ServerRow;
    volumeId: string;
    hostPath: string;
    blockName: string;
  }): Promise<void>;
  removeMount(input: {
    server: ServerRow;
    volumeId: string;
    hostPath: string;
    blockName: string;
  }): Promise<void>;
}
