export type ServiceEnvVar = {
  key: string;
  label: string;
  generate?: "password" | "username";
  default?: string;
};

export type ReplicationConfig = {
  supported: boolean;
  /** Extra env vars for the primary to enable replication (e.g. wal_level) */
  primaryExtraEnv?: Record<string, string>;
  /** Extra cmd args for the primary (e.g. --server-id=1 --log-bin) */
  primaryExtraCmd?: string[];
  /** Returns env vars for a read-replica container */
  makeReplicaEnv: (
    primaryHost: string,
    primaryPort: number,
    primaryEnv: Record<string, string>,
  ) => Record<string, string>;
  /** Returns cmd override for a read-replica container */
  makeReplicaCmd?: (
    primaryHost: string,
    primaryPort: number,
    primaryEnv: Record<string, string>,
  ) => string[];
  /** Health check command for replicas (if different from primary) */
  replicaHealthCmd?: string;
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
  replication: ReplicationConfig;
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
    replication: {
      supported: true,
      primaryExtraCmd: [
        "-c", "wal_level=replica",
        "-c", "max_wal_senders=10",
        "-c", "hot_standby=on",
        "-c", "max_replication_slots=10",
      ],
      makeReplicaEnv: (primaryHost, _primaryPort, primaryEnv) => ({
        PGUSER: primaryEnv.POSTGRES_USER || "ocd_user",
        PGPASSWORD: primaryEnv.POSTGRES_PASSWORD || "",
        PRIMARY_HOST: primaryHost,
        PRIMARY_PORT: String(_primaryPort),
      }),
      makeReplicaCmd: (primaryHost, primaryPort, primaryEnv) => [
        "bash", "-c",
        [
          // Wait for primary to be ready
          `until pg_isready -h ${primaryHost} -p ${primaryPort} -U ${primaryEnv.POSTGRES_USER}; do sleep 1; done`,
          // If data directory is empty, do a base backup
          `if [ -z "$(ls -A /var/lib/postgresql/data 2>/dev/null)" ]; then`,
          `  PGPASSWORD='${primaryEnv.POSTGRES_PASSWORD}' pg_basebackup -h ${primaryHost} -p ${primaryPort} -U ${primaryEnv.POSTGRES_USER} -D /var/lib/postgresql/data -Fp -Xs -R -P`,
          `fi`,
          // Start postgres in standby mode
          `exec postgres`,
        ].join("\n"),
      ],
      replicaHealthCmd: "pg_isready",
    },
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
    replication: {
      supported: true,
      primaryExtraCmd: [
        "--server-id=1",
        "--log-bin=mysql-bin",
        "--binlog-format=ROW",
        "--gtid-mode=ON",
        "--enforce-gtid-consistency=ON",
      ],
      makeReplicaEnv: (_primaryHost, _primaryPort, primaryEnv) => ({
        MYSQL_ROOT_PASSWORD: primaryEnv.MYSQL_ROOT_PASSWORD || "",
        PRIMARY_HOST: _primaryHost,
        PRIMARY_PORT: String(_primaryPort),
      }),
      makeReplicaCmd: (primaryHost, primaryPort, primaryEnv) => [
        "bash", "-c",
        [
          // Start MySQL in background with replica settings
          `docker-entrypoint.sh mysqld --server-id=$((RANDOM % 10000 + 2)) --read-only=1 --gtid-mode=ON --enforce-gtid-consistency=ON &`,
          `MYSQLD_PID=$!`,
          // Wait for local MySQL to be ready
          `until mysqladmin ping -h localhost -u root -p'${primaryEnv.MYSQL_ROOT_PASSWORD}' --silent 2>/dev/null; do sleep 2; done`,
          // Configure replication
          `mysql -u root -p'${primaryEnv.MYSQL_ROOT_PASSWORD}' -e "CHANGE REPLICATION SOURCE TO SOURCE_HOST='${primaryHost}', SOURCE_PORT=${primaryPort}, SOURCE_USER='root', SOURCE_PASSWORD='${primaryEnv.MYSQL_ROOT_PASSWORD}', SOURCE_AUTO_POSITION=1; START REPLICA;"`,
          // Wait for mysqld
          `wait $MYSQLD_PID`,
        ].join("\n"),
      ],
      replicaHealthCmd: "mysqladmin ping -h localhost",
    },
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
    replication: {
      supported: true,
      primaryExtraCmd: [
        "--server-id=1",
        "--log-bin=mariadb-bin",
        "--binlog-format=ROW",
      ],
      makeReplicaEnv: (_primaryHost, _primaryPort, primaryEnv) => ({
        MARIADB_ROOT_PASSWORD: primaryEnv.MARIADB_ROOT_PASSWORD || "",
        PRIMARY_HOST: _primaryHost,
        PRIMARY_PORT: String(_primaryPort),
      }),
      makeReplicaCmd: (primaryHost, primaryPort, primaryEnv) => [
        "bash", "-c",
        [
          `docker-entrypoint.sh mariadbd --server-id=$((RANDOM % 10000 + 2)) --read-only=1 &`,
          `MYSQLD_PID=$!`,
          `until mariadb-admin ping -h localhost -u root -p'${primaryEnv.MARIADB_ROOT_PASSWORD}' --silent 2>/dev/null; do sleep 2; done`,
          `mariadb -u root -p'${primaryEnv.MARIADB_ROOT_PASSWORD}' -e "CHANGE MASTER TO MASTER_HOST='${primaryHost}', MASTER_PORT=${primaryPort}, MASTER_USER='root', MASTER_PASSWORD='${primaryEnv.MARIADB_ROOT_PASSWORD}', MASTER_USE_GTID=slave_pos; START SLAVE;"`,
          `wait $MYSQLD_PID`,
        ].join("\n"),
      ],
      replicaHealthCmd: "mariadb-admin ping -h localhost",
    },
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
    replication: {
      supported: true,
      makeReplicaEnv: (_primaryHost, _primaryPort, primaryEnv) => ({
        REDIS_PASSWORD: primaryEnv.REDIS_PASSWORD || "",
        PRIMARY_HOST: _primaryHost,
        PRIMARY_PORT: String(_primaryPort),
      }),
      makeReplicaCmd: (primaryHost, primaryPort, primaryEnv) => {
        const args = [
          "redis-server",
          "--replicaof", primaryHost, String(primaryPort),
          "--requirepass", primaryEnv.REDIS_PASSWORD || "",
        ];
        if (primaryEnv.REDIS_PASSWORD) {
          args.push("--masterauth", primaryEnv.REDIS_PASSWORD);
        }
        return args;
      },
      replicaHealthCmd: "redis-cli ping",
    },
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
    replication: {
      supported: true,
      primaryExtraCmd: ["--replSet", "rs0", "--bind_ip_all", "--keyFile", "/etc/mongo-keyfile"],
      makeReplicaEnv: (_primaryHost, _primaryPort, primaryEnv) => ({
        MONGO_INITDB_ROOT_USERNAME: primaryEnv.MONGO_INITDB_ROOT_USERNAME || "",
        MONGO_INITDB_ROOT_PASSWORD: primaryEnv.MONGO_INITDB_ROOT_PASSWORD || "",
        PRIMARY_HOST: _primaryHost,
        PRIMARY_PORT: String(_primaryPort),
      }),
      makeReplicaCmd: () => [
        "mongod", "--replSet", "rs0", "--bind_ip_all", "--keyFile", "/etc/mongo-keyfile",
      ],
      replicaHealthCmd: "mongosh --quiet --eval \"rs.status().ok\"",
    },
  },
};

export function getCatalogEntry(type: string): ServiceDefinition | undefined {
  return SERVICE_CATALOG[type];
}

export function getCatalogEntries(): ServiceDefinition[] {
  return Object.values(SERVICE_CATALOG);
}
