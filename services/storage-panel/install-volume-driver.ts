const path = "/app/src/shared/app-config.ts";
const source = await Bun.file(path).text();
const anchor = '    volume_id: supplied.volume_id ?? "",';
if (!source.includes(anchor) || source.includes("volume_driver: supplied.volume_driver")) throw new Error("Unexpected base config normalizer");
await Bun.write(path, source.replace(anchor, anchor + '\n    volume_driver: supplied.volume_driver ?? app.desired_volume_driver ?? undefined,'));
