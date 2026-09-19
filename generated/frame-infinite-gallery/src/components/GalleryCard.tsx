import type { GalleryItem } from "../domain/gallery";
import { BookmarkIcon } from "./icons";

interface GalleryCardProps {
  readonly item: GalleryItem;
  readonly saved: boolean;
  readonly onToggleSaved: (item: GalleryItem) => void;
}

export function GalleryCard({ item, saved, onToggleSaved }: GalleryCardProps) {
  return <article className="card">
    <div className="artwork"><img src={item.artworkSrc} alt={item.artworkAlt} width={item.width} height={item.height} /><span>{item.category}</span><button className="save-button" aria-pressed={saved} aria-label={`${saved ? "Remove" : "Save"} ${item.title}`} onClick={() => onToggleSaved(item)}><BookmarkIcon /></button></div>
    <div className="card-meta"><div><h2>{item.title}</h2><p>{item.creator}</p></div><small>{item.id.replace("frame-", "").padStart(3, "0")}</small></div>
  </article>;
}
