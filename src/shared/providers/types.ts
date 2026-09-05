// --- Normalized Hetzner resource types ---

export type ProviderServer = {
  providerId: string;
  ipv4: string;
  ipv6: string;
  /** Private network IPv4 assigned by the provider at create time. Empty
   *  string when the provider doesn't implement private networking or the
   *  server isn't attached. */
  routingAddress?: string;
  status: string;
};

export type ProviderVolume = {
  providerId: string;
  linuxDevice: string;
};

export type ServerType = {
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  locations: string[];
};

export type VolumeInfo = {
  providerId: string;
  name: string;
  sizeGb: number;
  location: string;
  serverId: string | null;
};

export type TokenValidation =
  | { valid: true; value: string }
  | { valid: false; error: string };
