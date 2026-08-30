import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  BUILD_PLATFORM,
  buildxBuildCommand,
  operationImageTag,
  registryBuildCacheRef,
} from "../engine/build-worker.ts";

const RUN = process.env.RUN_BUILD_COMPONENT === "1";
const suite = RUN ? describe : describe.skip;
const registry = process.env.OCD_TEST_REGISTRY || "localhost:5000";
let fixture = "";

async function command(command: string): Promise<string> {
  const child = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command}\n${stderr || stdout}`);
  return `${stdout}\n${stderr}`;
}

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

suite("registry-backed build component", () => {
  test("pushes a pinned platform, exports reusable cache, and verifies the immutable digest", async () => {
    fixture = await mkdtemp(join(tmpdir(), "ocd-build-component-"));
    await writeFile(join(fixture, "Dockerfile"), "FROM scratch\nCOPY payload.txt /payload.txt\n");
    await writeFile(join(fixture, "payload.txt"), "component-test\n");

    const commit = "a".repeat(40);
    const image = `${registry}/ocd/component`;
    const tag = operationImageTag(image, Date.now(), commit);
    const metadataFile = join(fixture, "metadata.json");
    const build = buildxBuildCommand({
      commit,
      dockerfile: join(fixture, "Dockerfile"),
      context: fixture,
      tag,
      metadataFile,
    });

    await command(build);
    const metadata = await Bun.file(metadataFile).json() as Record<string, string>;
    const digest = metadata["containerimage.digest"] || "";
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const immutable = `${image}@${digest}`;
    const inspection = await command(`docker buildx imagetools inspect '${immutable}'`);
    expect(inspection).toContain(BUILD_PLATFORM);
    await command(`docker buildx imagetools inspect '${registryBuildCacheRef(image)}'`);

    // A second build exercises cache import as well as export against the
    // same local registry. Runtime identity remains the verified digest.
    await command(buildxBuildCommand({
      commit,
      dockerfile: join(fixture, "Dockerfile"),
      context: fixture,
      tag: operationImageTag(image, Date.now() + 1, commit),
      metadataFile: join(fixture, "metadata-second.json"),
    }));
  }, 120_000);
});
