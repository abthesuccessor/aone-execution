import { describe, expect, it } from "vitest";
import { RequestControllers } from "./requestControllers";

describe("gallery request controller ownership", () => {
  it("keeps a live same-key replacement when an aborted request settles late", async () => {
    const requests = new RequestControllers();
    const requestId = "0:browse:0";
    const stale = requests.start(requestId)!;
    let settleStale: (() => void) | undefined;
    const staleResult = new Promise<void>((resolve) => { settleStale = resolve; });

    requests.abortAll();
    const replacement = requests.start(requestId)!;
    expect(stale.signal.aborted).toBe(true);
    expect(requests.owns(requestId, replacement)).toBe(true);

    settleStale?.();
    await staleResult;
    let staleCallbacks = 0;
    requests.runIfOwned(requestId, stale, () => { staleCallbacks += 1; });
    expect(staleCallbacks).toBe(0);
    requests.finish(requestId, stale);
    expect(requests.owns(requestId, replacement)).toBe(true);

    requests.abortAll();
    expect(replacement.signal.aborted).toBe(true);
    expect(requests.owns(requestId, replacement)).toBe(false);
  });
});
