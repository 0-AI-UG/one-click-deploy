import { describe, expect, test } from "bun:test";
import {
  DeployManifestSchema,
  StackManifestSchema,
} from "../../shared/manifest-schema.ts";
import { renderSkillFiles } from "./content.ts";

describe("embedded OCD skill", () => {
  test("is concise, renderable, and contains every top-level app manifest field", () => {
    const files = Object.fromEntries(
      renderSkillFiles("https://panel.example.com/").map((file) => [
        file.path,
        file.contents,
      ]),
    );
    const skill = files["SKILL.md"];
    const reference = files["reference.md"];

    expect(skill).toBeDefined();
    expect(reference).toBeDefined();
    expect(skill.split(/\s+/).filter(Boolean).length).toBeLessThan(1_200);
    expect(skill.split("\n").length).toBeLessThan(200);
    expect(skill).toMatch(/^---\nname: ocd-deploy\ndescription: .+\n---\n/);
    expect(reference).toContain(
      "curl -fsSL https://panel.example.com/cli/install.sh | sh",
    );
    expect(skill).toContain(
      "curl -fsSL https://panel.example.com/cli/install.sh | sh",
    );
    expect(skill).not.toContain("{{PANEL_URL}}");
    expect(reference).not.toContain("{{PANEL_URL}}");

    const documentedTokens = [
      ...reference.matchAll(/`([^`]+)`/g),
    ].map((match) => match[1]);
    for (const field of Object.keys(DeployManifestSchema.shape)) {
      expect(
        documentedTokens.some(
          (token) =>
            token === field ||
            token.startsWith(`${field}.`) ||
            token.startsWith(`${field}[`),
        ),
      ).toBe(true);
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
