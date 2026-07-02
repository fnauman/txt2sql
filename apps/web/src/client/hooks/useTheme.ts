import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'text-to-sql.theme';

function initialTheme(): Theme {
  const bootstrapped = document.documentElement.getAttribute('data-theme');
  if (bootstrapped === 'light' || bootstrapped === 'dark') {
    return bootstrapped;
  }

  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // localStorage unavailable (private session) — fall through to OS preference.
  }
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  // Reflect the active theme on <html data-theme="…"> so the CSS token blocks
  // resolve. Also persist so the choice survives reloads.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage unavailable; the in-memory choice still applies for this session.
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggle };
}
