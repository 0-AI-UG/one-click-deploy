/** Small fetch-based client for OCD's scoped object-storage authorization API. */
export class OcdStorageClient {
  constructor(private endpoint: string, private token: string) {
    if (new URL(endpoint).protocol !== "https:" || !token) throw new Error("OCD storage requires an HTTPS endpoint and token");
  }

  private async api(body: Record<string, unknown>): Promise<any> {
    const response = await fetch(this.endpoint, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`OCD storage authorization failed (${response.status})`);
    return response.json();
  }

  async presign(key: string, options: { method?: string; expiresIn?: number; type?: string; sha256?: string } = {}): Promise<{ url: string; headers: Record<string, string> }> {
    const result = await this.api({ key, method: options.method ?? "GET", expiresIn: options.expiresIn ?? 300,
      contentType: options.type, sha256: options.sha256 });
    if (typeof result.url !== "string" || new URL(result.url).protocol !== "https:") throw new Error("Invalid storage authorization");
    return { url: result.url, headers: result.headers ?? {} };
  }

  private async request(method: string, key: string, body?: BodyInit, type?: string, sha256?: string): Promise<Response> {
    const signed = await this.presign(key, { method, type, sha256 });
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await fetch(signed.url, { method, body, headers: signed.headers, redirect: "manual", signal: AbortSignal.timeout(120_000) });
      if (!["GET", "HEAD"].includes(method) || ![429, 502, 503, 504].includes(response.status) || attempt >= 2) break;
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
    if (!response.ok && response.status !== 404) {
      await response.body?.cancel();
      throw new Error(`Object storage request failed (${response.status})`);
    }
    return response;
  }

  async open(key: string): Promise<Response | null> {
    const response = await this.request("GET", key);
    if (response.status === 404) { await response.body?.cancel(); return null; }
    return response;
  }

  file(key: string) {
    const self = this;
    return {
      async exists() {
        const response = await self.request("HEAD", key);
        return response.status !== 404;
      },
      async stat() {
        const response = await self.request("HEAD", key);
        if (response.status === 404) throw Object.assign(new Error("Object not found"), { code: "NoSuchKey", name: "NoSuchKey" });
        return { size: Number(response.headers.get("content-length") ?? 0), type: response.headers.get("content-type") ?? "application/octet-stream",
          etag: response.headers.get("etag") ?? "", lastModified: new Date(response.headers.get("last-modified") ?? 0),
          sha256: response.headers.get("x-amz-meta-sha256") ?? undefined };
      },
      async text() {
        const response = await self.open(key);
        if (!response) throw new Error("Object not found");
        return response.text();
      },
      stream() {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        return new ReadableStream<Uint8Array>({
          async start() {
            const response = await self.open(key);
            if (!response?.body) throw new Error("Object not found");
            reader = response.body.getReader();
          },
          async pull(controller) {
            const chunk = await reader!.read();
            if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
          },
          async cancel(reason) { await reader?.cancel(reason); },
        });
      },
    };
  }

  async write(key: string, data: string | Uint8Array | Blob, options: { type?: string; sha256?: string } = {}): Promise<number> {
    const blob = data instanceof Blob ? data : new Blob([typeof data === "string" ? data : new Uint8Array(data).buffer]);
    const response = await this.request("PUT", key, blob, options.type ?? "application/octet-stream", options.sha256);
    if (!response.ok) throw new Error("Object upload failed");
    await response.body?.cancel();
    return blob.size;
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    await response.body?.cancel();
  }

  async list(input: { prefix?: string; maxKeys?: number; continuationToken?: string } = {}): Promise<{
    contents?: Array<{ key?: string }>; isTruncated?: boolean; nextContinuationToken?: string;
  }> {
    return this.api({ method: "LIST", prefix: input.prefix ?? "", continuationToken: input.continuationToken });
  }
}
