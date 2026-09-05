import { expect, test } from "bun:test";
import { presignObject, validObjectKey } from "./presign.ts";

test("signature agrees with the AWS Smithy signer for encoded paths and signed content type", () => {
  const signed = presignObject({ credentials: { accessKey: "AKIDEXAMPLE", secretKey: "test-secret", region: "nbg1", endpoint: "https://s3.example.com" },
    bucket: "test-bucket", key: "folder/a b.txt", method: "PUT", contentType: "text/plain", expiresIn: 300, now: new Date("2026-09-05T10:00:00Z") });
  expect(new URL(signed.url).searchParams.get("X-Amz-Signature")).toBe("f538abb0f8791f0a10c43bcb2839286c532a5fd0e1d592fcea64c69705d64d70");
  expect(signed.headers).toEqual({ "content-type": "text/plain" });
  expect(signed.url).not.toContain("test-secret");
});

test("keys cannot normalize out of their assigned prefix", () => {
  for (const key of ["../secret", "a/../secret", "/secret", "a\\secret", "a\nsecret", "a/./secret", ""]) expect(validObjectKey(key)).toBe(false);
  expect(validObjectKey("uploads/photo.webp")).toBe(true);
});
