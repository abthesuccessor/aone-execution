import type { Category } from "../domain/gallery";
import { CATEGORIES } from "../domain/gallery";
import { SearchIcon } from "./icons";

interface GalleryControlsProps {
  readonly search: string;
  readonly category: Category | null;
  readonly onSearchChange: (value: string) => void;
  readonly onCategoryChange: (value: Category | null) => void;
}

export function GalleryControls({ search, category, onSearchChange, onCategoryChange }: GalleryControlsProps) {
  return <section className="controls" aria-label="Filter inspiration">
    <label className="search-field"><span className="sr-only">Search by title or creator</span><SearchIcon /><input type="search" value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search title or creator" /></label>
    <div className="chips" aria-label="Categories">
      <button aria-pressed={category === null} onClick={() => onCategoryChange(null)}>All work</button>
      {CATEGORIES.map((item) => <button key={item} aria-pressed={category === item} onClick={() => onCategoryChange(item)}>{item}</button>)}
    </div>
  </section>;
}
