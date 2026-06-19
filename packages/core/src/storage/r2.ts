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
  put(key: string, body: string, contentType?: string): Promise<R2PutResult>;
  get(key: string): Promise<string | null>;
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
      const bytes = Buffer.byteLength(body, 'utf8');
      const res = await aws.fetch(urlFor(key), {
        method: 'PUT',
        body,
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

    async head(key) {
      const res = await aws.fetch(urlFor(key), { method: 'HEAD' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 HEAD ${key} failed: ${res.status} ${res.statusText}`);
      const len = res.headers.get('content-length');
      return { bytes: len ? Number(len) : 0, etag: res.headers.get('etag') };
    },
  };
}