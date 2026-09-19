import { describe, expect, it } from "vitest";
import { CATEGORIES, FIXTURE_ITEM_COUNT } from "../domain/gallery";
import { galleryFixtures } from "./fixtures.generated";

describe("gallery fixture corpus", () => {
  it("contains exactly 120 stable unique records", () => {
    expect(galleryFixtures).toHaveLength(FIXTURE_ITEM_COUNT);
    expect(new Set(galleryFixtures.map((item) => item.id)).size).toBe(120);
    expect(galleryFixtures[0]?.id).toBe("frame-1");
    expect(galleryFixtures[119]?.id).toBe("frame-120");
  });

  it("uses approved categories and bundled SVG paths", () => {
    for (const item of galleryFixtures) {
      expect(CATEGORIES).toContain(item.category);
      expect(item.artworkSrc).toMatch(/^\/artwork\/frame-\d{3}\.svg$/);
      expect(item.artworkSrc).not.toMatch(/^https?:/);
      expect(item.width).toBeGreaterThan(0);
      expect(item.height).toBeGreaterThan(0);
    }
  });
});
