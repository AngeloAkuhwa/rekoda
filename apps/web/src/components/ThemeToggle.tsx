'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

/** Persisted, and it must win over the system preference in both directions. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('rk-theme');
    if (stored === 'dark' || stored === 'light') {
      setTheme(stored);
      return;
    }
    setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('rk-theme', next);
    } catch {
      /* private mode — the in-page toggle still works for this session */
    }
  }

  /* Until the effect has read the real theme, the server-rendered button
   * claimed ☀ and "switch to dark" to EVERY visitor, including one the
   * no-flash script had already painted dark. Neutral until known: wrong is
   * worse than momentarily unspecific. */
  return (
    <button
      type="button"
      onClick={toggle}
      className="rk-theme-toggle"
      aria-label={
        theme === null
          ? 'Switch theme'
          : theme === 'dark'
            ? 'Switch to light theme'
            : 'Switch to dark theme'
      }
    >
      <span aria-hidden="true">{theme === null ? '◐' : theme === 'dark' ? '☾' : '☀'}</span>
    </button>
  );
}
