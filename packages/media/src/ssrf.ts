// Strict SSRF protection + safe URL download used by the worker for ingesting
// remote source assets. Validates scheme, resolves DNS, rejects private/link-local
// ranges (incl. cloud metadata IPs), follows redirects manually with re-validation,
// caps bytes and time. Zero external deps — pure bit math on parsed octets.
import { promises as dns } from 'node:dns';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';

/** IPv4 → 32-bit number */
function v4num(addr: string): number {
  const p = addr.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error(`Bad IPv4: ${addr}`);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
const v4inCidr = (addr: string, cidr: string) => {
  const [base, bitsS] = cidr.split('/');
  const bits = Number(bitsS);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (v4num(addr) & mask) === (v4num(base) & mask);
};

const PRIVATE_V4_CIDRS = [
  '0.0.0.0/8',        // this-network
  '10.0.0.0/8',
  '100.64.0.0/10',    // CGNAT
  '127.0.0.0/8',      // loopback
  '169.254.0.0/16',   // link-local incl. 169.254.169.254 cloud metadata
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',      // multicast
  '240.0.0.0/4',      // reserved / broadcast
];

/** IPv6 → two 32-bit halves */
function v6parts(addr: string): [number, number] {
  let a = addr.toLowerCase();
  // expand :: notation
  const zones = a.split('%')[0];
  let [head, tail] = zones.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail ? tail.split(':').filter(Boolean) : [];
  let groups: string[];
  if (zones.includes('::')) {
    const fill = Array(Math.max(0, 8 - h.length - t.length)).fill('0');
    groups = [...h, ...fill, ...t];
  } else groups = zones.split(':');
  if (groups.length !== 8) throw new Error(`Bad IPv6: ${addr}`);
  const nums = groups.map((g) => parseInt(g.padStart(4, '0'), 16));
  if (nums.some((n) => Number.isNaN(n))) throw new Error(`Bad IPv6: ${addr}`);
  const hi = ((nums[0] << 16) | nums[1]) >>> 0;
  const lo = ((nums[4] << 16) | nums[5]) >>> 0; // we only need coarse checks below
  void ((nums[2] << 16) | nums[3]); void ((nums[6] << 16) | nums[7]);
  return [hi, lo];
}
function v6prefix(addr: string, bits: number): string {
  const full = expandV6(addr);
  return full.replace(/:/g, '').slice(0, Math.ceil(bits / 4)).padEnd(8, '0');
}
function expandV6(addr: string): string {
  let a = addr.toLowerCase().split('%')[0];
  if (a.includes('.')) {
    // embedded IPv4 form ::ffff:1.2.3.4
    const m = a.match(/([0-9.]+)$/);
    if (m) {
      const n = v4num(m[1]);
      const hex = n.toString(16).padStart(8, '0');
      a = a.replace(m[1], `${hex.slice(0, 4)}:${hex.slice(4)}`);
    }
  }
  let [head, tail] = a.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail !== undefined && tail !== null ? String(tail).split(':').filter(Boolean) : [];
  let groups: string[];
  if (a.includes('::')) {
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  } else groups = a.split(':');
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

const PRIVATE_V6_PREFIXES: { bits: number; prefix: string }[] = [
  { bits: 128, prefix: '0000:0000:0000:0000:0000:0000:0000:0001'.replace(/:/g, '') }, // ::1
  { bits: 7, prefix: 'fd' },   // fc00::/7 unique-local (first byte f[c-d])
  { bits: 10, prefix: 'fe8' }, // fe80::/10 link-local
  { bits: 8, prefix: 'ff' },   // multicast
];

export function isPrivateAddress(addr: string): boolean {
  if (net.isIPv4(addr)) return PRIVATE_V4_CIDRS.some((c) => v4inCidr(addr, c));
  if (net.isIPv6(addr)) {
    let a = expandV6(addr);
    if (a.startsWith('00000000000000000000ffff') || a.startsWith('0000:0000:0000:0000:0000:ffff'.replace(/:/g, ''))) {
      // v4-mapped → check under v4 rules
      const hex = a.replace(/:/g, '').slice(24);
      const n = parseInt(hex, 16);
      return isPrivateAddress([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    if (/^::ffff:/i.test(addr)) {
      const v4 = addr.replace(/^::ffff:/i, '');
      if (net.isIPv4(v4)) return isPrivateAddress(v4);
    }
    const compact = a.replace(/:/g, '');
    // fc00::/7 → first 7 bits: f[c-f]? actually fc..fd
    const b0 = parseInt(compact.slice(0, 2), 16);
    if (b0 >= 0xfc && b0 <= 0xfd) return true;
    if (compact === '00000000000000000000000000000001') return true; // ::1
    if (compact.slice(0, 3) === 'fe8') return true;                  // fe80::/10
    if (compact.slice(0, 2) === 'ff') return true;                   // ff00::/8
    if (compact.startsWith('000000000000000000000000')) return true; // other ::/96-ish unspecified space
    void PRIVATE_V6_PREFIXES; void v6prefix;
    return false;
  }
  return true; // unknown format → deny
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Disallowed protocol: ${u.protocol}`);
  if (u.username || u.password) throw new Error('URL credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Refusing to fetch a private IP address');
    return u;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`DNS resolution failed for ${host}`);
  }
  if (records.length === 0) throw new Error(`No DNS records for ${host}`);
  for (const r of records) {
    if (isPrivateAddress(r.address)) throw new Error(`${host} resolves to a private address (${r.address})`);
  }
  return u;
}

export interface DownloadLimits { maxBytes?: number; timeoutMs?: number; maxRedirects?: number }

/** Download a remote URL to destPath with SSRF re-validation on every redirect hop. */
export async function safeDownload(url: string, destPath: string, limits: DownloadLimits = {}): Promise<{ bytes: number; contentType: string }> {
  const maxBytes = limits.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const timeoutMs = limits.timeoutMs ?? 120_000;
  const maxRedirects = limits.maxRedirects ?? 5;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUrl(current); // validated per-hop
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new Error(`Remote file exceeds size limit (${declared} bytes)`);
    const ct = res.headers.get('content-type') ?? 'application/octet-stream';
    const out = createWriteStream(destPath);
    let bytes = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > maxBytes) { out.destroy(); throw new Error('Download exceeded size limit'); }
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((r, j) => { out.on('finish', () => r()); out.on('error', j); out.end(); });
    return { bytes, contentType: ct };
  }
  throw new Error('Too many redirects');
}

export function tempFileName(ext: string): string {
  return `${randomUUID()}.${ext.replace(/[^a-z0-9]/gi, '')}`;
}
