import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveSessionIds,
  loadSessionSelection,
  saveSessionSelection,
} from "../src/sessions";

afterEach(() => {
  localStorage.clear();
});

describe("effectiveSessionIds", () => {
  const newestFirst = ["s-new", "s-mid", "s-old"];

  it("defaults to ONLY the newest session when nothing is stored", () => {
    expect(effectiveSessionIds(null, newestFirst)).toEqual(new Set(["s-new"]));
  });

  it("keeps a stored subset", () => {
    expect(effectiveSessionIds(["s-mid", "s-old"], newestFirst)).toEqual(
      new Set(["s-mid", "s-old"]),
    );
  });

  it("drops stored ids that no longer exist, keeping the rest", () => {
    expect(effectiveSessionIds(["s-mid", "s-ghost"], newestFirst)).toEqual(new Set(["s-mid"]));
  });

  it("falls back to latest-only when ALL stored ids vanished", () => {
    expect(effectiveSessionIds(["s-ghost", "s-gone"], newestFirst)).toEqual(new Set(["s-new"]));
  });

  it("falls back to latest-only for an empty stored array", () => {
    expect(effectiveSessionIds([], newestFirst)).toEqual(new Set(["s-new"]));
  });

  it("returns an empty set when there are no sessions at all", () => {
    expect(effectiveSessionIds(null, [])).toEqual(new Set());
    expect(effectiveSessionIds(["s-ghost"], [])).toEqual(new Set());
  });
});

describe("loadSessionSelection / saveSessionSelection", () => {
  it("round-trips per project", () => {
    saveSessionSelection("pA", ["s1", "s2"]);
    saveSessionSelection("pB", ["s9"]);
    expect(loadSessionSelection("pA")).toEqual(["s1", "s2"]);
    expect(loadSessionSelection("pB")).toEqual(["s9"]);
  });

  it("returns null when nothing is stored", () => {
    expect(loadSessionSelection("p-none")).toBeNull();
  });

  it("returns null for malformed or non-array stored values", () => {
    localStorage.setItem("sojourn:session-filter:pX", "{not json");
    expect(loadSessionSelection("pX")).toBeNull();
    localStorage.setItem("sojourn:session-filter:pY", JSON.stringify({ nope: true }));
    expect(loadSessionSelection("pY")).toBeNull();
    localStorage.setItem("sojourn:session-filter:pZ", JSON.stringify([1, 2]));
    expect(loadSessionSelection("pZ")).toBeNull();
  });
});
