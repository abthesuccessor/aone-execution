import type { GalleryItem } from "../domain/gallery";
import { GalleryCard } from "./GalleryCard";

interface GalleryGridProps {
  readonly items: readonly GalleryItem[];
  readonly savedIds: ReadonlySet<string>;
  readonly onToggleSaved: (item: GalleryItem) => void;
}

export function GalleryGrid({ items, savedIds, onToggleSaved }: GalleryGridProps) {
  return <section className="gallery-grid" aria-label="Inspiration gallery">{items.map((item) => <GalleryCard key={item.id} item={item} saved={savedIds.has(item.id)} onToggleSaved={onToggleSaved} />)}</section>;
}

export function GallerySkeleton({ count = 6 }: { readonly count?: number }) {
  return <section className="gallery-grid" aria-label="Loading inspiration" aria-busy="true">{Array.from({ length: count }, (_, index) => <div className="skeleton" key={index}><div /><span /></div>)}</section>;
}
