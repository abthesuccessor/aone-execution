import { describe, expect, it } from "vitest";
import { createBookmarkStore } from "./bookmarkStore";
import { BOOKMARK_STORAGE_KEY } from "../domain/gallery";

describe("bookmark storage", () => {
  it("parses, validates, deduplicates, and persists known stable IDs", () => {
    let raw: string | null = JSON.stringify({ version: 1, ids: ["frame-12", "frame-2", "frame-12"] });
    const store = createBookmarkStore({ getItem: () => raw, setItem: (key, value) => { expect(key).toBe(BOOKMARK_STORAGE_KEY); raw = value; } });
    expect(store.read()).toMatchObject({ ok: true, value: { ids: ["frame-2", "frame-12"] } });
    store.write({ version: 1, ids: ["frame-3"] });
    expect(raw).toBe('{"version":1,"ids":["frame-3"]}');
  });

  it("ignores malformed and unknown stored values", () => {
    expect(createBookmarkStore({ getItem: () => "{bad", setItem() {} }).read().value.ids).toEqual([]);
    expect(createBookmarkStore({ getItem: () => JSON.stringify({ version: 1, ids: ["frame-999"] }), setItem() {} }).read().value.ids).toEqual([]);
  });

  it("survives denied reads while denied writes remain catchable for memory fallback", () => {
    const denied = createBookmarkStore({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(denied.read().value.ids).toEqual([]);
    expect(() => denied.write({ version: 1, ids: ["frame-1"] })).toThrow("denied");
  });
});
