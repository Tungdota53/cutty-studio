import { describe, expect, it, vi } from 'vitest';
import { publicAddress, publicUrl, readPublicUrl } from '../src/public-web.js';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]) }));
describe('Public research boundaries', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1'])('rejects non-public address %s', address => expect(publicAddress(address)).toBe(false));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('recognizes public address %s', address => expect(publicAddress(address)).toBe(true));
  it.each(['file:///etc/passwd', 'http://example.com', 'https://user:pass@example.com', 'https://example.com:8443', 'https://127.0.0.1'])('rejects unsupported URL %s', url => expect(() => publicUrl(url)).toThrow());
  it('rejects a public hostname that resolves to a private address before connection', async () => {
    await expect(readPublicUrl('https://example.com')).rejects.toThrow('internet công khai');
  });
});
