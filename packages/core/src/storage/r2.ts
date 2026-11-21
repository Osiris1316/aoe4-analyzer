/**
 * R2 blob storage client (S3 API via aws4fetch).
 *
 * Used by Node-side pipeline scripts only (process-pending, reconcile,
 * rebuild) — NOT by the Worker, which reaches R2 through the BLOBS binding.
 * Keep this module out of the Worker import graph so aws4fetch never bundles.
 *
 * Credential surface: one R2 API token scoped to a single bucket,
 * Object Read & Write. Supplied via R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.
 */

import { AwsClient } from 'aws4fetch';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface R2PutResult {
  bytes: number;
  etag: string | null; // opaque change-token, not a verified content hash
}

export interface R2Client {
  /** Text bodies are sent as UTF-8; byte bodies (e.g. gzip) are sent as-is. */
  put(key: string, body: string | Uint8Array, contentType?: string): Promise<R2PutResult>;
  get(key: string): Promise<string | null>;
  /** Raw bytes, for binary objects such as summaries/{gameId}.json.gz. */
  getBytes(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<R2PutResult | null>;
}

/** Deterministic key scheme — hard to change after ~100k objects. Centralized here. */
export function gpdBlobKey(
  gameId: number,
  profileId: number,
  kind: 'eco' | 'non-eco' | 'unit-events',
): string {
  return `gpd/${gameId}/${profileId}/${kind}.json`;
}

/**
 * Whole-game summary exactly as aoe4world served it (camelized, NOT
 * URL-scrubbed), gzip-compressed. One object per game, written by the
 * retrieval stage BEFORE any D1 row for that game (write-ordering rule).
 *
 * Stored with Content-Type application/gzip and NO Content-Encoding header,
 * so every reader (Node fetch, the Worker binding, a browser download) gets
 * the compressed bytes and gunzips explicitly. Agreed 20 Nov 2026.
 */
export const SUMMARY_CONTENT_TYPE = 'application/gzip';

export function summaryBlobKey(gameId: number): string {
  return `summaries/${gameId}.json.gz`;
}

export function createR2Client(config: R2Config): R2Client {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: 'auto',
    service: 's3',
  });
  const base = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`;
  const urlFor = (key: string) => `${base}/${encodeURI(key)}`;

  return {
    async put(key, body, contentType = 'application/json') {
      const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
      // Copy byte bodies into a standalone Uint8Array: a Node Buffer can be a
      // view over a larger pooled ArrayBuffer, and only these bytes may be sent.
      const payload = typeof body === 'string' ? body : new Uint8Array(body);
      const res = await aws.fetch(urlFor(key), {
        method: 'PUT',
        body: payload,
        headers: { 'Content-Type': contentType },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`R2 PUT ${key} failed: ${res.status} ${res.statusText} ${detail}`);
      }
      return { bytes, etag: res.headers.get('etag') };
    },

    async get(key) {
      const res = await aws.fetch(urlFor(key), { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status} ${res.statusText}`);
      return await res.text();
    },

    async getBytes(key) {
      const res = await aws.fetch(urlFor(key), { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status} ${res.statusText}`);
      return new Uint8Array(await res.arrayBuffer());
    },

    async head(key) {
      const res = await aws.fetch(urlFor(key), { method: 'HEAD' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 HEAD ${key} failed: ${res.status} ${res.statusText}`);
      const len = res.headers.get('content-length');
      return { bytes: len ? Number(len) : 0, etag: res.headers.get('etag') };
    },
  };
}