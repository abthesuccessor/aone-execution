import { useEffect, useMemo, useRef } from "react";
import { AppShell } from "../../components/AppShell";
import { GalleryControls } from "../../components/GalleryControls";
import { GalleryGrid, GallerySkeleton } from "../../components/GalleryGrid";
import { ResultState } from "../../components/ResultState";
import { createLocalGalleryAdapter, queryKey } from "../../data/localGalleryAdapter";
import type { GalleryDataAdapter, GalleryQuery } from "../../domain/gallery";
import { browserObserverFactory, createLoadGate, observeLoadBoundary, type ObserverFactory } from "./infiniteScroll";
import { isSuccessfulEndState } from "./galleryPresentation";
import { useGallery } from "./useGallery";

export interface GalleryFeatureProps {
  readonly adapter?: GalleryDataAdapter;
  readonly observerFactory?: ObserverFactory;
}

const initialQuery: GalleryQuery = { search: "", category: null, view: "browse", savedIds: [] };

export function GalleryFeature({ adapter, observerFactory = browserObserverFactory }: GalleryFeatureProps) {
  const defaultAdapter = useMemo(() => createLocalGalleryAdapter({
    failedPage: { enabled: true, page: 2, queryKey: queryKey(initialQuery), consumed: false },
  }), []);
  const gallery = useGallery({ adapter: adapter ?? defaultAdapter });
  const { state } = gallery;
  const boundary = useRef<HTMLDivElement>(null);
  const loadGate = useMemo(() => createLoadGate(gallery.loadMore), [gallery.loadMore]);

  useEffect(() => { if (state.status !== "loading") loadGate.release(); }, [loadGate, state.status]);

  useEffect(() => {
    const target = boundary.current;
    if (!target || state.status === "loading" || state.status === "error" || state.exhausted) return;
    return observeLoadBoundary(target, observerFactory, loadGate.trigger);
  }, [loadGate, observerFactory, state.exhausted, state.status]);

  const initialLoading = state.status === "loading" && state.items.length === 0;
  const empty = state.status === "ready" && state.items.length === 0;
  const successfulEnd = isSuccessfulEndState(state);
  return <AppShell view={gallery.view} savedCount={gallery.savedIds.size} onViewChange={gallery.setView}>
    <header className="hero">
      <div className="eyebrow"><span>Independent visual index</span><span>Tokyo · 2026</span></div>
      <div className="hero-copy"><h1>{gallery.view === "browse" ? <>Ideas worth<br /><em>keeping.</em></> : <>Your visual<br /><em>memory.</em></>}</h1><p>A living collection of remarkable form, image, object and space—selected for the curious.</p></div>
    </header>
    <GalleryControls search={gallery.search} category={gallery.category} onSearchChange={gallery.setSearch} onCategoryChange={gallery.setCategory} />
    <div className="result-count" aria-live="polite"><span>{String(state.total).padStart(3, "0")} works</span><span>{gallery.view === "browse" ? "Latest selection" : "Saved collection"}</span></div>
    <div className="sr-only" role="status" aria-live="polite">{state.status === "loading" ? `Loading page ${state.nextPage + 1}.` : state.status === "ready" ? `${state.items.length} of ${state.total} works loaded.` : ""}{gallery.storageNotice}</div>
    {state.items.length > 0 && <GalleryGrid items={state.items} savedIds={gallery.savedIds} onToggleSaved={gallery.toggleSaved} />}
    {initialLoading && <GallerySkeleton count={12} />}
    {state.status === "loading" && state.items.length > 0 && <GallerySkeleton count={3} />}
    {empty && gallery.view === "saved" && <ResultState kind="empty-saved" onAction={() => gallery.setView("browse")} />}
    {empty && gallery.view === "browse" && <ResultState kind="empty-search" onAction={gallery.clearFilters} />}
    {state.status === "error" && state.error?.retryable && <ResultState kind="error" onAction={gallery.retry} />}
    {state.status === "error" && !state.error?.retryable && <ResultState kind="data-error" />}
    {successfulEnd && <ResultState kind="end" />}
    <div className="load-boundary" ref={boundary}>
      <button type="button" onClick={loadGate.trigger} disabled={state.status === "loading" || state.status === "error" || state.exhausted}>
        {state.status === "loading" ? "Loading 12 more" : successfulEnd ? "All works loaded" : "Load 12 more"}
      </button><span aria-hidden="true">↓</span>
    </div>
  </AppShell>;
}
