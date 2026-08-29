// Bun's mock.module() registry is process-wide and survives between test files.
// Several route and engine suites intentionally replace the same modules, so a
// shared worker makes otherwise-independent tests depend on file order. Run one
// file per child process while keeping a small bounded amount of parallelism.

import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = Array.from(
  new Bun.Glob("**/*.test.ts").scanSync({ cwd: `${root}src`, onlyFiles: true }),
  (file) => `src/${file}`,
).filter((file) => !file.startsWith("src/integration/")).sort();

const requestedConcurrency = Number.parseInt(process.env.OCD_TEST_CONCURRENCY || "4", 10);
const concurrency = Math.max(1, Math.min(Number.isFinite(requestedConcurrency) ? requestedConcurrency : 4, files.length));
const failures: string[] = [];
let nextFile = 0;

// Unit tests must never become live provider tests just because the caller has
// credentials (including from Bun's automatic .env loading) in their shell.
// The explicit test:integration scripts bypass this runner and opt in.
const childEnv = { ...Bun.env };
childEnv.RUN_INTEGRATION = "0";
childEnv.RUN_ENGINE_INTEGRATION = "0";
childEnv.HCLOUD_TOKEN = "";

async function runFile(file: string): Promise<number> {
  const child = Bun.spawn(["bun", "test", file], {
    cwd: root,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exitCode === 0) {
    console.log(`[pass] ${file}`);
  } else {
    console.error(`\n[fail] ${file}`);
    if (stdout) processOutput(stdout, false);
    if (stderr) processOutput(stderr, true);
  }
  return exitCode;
}

function processOutput(output: string, error: boolean): void {
  (error ? process.stderr : process.stdout).write(output);
  if (!output.endsWith("\n")) (error ? process.stderr : process.stdout).write("\n");
}

async function worker(): Promise<void> {
  while (true) {
    const index = nextFile++;
    if (index >= files.length) return;
    const file = files[index]!;
    if ((await runFile(file)) !== 0) failures.push(file);
  }
}

console.log(`[test] ${files.length} files, ${concurrency} isolated processes`);
await Promise.all(Array.from({ length: concurrency }, () => worker()));

if (failures.length > 0) {
  console.error(`\n[test] ${failures.length} file(s) failed:`);
  for (const file of failures.sort()) console.error(`  - ${file}`);
  process.exit(1);
}

console.log(`\n[test] all ${files.length} files passed`);
