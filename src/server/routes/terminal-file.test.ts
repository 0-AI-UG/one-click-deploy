import { expect, test } from "bun:test";
import { fileReadScript } from "./terminal-file.ts";

test("file read command does not interpolate the remote path", () => {
  const remotePath = "/tmp/file with spaces; echo unsafe";
  const script = fileReadScript(remotePath);
  expect(script).not.toContain(remotePath);
  expect(script).toContain(Buffer.from(remotePath).toString("base64"));
  expect(script).toEndWith('exec cat -- "$path"');
});
