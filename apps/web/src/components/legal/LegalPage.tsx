import type { ReactNode } from 'react';
import { POLICY_LAST_UPDATED } from '@/lib/legal';

export interface LegalSection {
  id: string;
  heading: string;
  body: ReactNode;
}

/**
 * The shared shell for policy and trust pages.
 *
 * The contents list is generated from the sections rather than hand-written,
 * so a section can never be added without appearing in navigation — the usual
 * way a legal page grows a clause nobody can find. On a phone it renders as an
 * ordinary list above the text; only from 1024px, where there is genuinely a
 * spare column, does it become sticky. A sticky element on a 390px screen
 * eats the reading area it is supposed to help with.
 */
export function LegalPage({
  title,
  intro,
  sections,
}: {
  title: string;
  intro: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <div className="rk-container rk-legal">
      <header className="rk-legal-head">
        <h1>{title}</h1>
        <p className="rk-lede">{intro}</p>
        <p className="rk-legal-updated">Last updated {POLICY_LAST_UPDATED}</p>
      </header>

      <div className="rk-legal-body">
        <nav className="rk-legal-toc" aria-label="On this page">
          <h2>On this page</h2>
          <ol>
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.heading}</a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="rk-prose">
          {sections.map((section) => (
            <section key={section.id} id={section.id}>
              <h2>{section.heading}</h2>
              {section.body}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
