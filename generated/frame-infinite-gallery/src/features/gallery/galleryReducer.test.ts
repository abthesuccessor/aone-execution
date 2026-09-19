import { describe, expect, it } from "vitest";
import { galleryFixtures } from "../../data/fixtures.generated";
import { queryKey } from "../../data/localGalleryAdapter";
import type { GalleryQuery } from "../../domain/gallery";
import { galleryReducer, initialGalleryState, savedIdsForQuery } from "./galleryReducer";
import { isSuccessfulEndState } from "./galleryPresentation";

describe("gallery query and reducer policy", () => {
  it("resets and advances generations for search, category, and Saved identities", () => {
    const base: GalleryQuery = { search: "", category: null, view: "browse", savedIds: [] };
    const identities = [
      { ...base, search: "atlas" },
      { ...base, category: "Editorial" as const },
      { ...base, view: "saved" as const, savedIds: [galleryFixtures[0]!.id] },
    ];
    let state = initialGalleryState(queryKey(base), 0);
    identities.forEach((query, index) => { state = galleryReducer(state, { type: "reset", queryKey: queryKey(query), generation: index + 1 }); });
    expect(state).toMatchObject({ generation: 3, items: [], nextPage: 0 });
  });

  it("does not change Browse query identity when bookmarks change", () => {
    const before = queryKey({ search: "", category: null, view: "browse", savedIds: savedIdsForQuery("browse", []) as [] });
    const after = queryKey({ search: "", category: null, view: "browse", savedIds: savedIdsForQuery("browse", ["frame-1"]) as [] });
    expect(after).toBe(before);
  });

  it("suppresses stale responses and deduplicates card IDs", () => {
    const state = initialGalleryState("new", 2);
    const stale = galleryReducer(state, { type: "resolve", page: 0, generation: 1, queryKey: "old", items: galleryFixtures.slice(0, 12), total: 120, hasMore: true });
    expect(stale).toBe(state);
    const ready = galleryReducer(state, { type: "resolve", page: 0, generation: 2, queryKey: "new", items: [galleryFixtures[0]!, galleryFixtures[0]!], total: 1, hasMore: false });
    expect(ready.items.map((item) => item.id)).toEqual(["frame-1"]);
    expect(ready.exhausted).toBe(true);
    expect(isSuccessfulEndState(ready)).toBe(true);
  });

  it("preserves cards on failure and retries without skipping the page", () => {
    let state = initialGalleryState("q", 0);
    state = galleryReducer(state, { type: "resolve", page: 0, generation: 0, queryKey: "q", items: galleryFixtures.slice(0, 12), total: 120, hasMore: true });
    state = galleryReducer(state, { type: "reject", page: 1, generation: 0, queryKey: "q", error: { code: "DEMO_FAILURE", message: "demo", retryable: true } });
    expect(state).toMatchObject({ failedPage: 1, nextPage: 1 });
    expect(state.items).toHaveLength(12);
    state = galleryReducer(state, { type: "load", page: 1, generation: 0, queryKey: "q" });
    state = galleryReducer(state, { type: "resolve", page: 1, generation: 0, queryKey: "q", items: galleryFixtures.slice(12, 24), total: 120, hasMore: true });
    expect(state.items).toHaveLength(24);
    expect(new Set(state.items.map((item) => item.id)).size).toBe(24);
  });

  it("retains cards for terminal DATA_INVALID without presenting successful exhaustion", () => {
    let state = galleryReducer(initialGalleryState("q", 0), { type: "resolve", page: 0, generation: 0, queryKey: "q", items: galleryFixtures.slice(0, 12), total: 120, hasMore: true });
    state = galleryReducer(state, { type: "reject", page: 1, generation: 0, queryKey: "q", error: { code: "DATA_INVALID", message: "bad", retryable: false } });
    expect(state).toMatchObject({ status: "error", exhausted: false, error: { retryable: false } });
    expect(state.items).toHaveLength(12);
    expect(isSuccessfulEndState(state)).toBe(false);
  });
});
