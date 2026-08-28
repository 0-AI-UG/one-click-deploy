import { describe, expect, test } from "bun:test";
import {
  GITHUB_RUNNER_VERSION,
  buildInstallGitHubRunnerScript,
  buildRemoveGitHubRunnerScript,
  normalizeGitHubRunnerName,
  normalizeGitHubRunnerScope,
  validGitHubRunnerToken,
} from "./github-runner.ts";

describe("GitHub Actions runner installer", () => {
  test("accepts only bounded github.com organization or repository scopes", () => {
    expect(normalizeGitHubRunnerScope("https://github.com/0-AI-UG/"))
      .toBe("https://github.com/0-AI-UG");
    expect(normalizeGitHubRunnerScope("https://github.com/0-AI-UG/private-repo"))
      .toBe("https://github.com/0-AI-UG/private-repo");
    expect(normalizeGitHubRunnerScope("http://github.com/0-AI-UG")).toBeNull();
    expect(normalizeGitHubRunnerScope("https://evil.example/0-AI-UG")).toBeNull();
    expect(normalizeGitHubRunnerScope("https://github.com/a/b/c")).toBeNull();
  });

  test("validates runner identity and short-lived tokens", () => {
    expect(normalizeGitHubRunnerName("OCD-Build-1")).toBe("ocd-build-1");
    expect(normalizeGitHubRunnerName("bad runner")).toBeNull();
    expect(validGitHubRunnerToken("A1_b-".repeat(6))).toBe(true);
    expect(validGitHubRunnerToken("too-short")).toBe(false);
  });

  test("pins official x64 and arm64 archives by checksum and installs one hardened service", () => {
    const token = "Registration_Token_1234567890";
    const script = buildInstallGitHubRunnerScript({
      scopeUrl: "https://github.com/0-AI-UG",
      registrationToken: token,
      runnerName: "ocd-build-1",
    });
    expect(script).toContain(`releases/download/v${GITHUB_RUNNER_VERSION}/$runner_archive`);
    expect(script).toContain("70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613");
    expect(script).toContain("9b1dc70626422526e3c94767cf024896beb15da5342a3f4819bf2feac13e0393");
    expect(script).toContain("sha256sum -c -");
    expect(script).toContain("--labels ocd-builder");
    expect(script).toContain("ocd-github-runner.service");
    expect(script).not.toContain("/releases/latest");
    expect(script).not.toContain("set -x");
  });

  test("removal fails closed through GitHub's deregistration command", () => {
    const script = buildRemoveGitHubRunnerScript("Removal_Token_123456789012345");
    expect(script).toContain("./config.sh remove --token");
    expect(script).toContain("systemctl start ocd-github-runner.service");
    expect(script.indexOf("./config.sh remove --token")).toBeLessThan(script.indexOf("rm -rf -- /opt/ocd-actions-runner"));
  });
});
