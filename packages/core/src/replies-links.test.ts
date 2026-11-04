/**
 * Replies that link into the web app (split from replies.test.ts by concern, to keep that file
 * under the test-layout ceiling): each ends on its link, which comes only from the web URL given.
 */
import { describe, expect, it } from 'vitest';
import * as replies from './replies.js';

/* The two other replies that point at the web app, built by the same helper as
 * the stranger's /start link: each ends on its link, which comes only from
 * the web URL it is given. */
describe('links into the web app', () => {
  const PAGES = [
    ['data deletion', (webUrl: string | null) => replies.erasureDone(2, webUrl), 'data-deletion'],
    [
      'payments',
      (webUrl: string | null) => replies.paymentLinkNeedsConnection(webUrl),
      'app/payments',
    ],
  ] as const;

  /** The link a reply ends on, or null when it ends on none. */
  const linkIn = (text: string) => /\n(\S+:\/\/\S+)$/.exec(text)?.[1] ?? null;

  describe.each(PAGES)('%s', (_name, build, page) => {
    it('links the page under whatever web URL it is given, and nothing else', () => {
      const text = build('https://web.example.test').text;
      expect(linkIn(text)).toBe(`https://web.example.test/${page}`);
      expect(text.match(/\S+:\/\/\S+/g)).toEqual([`https://web.example.test/${page}`]);
      /* And no bare domain beside it: `see name.tld/page or:` would pass the
       * two checks above, and is exactly the bug this reply was fixed for. */
      expect(text.replace(`https://web.example.test/${page}`, '')).not.toMatch(
        /www\.|[a-z0-9-]\.[a-z]{2,}/i,
      );
    });

    it('never doubles a slash, however many trail the web URL', () => {
      for (const webUrl of [
        'https://web.example.test/',
        'https://web.example.test//',
        'https://web.example.test///',
      ]) {
        expect(linkIn(build(webUrl).text), webUrl).toBe(`https://web.example.test/${page}`);
      }
    });

    it('refuses a configured path, giving the no-link reply', () => {
      for (const webUrl of [
        'https://host.example/base',
        'https://host.example/app',
        'https://host.example//app//',
        'https://user:secret@host.example/base/?x=1#top',
      ]) {
        expect(linkIn(build(webUrl).text), webUrl).toBeNull();
        expect(build(webUrl).text, webUrl).toBe(build(null).text);
      }
    });

    it('drops a query, a fragment and credentials from the web URL', () => {
      for (const webUrl of [
        'https://web.example.test/?x=1#section',
        'https://user:secret@web.example.test',
        'https://user:secret@web.example.test/?x=1#top',
      ]) {
        expect(linkIn(build(webUrl).text), webUrl).toBe(`https://web.example.test/${page}`);
      }
    });

    it('normalises the web URL however it was written', () => {
      expect(linkIn(build('HTTPS://WEB.EXAMPLE.TEST').text)).toBe(
        `https://web.example.test/${page}`,
      );
      expect(linkIn(build('  https://web.example.test/  ').text)).toBe(
        `https://web.example.test/${page}`,
      );
      expect(linkIn(build('https://web.example.test:8443').text)).toBe(
        `https://web.example.test:8443/${page}`,
      );
      expect(linkIn(build('http://[::1]:3000').text)).toBe(`http://[::1]:3000/${page}`);
    });

    it('claims no link, and names no domain, when the web URL is unusable', () => {
      const fallback = build(null).text;
      for (const webUrl of [
        null,
        '',
        '   ',
        'not a url',
        'javascript:alert(1)',
        'ftp://web.example.test',
        'web.example.test',
        'https://',
      ]) {
        const text = build(webUrl).text;
        expect(text, String(webUrl)).toBe(fallback);
        /* No scheme, no www, and no bare host either: `name.tld` with no
         * `://` is still a domain a phone turns into a link. */
        expect(text, String(webUrl)).not.toMatch(/:\/\/|www\.|[a-z0-9-]\.[a-z]{2,}/i);
        expect(linkIn(text)).toBeNull();
      }
    });
  });

  it('still says what was deleted, and that the rest can go too, with no link', () => {
    const text = replies.erasureDone(2, null).text;
    expect(text).toContain('deleted (2 records)');
    expect(text).toContain('Your conversations and account can be deleted too');
    // The page by the title it carries on the website and in its footer.
    expect(text).toContain('"Delete my data" page');
  });

  it('still says where Payments is, with no link', () => {
    const text = replies.paymentLinkNeedsConnection(null).text;
    expect(text).toContain('add your settlement account');
    expect(text).toContain('open your Rekoda dashboard and go to Payments');
  });
});
