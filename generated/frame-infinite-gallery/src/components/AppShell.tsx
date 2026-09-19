import type { ReactNode } from "react";
import type { GalleryView } from "../domain/gallery";
import { BookmarkIcon, GridIcon } from "./icons";

interface AppShellProps {
  readonly view: GalleryView;
  readonly savedCount: number;
  readonly onViewChange: (view: GalleryView) => void;
  readonly children: ReactNode;
}

export function AppShell({ view, savedCount, onViewChange, children }: AppShellProps) {
  return <div className="app-shell">
    <aside className="rail">
      <a className="brand" href="#main" aria-label="Frame home">F<span>R</span></a>
      <nav aria-label="Primary navigation">
        <button className="rail-button" aria-current={view === "browse" ? "page" : undefined} onClick={() => onViewChange("browse")}><GridIcon /><span>Explore</span></button>
        <button className="rail-button" aria-current={view === "saved" ? "page" : undefined} onClick={() => onViewChange("saved")}><BookmarkIcon /><span>Saved</span>{savedCount > 0 && <b aria-label={`${savedCount} saved`}>{savedCount}</b>}</button>
      </nav>
      <p className="edition">No. 01<br />Curated daily</p>
    </aside>
    <main id="main">{children}</main>
  </div>;
}
