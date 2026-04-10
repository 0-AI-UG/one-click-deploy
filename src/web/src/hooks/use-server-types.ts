import { useState, useEffect } from "react";
import { get } from "../api/client.ts";
import { getToken } from "../stores/auth.ts";

export type ServerType = {
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  locations: string[];
};

export function useServerTypes() {
  const [serverTypes, setServerTypes] = useState<ServerType[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // The endpoint requires auth and a configured Hetzner token, so skip during
    // initial setup — otherwise the 401 triggers a redirect loop on /setup.
    if (!getToken()) {
      setLoading(false);
      return;
    }
    get("/api/admin/settings/server-types")
      .then((data) => setServerTypes((data as { server_types?: ServerType[] }).server_types ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { serverTypes, loading };
}

export function typeOptions(types: ServerType[]) {
  return types.map((t) => ({ value: t.name, label: `${t.name} (${t.cores}c/${t.memory}GB)` }));
}

export function locationOptions(types: ServerType[], selectedType: string) {
  const t = types.find((t) => t.name === selectedType);
  return (t?.locations ?? []).map((l) => ({ value: l, label: l }));
}
