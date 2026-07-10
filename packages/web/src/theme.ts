export type Theme = "light" | "dark";

const STORAGE_KEY = "sojourn-theme";

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Stored preference wins; otherwise follow the OS. */
export function initTheme(): Theme {
  let theme: Theme | null = null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") theme = stored;
  } catch {
    // storage unavailable (private mode etc.) — fall through to OS preference
  }
  if (!theme) {
    theme =
      typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }
  applyTheme(theme);
  return theme;
}

export function toggleTheme(current: Theme): Theme {
  const next: Theme = current === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // best effort — the toggle still works for this session
  }
  return next;
}
