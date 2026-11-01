import { describe, it, expect } from 'vitest';
import { isPrivateAddress, assertSafeUrl } from '../src/ssrf';

describe('SSRF protection', () => {
  it('classifies private/loopback/link-local ranges', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '::1', 'fe80::1', 'fc00::1']) {
      expect(isPrivateAddress(a)).toBe(true);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isPrivateAddress(a)).toBe(false);
    }
  });
  it('blocks non-http protocols', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow(/protocol/i);
    await expect(assertSafeUrl('gopher://example.com')).rejects.toThrow(/protocol/i);
  });
  it('blocks literal private IPs and metadata endpoint', async () => {
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private/i);
    await expect(assertSafeUrl('http://127.0.0.1:6379')).rejects.toThrow(/private/i);
  });
  it('blocks URL credentials', async () => {
    await expect(assertSafeUrl('http://user:pass@8.8.8.8/')).rejects.toThrow(/credential/i);
  });
});
