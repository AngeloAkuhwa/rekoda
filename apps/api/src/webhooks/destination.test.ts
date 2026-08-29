/**
 * The addresses a merchant's webhook may and may not reach (PR-134).
 *
 * Written adversarially, because the interesting inputs are the ones that
 * LOOK public: an internal address wearing an IPv6 coat, a tunnel prefix
 * with an IPv4 destination folded inside it, a documentation range that
 * routes nowhere, the cloud metadata addresses that are the whole reason
 * server-side request forgery is worth anybody's time.
 *
 * The rule under test is an allowlist - ordinary global unicast, nothing
 * else - so a range nobody thought of is refused by default rather than by
 * having been listed. These cases exist to prove the allowlist actually
 * behaves that way, not to enumerate the internet.
 */
import { describe, expect, it } from 'vitest';
import { NOT_PUBLIC, isPubliclyRoutable, publicOnlyLookup, refusalForUrl } from './destination.js';

describe('which addresses are publicly routable', () => {
  it('allows ordinary public addresses, v4 and v6', () => {
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '52.95.110.1',
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
    ]) {
      expect(isPubliclyRoutable(address), address).toBe(true);
    }
  });

  it('refuses the cloud metadata services, which are the point of the exercise', () => {
    /* AWS/GCP/Azure IMDS over IPv4, and the AWS IPv6 one, which sits in
     * unique-local rather than link-local and is missed by guards that
     * only ever heard of 169.254.169.254. */
    expect(isPubliclyRoutable('169.254.169.254')).toBe(false);
    expect(isPubliclyRoutable('fd00:ec2::254')).toBe(false);
  });

  it('refuses loopback in every costume it wears', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      /* IPv4-mapped: the classic way a v4 blocklist is walked around. */
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
    ]) {
      expect(isPubliclyRoutable(address), address).toBe(false);
    }
  });

  it('refuses every private and non-routable v4 range', () => {
    for (const address of [
      '10.0.0.1', // RFC1918
      '172.16.0.1', // RFC1918
      '172.31.255.254', // RFC1918 upper edge
      '192.168.1.1', // RFC1918
      '100.64.0.1', // carrier-grade NAT
      '169.254.1.1', // link-local
      '0.0.0.0', // unspecified
      '255.255.255.255', // broadcast
      '224.0.0.1', // multicast
      '240.0.0.1', // reserved
      '192.0.2.1', // TEST-NET-1, documentation
      '198.51.100.1', // TEST-NET-2
      '203.0.113.1', // TEST-NET-3
      '198.18.0.1', // benchmarking
      '192.88.99.1', // deprecated 6to4 relay anycast
    ]) {
      expect(isPubliclyRoutable(address), address).toBe(false);
    }
  });

  it('refuses the v4 ranges that neighbour a public one, without over-reaching', () => {
    /* 172.16/12 ends at 172.31; 172.32 is public. A hand-rolled check that
     * matched "172." would break real customers. */
    expect(isPubliclyRoutable('172.32.0.1')).toBe(true);
    expect(isPubliclyRoutable('11.0.0.1')).toBe(true);
    /* 100.64/10 ends at 100.127; 100.128 is public. */
    expect(isPubliclyRoutable('100.128.0.1')).toBe(true);
  });

  it('refuses every private and non-routable v6 range', () => {
    for (const address of [
      '::', // unspecified
      'fc00::1', // unique local
      'fd12:3456::1', // unique local
      'fe80::1', // link-local
      'ff02::1', // multicast
      '2001:db8::1', // documentation
      '100::1', // discard-only
    ]) {
      expect(isPubliclyRoutable(address), address).toBe(false);
    }
  });

  it('refuses the tunnel families, which smuggle a v4 destination inside a v6 address', () => {
    /* Each of these embeds an IPv4 address that the tunnel would deliver
     * to. Allowing the outer address would hand back the inner one. */
    expect(isPubliclyRoutable('2002:7f00:0001::')).toBe(false); // 6to4 carrying 127.0.0.1
    expect(isPubliclyRoutable('2001:0:53aa:64c:0:0:7f00:1')).toBe(false); // Teredo
    expect(isPubliclyRoutable('64:ff9b::7f00:1')).toBe(false); // NAT64
  });

  it('refuses anything that is not an address at all', () => {
    for (const value of ['', 'example.test', '999.1.1.1', '127.0.0.1.', 'not an ip', '::gg']) {
      expect(isPubliclyRoutable(value), value).toBe(false);
    }
  });
});

describe('which URLs may be registered', () => {
  it('accepts an ordinary public callback', () => {
    expect(refusalForUrl('https://hooks.example.com/rekoda')).toBeNull();
    expect(refusalForUrl('https://example.co.uk:8443/path?x=1')).toBeNull();
  });

  it('refuses plaintext and other schemes', () => {
    expect(refusalForUrl('http://example.com/hook')).toBe('the endpoint must be https');
    expect(refusalForUrl('file:///etc/passwd')).toBe('the endpoint must be https');
    expect(refusalForUrl('gopher://example.com/')).toBe('the endpoint must be https');
  });

  it('refuses a URL that carries credentials', () => {
    expect(refusalForUrl('https://user:pass@example.com/hook')).toMatch(/username or password/);
    expect(refusalForUrl('https://user@example.com/hook')).toMatch(/username or password/);
  });

  it('refuses an internal address written as a literal, in brackets or not', () => {
    expect(refusalForUrl('https://127.0.0.1/hook')).toBe(NOT_PUBLIC);
    expect(refusalForUrl('https://169.254.169.254/latest/meta-data/')).toBe(NOT_PUBLIC);
    expect(refusalForUrl('https://10.0.0.5:8443/hook')).toBe(NOT_PUBLIC);
    expect(refusalForUrl('https://[::1]/hook')).toBe(NOT_PUBLIC);
    expect(refusalForUrl('https://[fd00:ec2::254]/hook')).toBe(NOT_PUBLIC);
  });

  it('allows a public address written as a literal', () => {
    expect(refusalForUrl('https://8.8.8.8/hook')).toBeNull();
    expect(refusalForUrl('https://[2606:4700:4700::1111]/hook')).toBeNull();
  });

  it('refuses names that cannot be public', () => {
    expect(refusalForUrl('https://localhost/hook')).toBe(NOT_PUBLIC);
    expect(refusalForUrl('https://intranet/hook')).toBe(NOT_PUBLIC);
    expect(refusalForUrl('https://db.internal/hook')).toBe(NOT_PUBLIC);
    expect(refusalForUrl('https://printer.local/hook')).toBe(NOT_PUBLIC);
    expect(refusalForUrl('https://app.localhost/hook')).toBe(NOT_PUBLIC);
  });

  it('refuses something that is not a URL', () => {
    expect(refusalForUrl('nonsense')).toBe('the endpoint must be a valid URL');
  });

  it('never names the address it refused', () => {
    /* The refusal is what a merchant reads. If it echoed the address, a
     * delivery log would become a report on which internal hosts exist. */
    for (const url of [
      'https://127.0.0.1/hook',
      'https://169.254.169.254/hook',
      'https://10.1.2.3/hook',
      'https://[fd00:ec2::254]/hook',
    ]) {
      const refusal = refusalForUrl(url) ?? '';
      expect(refusal).not.toContain('127.0.0.1');
      expect(refusal).not.toContain('169.254');
      expect(refusal).not.toContain('10.1.2.3');
      expect(refusal).not.toContain('fd00');
    }
  });
});

describe('the resolution-time guard', () => {
  /**
   * The check that actually holds. A hostname is not a destination: this
   * runs inside the connection attempt, so the address the socket gets is
   * the address that passed. `localhost` is the case every machine has -
   * a perfectly ordinary name whose answer is loopback.
   */
  it('refuses a name that resolves inside, however ordinary the name looks', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      publicOnlyLookup('localhost', { all: true }, (err) => resolve(err));
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('ENOTFOUND');
    /* The refusal must not report which internal address answered. */
    expect(error!.message).not.toContain('127.0.0.1');
    expect(error!.message).not.toContain('::1');
  });

  it('passes a resolution failure through as itself', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      publicOnlyLookup('no-such-host.invalid', { all: true }, (err) => resolve(err));
    });
    expect(error).not.toBeNull();
    /* Not our refusal - the resolver's own answer, so an operator reading
     * logs can tell "does not exist" from "exists and is internal". */
    expect(error!.message).not.toBe(NOT_PUBLIC);
  });
});
