import { describe, expect, it, vi } from "vitest";
import { createLoadGate, observeLoadBoundary, type ObserverFactory } from "./infiniteScroll";

describe("infinite scroll seams", () => {
  it("routes injected observer and manual triggers through one request gate", () => {
    const load = vi.fn();
    const gate = createLoadGate(load);
    let observerTrigger: (() => void) | undefined;
    const disconnect = vi.fn();
    const factory: ObserverFactory = (callback) => { observerTrigger = callback; return { observe: vi.fn(), disconnect }; };
    const cleanup = observeLoadBoundary({} as Element, factory, gate.trigger);
    observerTrigger?.();
    gate.trigger();
    expect(load).toHaveBeenCalledTimes(1);
    gate.release();
    gate.trigger();
    expect(load).toHaveBeenCalledTimes(2);
    cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
