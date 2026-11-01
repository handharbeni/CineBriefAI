// S3-compatible storage adapter implementing StorageProvider from @clipforge/core.
// Zero-dependency AWS SigV4 signing via node:crypto — works with AWS S3,
// MinIO, Cloudflare R2, Backblaze B2. No fake URLs: every op hits the real endpoint.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { StorageProvider } from '@clipforge/core';

export interface S3Config {
  endpoint: string; // e.g. https://s3.us-east-1.amazonaws.com or http://minio:9000
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean; // MinIO needs true
  publicBaseUrl?: string; // CDN/bucket public URL prefix for put() return value
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const h = (k: Buffer | string, data: string) => createHmac('sha256', k).update(data).digest('hex');
const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export class S3StorageProvider implements StorageProvider {
  readonly id = 's3';
  private cfg: S3Config;

  constructor(cfg: S3Config) {
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
      throw new Error('S3StorageProvider incomplete config (endpoint/bucket/keys). See docs/providers.md — no fake storage.');
    }
    this.cfg = cfg;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): S3StorageProvider {
    return new S3StorageProvider({
      endpoint: env.S3_ENDPOINT ?? 'https://s3.amazonaws.com',
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? '',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      publicBaseUrl: env.S3_PUBLIC_BASE_URL,
    });
  }

  private objectUrl(key: string): URL {
    const base = this.cfg.endpoint.replace(/\/$/, '');
    const path = this.cfg.forcePathStyle
      ? `/${this.cfg.bucket}/${key.replace(/^\//, '')}`
      : `/${key.replace(/^\//, '')}`;
    const url = new URL(base + encodeURI(path));
    if (!this.cfg.forcePathStyle) url.hostname = `${this.cfg.bucket}.${url.hostname}`;
    return url;
  }

  /** SigV4 sign a request; returns headers to attach. */
  private signHeaders(
    method: string,
    url: URL,
    payloadHash: string,
    extraHeaders: Record<string, string> = {},
  ): Record<string, string> {
    const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const host = url.host;
    const headers: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...extraHeaders,
    };
    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k].trim()}\n`).join('');
    const signedHeaders = sortedKeys.join(';');
    const canonicalUri = decodeURIComponent(url.pathname)
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    const canonicalQuery = [...url.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const canonicalReq = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credScope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credScope}\n${sha256hex(canonicalReq)}`;
    const kDate = h(`AWS4${this.cfg.secretAccessKey}`, dateStamp);
    const kRegion = createHmac('sha256', Buffer.from(kDate, 'hex')).update(this.cfg.region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return headers;
  }

  async exists(key: string): Promise<boolean> {
    const url = this.objectUrl(key);
    const res = await fetch(url.toString(), {
      method: 'HEAD',
      headers: this.signHeaders('HEAD', url, EMPTY_SHA256),
    });
    if (res.status === 404 || res.status === 403) return false;
    if (!res.ok) throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
    return true;
  }

  async put(key: string, filePath: string, contentType = 'application/octet-stream'): Promise<string> {
    const url = this.objectUrl(key);
    const size = statSync(filePath).size;
    const headers = this.signHeaders('PUT', url, 'UNSIGNED-PAYLOAD', { 'content-type': contentType });
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: { ...headers, 'content-length': String(size) },
      body: createReadStream(filePath) as any,
      duplex: 'half',
    } as RequestInit);
    if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    if (this.cfg.publicBaseUrl) {
      return `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/${key.replace(/^\//, '')}`;
    }
    return this.signedUrl(key, 3600);
  }

  async get(key: string, destPath: string): Promise<void> {
    const url = this.objectUrl(key);
    const res = await fetch(url.toString(), {
      headers: this.signHeaders('GET', url, EMPTY_SHA256),
    });
    if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status}`);
    const { createWriteStream } = await import('node:fs');
    await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(destPath));
  }

  /** Presigned GET URL (query-string SigV4) valid for ttlS seconds. */
  async signedUrl(key: string, ttlS = 900): Promise<string> {
    const url = this.objectUrl(key);
    const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credScope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
    url.searchParams.set('X-Amz-Credential', `${this.cfg.accessKeyId}/${credScope}`);
    url.searchParams.set('X-Amz-Date', amzDate);
    url.searchParams.set('X-Amz-Expires', String(ttlS));
    url.searchParams.set('X-Amz-SignedHeaders', 'host');
    const canonicalQuery = [...url.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const canonicalUri = decodeURIComponent(url.pathname)
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    const canonicalReq = `GET\n${canonicalUri}\n${canonicalQuery}\nhost:${url.host}\n\nhost\nUNSIGNED-PAYLOAD`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credScope}\n${sha256hex(canonicalReq)}`;
    const kDate = h(`AWS4${this.cfg.secretAccessKey}`, dateStamp);
    const kRegion = createHmac('sha256', Buffer.from(kDate, 'hex')).update(this.cfg.region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    url.searchParams.set('X-Amz-Signature', signature);
    return url.toString();
  }
}

export { pipeline };
