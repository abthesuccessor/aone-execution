export interface ObserverInstance {
  observe(target: Element): void;
  disconnect(): void;
}

export type ObserverFactory = (callback: () => void) => ObserverInstance;

export function browserObserverFactory(callback: () => void): ObserverInstance {
  if (!("IntersectionObserver" in window)) return { observe() {}, disconnect() {} };
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) callback();
  }, { rootMargin: "600px 0px" });
  return observer;
}

export function observeLoadBoundary(target: Element, factory: ObserverFactory, load: () => void): () => void {
  const observer = factory(load);
  observer.observe(target);
  return () => observer.disconnect();
}

export function createLoadGate(load: () => void): { trigger: () => void; release: () => void } {
  let pending = false;
  return {
    trigger() { if (!pending) { pending = true; load(); } },
    release() { pending = false; },
  };
}
