import { describe, expect, it, vi } from "vitest";
import { galleryFixtures } from "./fixtures.generated";
import { createLocalGalleryAdapter, filterGallery, queryKey } from "./localGalleryAdapter";
import { PAGE_SIZE, type GalleryQuery } from "../domain/gallery";

const browse: GalleryQuery = { search: "", category: null, view: "browse", savedIds: [] };
const immediate = async (_milliseconds: number, signal: AbortSignal) => {
  if (signal.aborted) throw { code: "ABORTED", message: "cancelled", retryable: false };
};
const context = () => ({ generation: 0, signal: new AbortController().signal });

describe("local gallery adapter", () => {
  it("returns deterministic 12-item pages and true exhaustion", async () => {
    const adapter = createLocalGalleryAdapter({ delay: immediate });
    const first = await adapter.getPage({ page: 0, pageSize: PAGE_SIZE, query: browse }, context());
    const last = await adapter.getPage({ page: 9, pageSize: PAGE_SIZE, query: browse }, context());
    expect(first.items).toHaveLength(12);
    expect(first.items[0]?.id).toBe("frame-1");
    expect(first.hasMore).toBe(true);
    expect(last.items).toHaveLength(12);
    expect(last.items[11]?.id).toBe("frame-120");
    expect(last.hasMore).toBe(false);
  });

  it("combines locale-stable title/creator search, category, and Saved filtering", () => {
    const target = galleryFixtures[0]!;
    expect(filterGallery(galleryFixtures, { search: `  ${target.creator.toUpperCase()} `, category: target.category, view: "saved", savedIds: [target.id] })).toEqual([target]);
  });

  it("fails one configured page and retries that same page successfully", async () => {
    const failure = { enabled: true, page: 1, queryKey: queryKey(browse), consumed: false };
    const adapter = createLocalGalleryAdapter({ delay: immediate, failedPage: failure });
    const request = { page: 1, pageSize: PAGE_SIZE, query: browse } as const;
    await expect(adapter.getPage(request, context())).rejects.toMatchObject({ code: "DEMO_FAILURE", retryable: true });
    await expect(adapter.getPage(request, context())).resolves.toMatchObject({ page: 1, items: galleryFixtures.slice(12, 24) });
  });

  it("suppresses aborted work before a failure can be consumed", async () => {
    let release: (() => void) | undefined;
    const delay = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const failure = { enabled: true, page: 0, queryKey: queryKey(browse), consumed: false };
    const adapter = createLocalGalleryAdapter({ delay, failedPage: failure });
    const controller = new AbortController();
    const pending = adapter.getPage({ page: 0, pageSize: PAGE_SIZE, query: browse }, { generation: 1, signal: controller.signal });
    controller.abort(); release?.();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(failure.consumed).toBe(false);
  });

  it("returns terminal DATA_INVALID for a corrupt fixture identity", async () => {
    const corrupt = [...galleryFixtures];
    corrupt[1] = corrupt[0]!;
    const adapter = createLocalGalleryAdapter({ fixtures: corrupt, delay: immediate });
    await expect(adapter.getPage({ page: 0, pageSize: PAGE_SIZE, query: browse }, context())).rejects.toMatchObject({ code: "DATA_INVALID", retryable: false });
  });
});
