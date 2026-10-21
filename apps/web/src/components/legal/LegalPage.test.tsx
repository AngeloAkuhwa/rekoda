import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { POLICY_LAST_UPDATED, TERMS_LAST_UPDATED } from '@/lib/legal';
import TermsPage from '@/app/terms/page';
import PrivacyPage from '@/app/privacy/page';
import { LegalPage } from './LegalPage';

const sections = [{ id: 'a', heading: 'A', body: 'text' }];

/* Server components are plain functions here: call them and read the element
   tree, rather than rendering (react-dom/server refuses the server build). */
function text(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text((node as ReactElement<{ children?: ReactNode }>).props.children);
}

describe('the revision date on a legal page', () => {
  it('is the shared policy date unless the page names its own', () => {
    const shared = LegalPage({ title: 'T', intro: 'i', sections });
    expect(text(shared)).toContain(`Last updated ${POLICY_LAST_UPDATED}`);

    const own = LegalPage({ title: 'T', intro: 'i', sections, updated: '1 January 2027' });
    expect(text(own)).toContain('Last updated 1 January 2027');
  });

  it('moves only for Terms when only Terms changed (OWN-27)', async () => {
    expect(TERMS_LAST_UPDATED).not.toBe(POLICY_LAST_UPDATED);
    const terms = (await TermsPage()) as ReactElement<{ updated?: string }>;
    const privacy = (await PrivacyPage()) as ReactElement<{ updated?: string }>;
    expect(terms.props.updated).toBe(TERMS_LAST_UPDATED);
    expect(privacy.props.updated).toBeUndefined();
  });
});
