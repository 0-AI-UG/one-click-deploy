import { useState, useEffect } from "react";
import { get } from "../api/client.ts";

export type HetznerServerType = {
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  locations: string[];
};

export function useServerTypes() {
  const [serverTypes, setServerTypes] = useState<HetznerServerType[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    get("/api/settings/server-types")
      .then((data: any) => setServerTypes(data.server_types ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { serverTypes, loading };
}

export function typeOptions(types: HetznerServerType[]) {
  return types.map((t) => ({ value: t.name, label: `${t.name} (${t.cores}c/${t.memory}GB)` }));
}

export function locationOptions(types: HetznerServerType[], selectedType: string) {
  const t = types.find((t) => t.name === selectedType);
  return (t?.locations ?? []).map((l) => ({ value: l, label: l }));
}
