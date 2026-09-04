import { describe, expect, test } from "bun:test";
import {
  signPanelRelease,
  validatePanelRelease,
  verifyPanelReleaseSignature,
} from "./panel-release.ts";

const IMAGE = `ghcr.io/acme/panel@sha256:${"a".repeat(64)}`;
const COMMIT = "b".repeat(40);
const BODY = JSON.stringify({ image: IMAGE, commit: COMMIT });

describe("panel release webhook authentication", () => {
  test("signs the timestamp and exact raw body deterministically", () => {
    expect(signPanelRelease("test-secret", "1770000000", BODY)).toBe(
      "sha256=d2a31108c2246dca73306e682e655b9655b996729d34f7b946dbec03dc48079c",
    );
  });

  test("rejects modified payloads, timestamps, and malformed signatures", () => {
    const signature = signPanelRelease("test-secret", "1770000000", BODY);
    expect(verifyPanelReleaseSignature("test-secret", "1770000000", BODY, signature)).toBe(true);
    expect(verifyPanelReleaseSignature("test-secret", "1770000001", BODY, signature)).toBe(false);
    expect(verifyPanelReleaseSignature("test-secret", "1770000000", `${BODY} `, signature)).toBe(false);
    expect(verifyPanelReleaseSignature("test-secret", "1770000000", BODY, "sha256=short")).toBe(false);
  });
});

describe("panel release validation", () => {
  test("accepts a full commit and immutable digest from the current repository", () => {
    expect(validatePanelRelease({ image: IMAGE, commit: COMMIT }, IMAGE)).toEqual({
      valid: true,
      image: IMAGE,
      commit: COMMIT,
    });
  });

  test("accepts a migration to the canonical panel image repository", () => {
    const canonical = `ghcr.io/0-ai-ug/open-cli-deployment@sha256:${"c".repeat(64)}`;
    expect(validatePanelRelease({ image: canonical, commit: COMMIT }, IMAGE)).toEqual({
      valid: true,
      image: canonical,
      commit: COMMIT,
    });
  });

  test("rejects tags, abbreviated commits, and repository changes", () => {
    expect(validatePanelRelease({ image: "ghcr.io/acme/panel:latest", commit: COMMIT }, IMAGE)).toEqual({
      valid: false,
      error: "image must be an immutable OCI reference",
    });
    expect(validatePanelRelease({ image: IMAGE, commit: "abc1234" }, IMAGE)).toEqual({
      valid: false,
      error: "commit must be a full 40-character Git SHA",
    });
    expect(validatePanelRelease({ image: `ghcr.io/acme/other@sha256:${"c".repeat(64)}`, commit: COMMIT }, IMAGE)).toEqual({
      valid: false,
      error: "release image repository does not match the current panel",
    });
  });
});
