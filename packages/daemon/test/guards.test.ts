import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createCrashStormBreaker, installProcessGuards } from "../src/guards.js";

describe("createCrashStormBreaker", () => {
  it("stays quiet below the limit within the window", () => {
    const breaker = createCrashStormBreaker(20, 60_000);
    for (let i = 0; i < 20; i++) {
      expect(breaker.record(1000 + i)).toBe(false);
    }
  });

  it("trips when strictly more than the limit fire inside the window", () => {
    const breaker = createCrashStormBreaker(20, 60_000);
    for (let i = 0; i < 20; i++) breaker.record(1000 + i);
    expect(breaker.record(1021)).toBe(true);
  });

  it("forgets crashes older than the window", () => {
    const breaker = createCrashStormBreaker(3, 1_000);
    breaker.record(0);
    breaker.record(100);
    breaker.record(200);
    // 3 old crashes have aged out by t=5000; three more still under limit.
    expect(breaker.record(5000)).toBe(false);
    expect(breaker.record(5001)).toBe(false);
    expect(breaker.record(5002)).toBe(false);
    expect(breaker.record(5003)).toBe(true); // 4 within window > limit 3
  });
});

describe("installProcessGuards", () => {
  function makeHarness(opts: { crashLimit?: number; windowMs?: number } = {}) {
    const proc = new EventEmitter();
    const logError = vi.fn();
    const exit = vi.fn();
    installProcessGuards({
      proc: proc as unknown as NodeJS.Process,
      logError,
      exit,
      crashLimit: opts.crashLimit,
      windowMs: opts.windowMs,
    });
    return { proc, logError, exit };
  }

  it("logs unhandledRejection with the reason and does NOT exit", () => {
    const { proc, logError, exit } = makeHarness();
    const reason = new Error("stray rejection");
    proc.emit("unhandledRejection", reason, Promise.resolve());
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0].join(" ")).toContain("unhandledRejection");
    expect(logError.mock.calls[0]).toContain(reason);
    expect(exit).not.toHaveBeenCalled();
  });

  it("logs uncaughtException with the error and does NOT exit", () => {
    const { proc, logError, exit } = makeHarness();
    const err = new Error("one bad batch");
    proc.emit("uncaughtException", err);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0].join(" ")).toContain("uncaughtException");
    expect(logError.mock.calls[0]).toContain(err);
    expect(exit).not.toHaveBeenCalled();
  });

  it("crash storm: exits 1 after more than crashLimit uncaughtExceptions in the window", () => {
    const { proc, logError, exit } = makeHarness({ crashLimit: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) proc.emit("uncaughtException", new Error(`e${i}`));
    expect(exit).not.toHaveBeenCalled();
    proc.emit("uncaughtException", new Error("the straw"));
    expect(exit).toHaveBeenCalledWith(1);
    const allLogged = logError.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allLogged).toContain("crash storm");
  });

  it("default breaker: survives 20 uncaughtExceptions, exits on the 21st", () => {
    const { proc, exit } = makeHarness();
    for (let i = 0; i < 20; i++) proc.emit("uncaughtException", new Error(`e${i}`));
    expect(exit).not.toHaveBeenCalled();
    proc.emit("uncaughtException", new Error("e20"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("a throwing logError never rethrows out of the handler", () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    installProcessGuards({
      proc: proc as unknown as NodeJS.Process,
      logError: () => {
        throw new Error("logger exploded");
      },
      exit,
    });
    expect(() => proc.emit("uncaughtException", new Error("x"))).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });
});
