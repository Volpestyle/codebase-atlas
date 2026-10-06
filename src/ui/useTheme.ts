import { useEffect, useState } from "react";

const THEME_KEY = "codebase-atlas:theme";
export type Theme = "light" | "dark";

function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch { return null; }
}

function prefersDark() {
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/** Runs before the first render so a saved choice paints without a light/dark flash. */
export function applyInitialTheme() {
  applyTheme(savedTheme() ?? (prefersDark() ? "dark" : "light"));
}

export function useTheme() {
  const [preference, setPreference] = useState<Theme | null>(savedTheme);
  const [systemDark, setSystemDark] = useState(prefersDark);
  const theme = preference ?? (systemDark ? "dark" : "light");
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => applyTheme(theme), [theme]);
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setPreference(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* Device storage may be unavailable. */ }
  }
  return { theme, toggleTheme };
}
