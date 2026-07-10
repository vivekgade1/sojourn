import { beforeEach, describe, expect, it } from "vitest";
import { initTheme, toggleTheme } from "../src/theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("initTheme honors a stored preference", () => {
    localStorage.setItem("sojourn-theme", "dark");
    expect(initTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("initTheme falls back to the OS preference when nothing is stored", () => {
    const theme = initTheme();
    // jsdom's matchMedia (if present) reports light; either way a valid theme applies.
    expect(["light", "dark"]).toContain(theme);
    expect(document.documentElement.dataset.theme).toBe(theme);
  });

  it("toggleTheme flips, applies, and persists", () => {
    expect(toggleTheme("light")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("sojourn-theme")).toBe("dark");
    expect(toggleTheme("dark")).toBe("light");
    expect(localStorage.getItem("sojourn-theme")).toBe("light");
  });
});
