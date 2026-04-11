export type ServiceEnvVar = {
  key: string;
  label: string;
  generate?: "password" | "username";
  default?: string;
};

export type ServiceDefinition = {
  type: string;
  label: string;
  image: string;
  versions: string[];
  defaultPort: number;
  requiredEnvVars: ServiceEnvVar[];
  volumePath: string;
  healthCmd: string;
  defaultVolumeSize: number;
  connectionUrlTemplate: string;
};

function randomPassword(len = 24): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export function generateEnvVars(def: ServiceDefinition): Record<string, string> {
  const env: Record<string, string> = {};
  for (const v of def.requiredEnvVars) {
    if (v.generate === "password") {
      env[v.key] = randomPassword();
    } else if (v.generate === "username") {
      env[v.key] = "ocd_user";
    } else if (v.default) {
      env[v.key] = v.default;
    }
  }
  return env;
}

export function buildConnectionUrl(
  def: ServiceDefinition,
  env: Record<string, string>,
  host: string,
  port: number,
): string {
  let url = def.connectionUrlTemplate;
  url = url.replace("{host}", host);
  url = url.replace("{port}", String(port));
  // Replace any {ENV_VAR_NAME} placeholders with actual env var values
  for (const [k, v] of Object.entries(env)) {
    url = url.replace(`{${k}}`, encodeURIComponent(v));
  }
  return url;
}

export const SERVICE_CATALOG: Record<string, ServiceDefinition> = {
  postgresql: {
    type: "postgresql",
    label: "PostgreSQL",
    image: "postgres",
    versions: ["17-alpine", "16-alpine", "15-alpine", "14-alpine"],
    defaultPort: 5432,
    requiredEnvVars: [
      { key: "POSTGRES_USER", label: "Username", generate: "username" },
      { key: "POSTGRES_PASSWORD", label: "Password", generate: "password" },
      { key: "POSTGRES_DB", label: "Database", default: "app" },
    ],
    volumePath: "/var/lib/postgresql/data",
    healthCmd: "pg_isready",
    defaultVolumeSize: 10,
    connectionUrlTemplate:
      "postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{host}:{port}/{POSTGRES_DB}",
  },

  mysql: {
    type: "mysql",
    label: "MySQL",
    image: "mysql",
    versions: ["8.4", "8.0", "5.7"],
    defaultPort: 3306,
    requiredEnvVars: [
      { key: "MYSQL_ROOT_PASSWORD", label: "Root Password", generate: "password" },
      { key: "MYSQL_DATABASE", label: "Database", default: "app" },
      { key: "MYSQL_USER", label: "Username", generate: "username" },
      { key: "MYSQL_PASSWORD", label: "Password", generate: "password" },
    ],
    volumePath: "/var/lib/mysql",
    healthCmd: "mysqladmin ping -h localhost",
    defaultVolumeSize: 10,
    connectionUrlTemplate:
      "mysql://{MYSQL_USER}:{MYSQL_PASSWORD}@{host}:{port}/{MYSQL_DATABASE}",
  },

  mariadb: {
    type: "mariadb",
    label: "MariaDB",
    image: "mariadb",
    versions: ["11", "10.11", "10.6"],
    defaultPort: 3306,
    requiredEnvVars: [
      { key: "MARIADB_ROOT_PASSWORD", label: "Root Password", generate: "password" },
      { key: "MARIADB_DATABASE", label: "Database", default: "app" },
      { key: "MARIADB_USER", label: "Username", generate: "username" },
      { key: "MARIADB_PASSWORD", label: "Password", generate: "password" },
    ],
    volumePath: "/var/lib/mysql",
    healthCmd: "healthcheck.sh --connect --innodb_initialized",
    defaultVolumeSize: 10,
    connectionUrlTemplate:
      "mysql://{MARIADB_USER}:{MARIADB_PASSWORD}@{host}:{port}/{MARIADB_DATABASE}",
  },

  redis: {
    type: "redis",
    label: "Redis",
    image: "redis",
    versions: ["7-alpine", "7", "6-alpine"],
    defaultPort: 6379,
    requiredEnvVars: [
      { key: "REDIS_PASSWORD", label: "Password", generate: "password" },
    ],
    volumePath: "/data",
    healthCmd: "redis-cli ping",
    defaultVolumeSize: 5,
    connectionUrlTemplate: "redis://:{REDIS_PASSWORD}@{host}:{port}",
  },

  mongodb: {
    type: "mongodb",
    label: "MongoDB",
    image: "mongo",
    versions: ["7", "6"],
    defaultPort: 27017,
    requiredEnvVars: [
      { key: "MONGO_INITDB_ROOT_USERNAME", label: "Root Username", generate: "username" },
      { key: "MONGO_INITDB_ROOT_PASSWORD", label: "Root Password", generate: "password" },
    ],
    volumePath: "/data/db",
    healthCmd: "mongosh --quiet --eval \"db.runCommand('ping').ok\"",
    defaultVolumeSize: 10,
    connectionUrlTemplate:
      "mongodb://{MONGO_INITDB_ROOT_USERNAME}:{MONGO_INITDB_ROOT_PASSWORD}@{host}:{port}/?authSource=admin",
  },
};

export function getCatalogEntry(type: string): ServiceDefinition | undefined {
  return SERVICE_CATALOG[type];
}

export function getCatalogEntries(): ServiceDefinition[] {
  return Object.values(SERVICE_CATALOG);
}
