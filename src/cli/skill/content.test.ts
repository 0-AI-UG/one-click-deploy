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
    for (const contents of Object.values(files)) {
      expect(contents).not.toContain("{{PANEL_URL}}");
    }

    for (const field of Object.keys(DeployManifestSchema.shape)) {
      expect(appManifest).toContain(`\`${field}\``);
    }
    expect(appManifest).toContain("`environment`");
    expect(appManifest).toContain("`autoscaling`");
    expect(appManifest).toContain("`webhook.staging_environment`");

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
    expect(Object.keys(files).filter((path) => path.startsWith("docs/"))).toHaveLength(14);
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
      "deploy", "apps", "logs", "restart", "rollback", "promote", "pause",
      "unpause", "envs", "services", "service", "stack", "ops", "servers",
      "ssh", "app", "scale", "resources", "volumes",
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
    ]) {
      expect(cli).not.toContain(removed);
    }
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
