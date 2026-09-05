const path = "/app/src/shared/db/servers.ts";
let source = await Bun.file(path).text();
const pattern = /"SELECT \* FROM servers([^"\n]*)"/g;
const matches = [...source.matchAll(pattern)];
if (matches.length < 3 || source.includes("serverReadColumns")) throw new Error("Unexpected server getter layout");
source = source.replace('import db from "./connection.ts";', `import db from "./connection.ts";
// Read either schema during rolling upgrades without changing stored addresses.
const serverReadColumns = (db.query("PRAGMA table_info(servers)").all() as Array<{ name: string }>).
  some(column => column.name === "routing_address") ? "*, routing_address AS private_ipv4" : "*";`);
source = source.replace(pattern, (_, suffix) => "`SELECT ${serverReadColumns} FROM servers" + suffix + "`");
await Bun.write(path, source);
