import { describe, expect, test } from "bun:test";
import { posix } from "node:path";
import {
  DeployManifestSchema,
  StackManifestSchema,
} from "../../shared/manifest-schema.ts";
import { renderSkillFiles } from "./content.ts";

describe("embedded OCD skill", () => {
  test("has a concise routed overview and a renderable multi-file manual", () => {
    const files = Object.fromEntries(
      renderSkillFiles("https://panel.example.com/").map((file) => [
        file.path,
        file.contents,
      ]),
    );
    const skill = files["SKILL.md"];
    const reference = files["reference.md"];
    const appManifest = files["docs/app-manifest.md"];
    const stackManifest = files["docs/stack-manifest.md"];
    const cli = files["docs/cli-reference.md"];

    expect(skill).toBeDefined();
    expect(reference).toBeDefined();
    expect(appManifest).toBeDefined();
    expect(stackManifest).toBeDefined();
    expect(cli).toBeDefined();
    expect(skill.split(/\s+/).filter(Boolean).length).toBeLessThan(1_200);
    expect(skill.split("\n").length).toBeLessThan(200);
    expect(skill).toMatch(/^---\nname: ocd-deploy\ndescription: .+\n---\n/);
    expect(skill).not.toContain("{{PANEL_URL}}");
    for (const command of [
      "ocd app show <app> [--storage]",
      "ocd manifest validate [path] [--allow-unknown]",
      "ocd gc [--server=<name|id|ip>] [--execute]",
      "ocd ops logs <id> [--tail N] [--since TIME|CURSOR] [--child NAME|ID]",
      "[--phase STEP] [--follow]",
    ]) {
      expect(skill).toContain(command);
    }
    for (const contents of Object.values(files)) {
      expect(contents).not.toContain("{{PANEL_URL}}");
    }

    for (const field of Object.keys(DeployManifestSchema.shape)) {
      expect(appManifest).toContain(`\`${field}\``);
    }
    expect(appManifest).toContain("`environment`");
    expect(appManifest).toContain("`autoscaling`");
    expect(appManifest).toContain("`build`");
    expect(appManifest).toContain("`container_port`");
    expect(appManifest).toContain("Dockerfile");
    expect(appManifest).not.toContain("`image.ref`");

    const documentedStackTokens = [
      ...stackManifest.matchAll(/`([^`]+)`/g),
    ].map((match) => match[1]);
    for (const field of Object.keys(StackManifestSchema.shape)) {
      expect(
        documentedStackTokens.some(
          (token) =>
            token === field ||
            token.startsWith(`${field}.`) ||
            token.startsWith(`${field}[`),
        ),
      ).toBe(true);
    }

    const overviewLinks = [...skill.matchAll(/\]\(([^)#]+\.md)\)/g)].map((m) => m[1]);
    for (const link of overviewLinks) {
      expect(files[link]).toBeDefined();
    }
    expect(files["docs/infrastructure-and-enrollment.md"]).toContain("ocd servers connect");
    expect(files["docs/build-workers-and-webhooks.md"]).toContain("consumes no Actions minutes");
    expect(files["docs/build-workers-and-webhooks.md"]).toContain("untrusted forks");
    expect(files["docs/build-workers-and-webhooks.md"]).toContain("X-Hub-Signature-256");
    expect(files["docs/immutable-images-and-health.md"]).toContain("OCI credential");
    expect(Object.keys(files).filter((path) => path.startsWith("docs/"))).toHaveLength(15);
  });

  test("documents the unified desired-configuration surface", () => {
    const files = Object.fromEntries(
      renderSkillFiles("https://panel.example.com").map((file) => [
        file.path,
        file.contents,
      ]),
    );
    const cli = files["docs/cli-reference.md"];
    for (const command of [
      "deploy", "release", "apps", "logs", "restart", "rollback", "promote", "pause",
      "unpause", "envs", "stack", "ops", "servers",
      "ssh", "app", "scale", "resources", "volumes", "runners",
    ]) {
      expect(cli).toContain(`ocd ${command}`);
    }
    for (const flag of [
      "--dry-run", "--config-only", "--auth-password-env", "--server", "--set",
      "--tail", "--since", "--app",
    ]) {
      expect(cli).toContain(flag);
    }
    for (const removed of [
      "ocd config", "ocd redeploy", "ocd envs attach", "ocd envs detach",
      "ocd scale policy set", "ocd app webhook enable",
      "ocd app webhook set", "ocd app webhook disable",
      "ocd webhook plan", "ocd deploy --image", "--image=MEMBER",
      "ocd service", "managed service",
    ]) {
      expect(cli).not.toContain(removed);
    }
    expect(cli).toContain("ocd release <app> --image <repository@sha256:digest>");
    expect(cli).toContain("ocd promote --from=<source-app> --to=<destination-app>");
    expect(cli).toContain("ocd rollback <app> [--deployment=<id>]");
    expect(cli).toContain("ocd runners webhook-secret <source-id>");
    expect(cli).toContain("ocd app redeploy <app>");
    expect(files["docs/app-manifest.md"]).toContain("`image_repository`");
    expect(files["docs/app-manifest.md"]).not.toContain("`image`: OCI repository");
  });

  test("documents OCD-owned builds and immutable runtime artifacts", () => {
    const files = renderSkillFiles("https://panel.example.com");
    const manual = files
      .filter((file) => file.path.endsWith(".md"))
      .map((file) => file.contents)
      .join("\n");

    for (const removed of ["cache_ref", "git_branch", "wait_for_ci", "runs-on: [self-hosted"] ) {
      expect(manual.toLowerCase()).not.toContain(removed.toLowerCase());
    }
    expect(manual).toContain("repository@sha256:<digest>");
    expect(manual).toContain("OCD build worker");
    expect(manual).toContain("GitHub push webhook");
    expect(files.find((file) => file.path === "docs/build-workers-and-webhooks.md")?.contents).toContain("docker buildx");
  });

  test("documents private pull credentials and explicit staging boundaries", () => {
    const files = Object.fromEntries(
      renderSkillFiles("https://panel.example.com").map((file) => [
        file.path,
        file.contents,
      ]),
    );
    const images = files["docs/immutable-images-and-health.md"];
    const releases = files["docs/releases-promotion-and-rollback.md"];
    const stack = files["docs/stack-manifest.md"];

    expect(images).toContain("Admin Settings");
    expect(images).toContain("OCI credential");
    expect(images).toContain("runtime pulls");
    expect(releases).toContain("Staging is a separately deployed app");
    expect(releases).toContain("ocd promote --from=api-staging --to=api");
    expect(stack).toContain("does not synthesize staging siblings");
    expect(stack).toContain("Create staging apps separately");
  });

  test("has no broken local markdown links", () => {
    const files = Object.fromEntries(
      renderSkillFiles("https://panel.example.com").map((file) => [
        file.path,
        file.contents,
      ]),
    );
    for (const [path, contents] of Object.entries(files)) {
      if (!path.endsWith(".md")) continue;
      for (const match of contents.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
        const resolved = posix.normalize(posix.join(posix.dirname(path), target));
        if (target.endsWith("/")) {
          const directory = resolved.replace(/\/+$/, "");
          expect(
            Object.keys(files).some((file) => file.startsWith(`${directory}/`)),
            `${path} links to missing directory ${directory}/`,
          ).toBe(true);
          continue;
        }
        expect(files[resolved], `${path} links to missing ${resolved}`).toBeDefined();
      }
    }
  });

  test("ships schema-valid examples with resolvable stack references", () => {
    const files = Object.fromEntries(
      renderSkillFiles("https://panel.example.com").map((file) => [
        file.path,
        file.contents,
      ]),
    );

    for (const [path, contents] of Object.entries(files)) {
      if (!path.endsWith(".json")) continue;
      const parsed = JSON.parse(contents);
      if (path.endsWith("ocd-stack.json")) {
        const stack = StackManifestSchema.parse(parsed);
        const stackDir = path.slice(0, path.lastIndexOf("/"));
        for (const app of Object.values(stack.apps)) {
          expect(files[`${stackDir}/${app.manifest}`]).toBeDefined();
        }
        expect(stack.apps.web?.env).toEqual(["API_URL", "NODE_ENV"]);
        expect(stack.apps.web?.env).not.toContain("DATABASE_URL");
      } else {
        DeployManifestSchema.parse(parsed);
      }
    }
  });
});
