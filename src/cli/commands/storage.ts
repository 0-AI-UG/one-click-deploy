import { writeFile } from "node:fs/promises";
import { del, get, post } from "../api.ts";
import { table } from "../format.ts";

type Grant = { providerId: string; binding?: string; id: string; app: string; bucket: string; prefix: string; methods: string[]; createdAt: string };

export async function storage(args: string[]): Promise<void> {
  if (!args[0] || args[0] === "list") {
    const grants = await get<Grant[]>("/api/admin/storage-grants");
    table(["ID", "APP", "BINDING", "CONNECTION", "BUCKET", "PREFIX", "METHODS"], grants.map(grant => [grant.id, grant.app, grant.binding ?? "manual", grant.providerId, grant.bucket, grant.prefix, grant.methods.join(",")]));
    return;
  }
  if (args[0] === "revoke" && args[1]) {
    await del("/api/admin/storage-grants", { id: args[1] });
    console.log("Storage token revoked. Previously issued object URLs expire within one hour.");
    return;
  }
  if (args[0] === "grant") {
    const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
    const tokenFile = option("token-file");
    if (!args[1] || !args[2] || !tokenFile) throw new Error("Usage: ocd storage grant <app> <bucket> --prefix=path/ --token-file=/private/path [--methods=GET,HEAD,PUT,DELETE,LIST]");
    const grant = await post<Grant & { token: string }>("/api/admin/storage-grants", {
      storage: option("storage"), app: args[1], bucket: args[2], prefix: option("prefix") ?? "",
      methods: (option("methods") ?? "GET,HEAD,PUT,DELETE,LIST").split(","),
    });
    try { await writeFile(tokenFile, grant.token, { mode: 0o600, flag: "wx" }); }
    catch (error) { await del("/api/admin/storage-grants", { id: grant.id }); throw error; }
    console.log(`Created storage grant ${grant.id}. Token saved to ${tokenFile} (0600); store it as an OCD environment secret.`);
    return;
  }
  throw new Error("Usage: ocd storage <list|grant|revoke>");
}
