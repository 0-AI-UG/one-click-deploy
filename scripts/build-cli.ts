// Compile the `ocd` CLI for every supported target, injecting the version from
// package.json at build time. The compiled binary can't read package.json at
// runtime, so `OCD_CLI_VERSION` is substituted into src/cli/main.ts via
// `--define` — keeping the CLI's reported version in lockstep with the backend.
import pkg from "../package.json" with { type: "json" };

const version: string = (pkg as { version: string }).version;

const TARGETS: Array<{ target: string; outfile: string }> = [
  { target: "bun-linux-x64", outfile: "dist/cli/ocd-linux-x64" },
  { target: "bun-linux-arm64", outfile: "dist/cli/ocd-linux-arm64" },
  { target: "bun-darwin-x64", outfile: "dist/cli/ocd-darwin-x64" },
  { target: "bun-darwin-arm64", outfile: "dist/cli/ocd-darwin-arm64" },
  { target: "bun-windows-x64", outfile: "dist/cli/ocd-windows-x64.exe" },
];

for (const { target, outfile } of TARGETS) {
  console.log(`[build-cli] ${target} → ${outfile} (v${version})`);
  const proc = Bun.spawnSync(
    [
      "bun",
      "build",
      "src/cli/main.ts",
      "--compile",
      `--target=${target}`,
      "--define",
      `OCD_CLI_VERSION=${JSON.stringify(version)}`,
      "--outfile",
      outfile,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (proc.exitCode !== 0) {
    console.error(`[build-cli] failed for ${target} (exit ${proc.exitCode})`);
    process.exit(proc.exitCode ?? 1);
  }
}

console.log(`[build-cli] done — ocd v${version} for ${TARGETS.length} targets`);
