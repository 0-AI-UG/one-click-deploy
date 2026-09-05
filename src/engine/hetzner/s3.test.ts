import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, test } from "bun:test";
import { saveProviderAssignments, saveProviderConnections, providerSecretKey } from "../../shared/provider-connections.ts";
import { secretStore } from "../../shared/secret-store.ts";
import {
  createBucket,
  deleteBucket,
  S3Error,
  parseListBuckets,
  signS3Request,
  validateBucketName,
  getS3Credentials,
  type S3Credentials,
} from "../object-storage/s3.ts";

beforeEach(() => {
  saveProviderConnections([]);
  saveProviderAssignments({ infrastructure: "", object_storage: "" });
});

const credentials: S3Credentials = {
  accessKey: "AKIDEXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "fsn1",
  endpoint: "https://fsn1.your-objectstorage.com",
};

describe("S3 SigV4", () => {
  test("signs a deterministic regional S3 request without exposing the secret", () => {
    const signed = signS3Request({
      method: "GET",
      path: "/",
      credentials,
      now: new Date("2026-09-01T12:34:56Z"),
    });
    expect(signed.url).toBe("https://fsn1.your-objectstorage.com/");
    expect(signed.headers["x-amz-date"]).toBe("20260901T123456Z");
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260901/fsn1/s3/aws4_request, " +
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
      "Signature=b3949db59d0ea1e3a0e00a745190e9b41b7d4fe46ac3f5cf67ceb95c83c08bbe",
    );
    expect(JSON.stringify(signed)).not.toContain(credentials.secretKey);
  });

  test("includes private ACL in the signed create-bucket request", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await createBucket("ocd-assets", credentials, fetcher);
    expect(request?.url).toBe("https://fsn1.your-objectstorage.com/ocd-assets");
    expect(request?.init?.method).toBe("PUT");
    expect((request?.init?.headers as Record<string, string>)["x-amz-acl"]).toBe("private");
    expect((request?.init?.headers as Record<string, string>).authorization).toContain("x-amz-acl");
  });
});

describe("S3 bucket behavior", () => {
  test("parses and sorts ListBuckets XML", () => {
    const xml = `<?xml version="1.0"?><ListAllMyBucketsResult><Buckets>
      <Bucket><Name>zeta</Name><CreationDate>2026-08-01T10:00:00Z</CreationDate></Bucket>
      <Bucket><Name>alpha&amp;archive</Name><CreationDate>2026-07-01T10:00:00Z</CreationDate></Bucket>
    </Buckets></ListAllMyBucketsResult>`;
    expect(parseListBuckets(xml, credentials)).toEqual([
      { name: "alpha&archive", createdAt: "2026-07-01T10:00:00Z", region: "fsn1", endpoint: "https://fsn1.your-objectstorage.com" },
      { name: "zeta", createdAt: "2026-08-01T10:00:00Z", region: "fsn1", endpoint: "https://fsn1.your-objectstorage.com" },
    ]);
  });

  test("refuses unsafe bucket names before network I/O", () => {
    expect(validateBucketName("UPPER_case").valid).toBe(false);
    expect(validateBucketName("192.168.0.1").valid).toBe(false);
    expect(validateBucketName("good-bucket.name")).toEqual({ valid: true, value: "good-bucket.name" });
  });

  test("surfaces non-empty deletion without recursively deleting data", async () => {
    const fetcher = (async () => new Response(
      "<Error><Code>BucketNotEmpty</Code><Message>The bucket is not empty</Message></Error>",
      { status: 409 },
    )) as unknown as typeof fetch;
    let error: unknown;
    try {
      await deleteBucket("ocd-assets", credentials, fetcher);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(S3Error);
    expect((error as S3Error).code).toBe("BucketNotEmpty");
    expect((error as Error).message).toContain("never recursively deletes objects");
  });
});

describe("S3 provider selection", () => {
  test("loads credentials only from the assigned S3-compatible profile", async () => {
    saveProviderConnections([{
      id: "s3-main",
      kind: "s3-compatible",
      name: "Any S3 provider",
      config: { endpoint: credentials.endpoint, region: credentials.region },
      created_at: "2026-09-04T00:00:00.000Z",
    }]);
    saveProviderAssignments({ infrastructure: "", object_storage: "s3-main" });
    await secretStore.set(providerSecretKey("s3-main", "access_key"), credentials.accessKey);
    await secretStore.set(providerSecretKey("s3-main", "secret_key"), credentials.secretKey);
    expect(await getS3Credentials()).toEqual(credentials);
  });

  test("returns null when object storage has no assigned provider", async () => {
    expect(await getS3Credentials()).toBeNull();
  });
});
