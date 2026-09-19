import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createBookmarkStore, type StorageLike } from "../../data/bookmarkStore";
import { isRequestError, queryKey, requestError } from "../../data/localGalleryAdapter";
import {
  PAGE_SIZE,
  type BookmarkStore,
  type Category,
  type GalleryDataAdapter,
  type GalleryItem,
  type GalleryItemId,
  type GalleryQuery,
  type GalleryView,
} from "../../domain/gallery";
import { galleryReducer, initialGalleryState, savedIdsForQuery } from "./galleryReducer";
import { RequestControllers } from "./requestControllers";

export interface GalleryDependencies {
  readonly adapter: GalleryDataAdapter;
  readonly bookmarkStore?: BookmarkStore;
}

export function useGallery({ adapter, bookmarkStore }: GalleryDependencies) {
  const store = useMemo(() => bookmarkStore ?? createBookmarkStore(safeStorage()), [bookmarkStore]);
  const [view, setView] = useState<GalleryView>("browse");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category | null>(null);
  const [savedIds, setSavedIds] = useState<ReadonlySet<GalleryItemId>>(() => new Set(store.read().value.ids));
  const [storageNotice, setStorageNotice] = useState("");

  const sortedSavedIds = useMemo(() => [...savedIds].sort(compareIds), [savedIds]);
  const query = useMemo<GalleryQuery>(() => ({
    search,
    category,
    view,
    savedIds: savedIdsForQuery(view, sortedSavedIds) as readonly GalleryItemId[],
  }), [category, savedIds, search, sortedSavedIds, view]);
  const key = queryKey(query);
  // Bookmark changes are deliberately excluded from Browse identity, so retain
  // the prior query object while its canonical key is unchanged.
  const requestQuery = useMemo(() => query, [key]);
  const identity = useRef({ key, generation: 0 });
  if (identity.current.key !== key) identity.current = { key, generation: identity.current.generation + 1 };
  const generation = identity.current.generation;
  const [state, dispatch] = useReducer(galleryReducer, initialGalleryState(key, generation));
  const controllers = useRef(new RequestControllers());
  const currentState = useRef(state);
  currentState.current = state;

  const requestPage = useCallback((page: number, requestQuery: GalleryQuery, requestKey: string, requestGeneration: number) => {
    const requestId = `${requestGeneration}:${requestKey}:${page}`;
    const controller = controllers.current.start(requestId);
    if (controller === null) return;
    dispatch({ type: "load", page, generation: requestGeneration, queryKey: requestKey });
    void adapter.getPage(
      { page, pageSize: PAGE_SIZE, query: requestQuery },
      { generation: requestGeneration, signal: controller.signal },
    ).then((result) => {
      controllers.current.runIfOwned(requestId, controller, () => {
        if (identity.current.generation !== requestGeneration || identity.current.key !== requestKey) return;
        dispatch({ type: "resolve", page, generation: requestGeneration, queryKey: requestKey, items: result.items, total: result.total, hasMore: result.hasMore });
      });
    }).catch((error: unknown) => {
      controllers.current.runIfOwned(requestId, controller, () => {
        if (identity.current.generation !== requestGeneration || identity.current.key !== requestKey) return;
        const known = isRequestError(error) ? error : requestError("DATA_INVALID", "The gallery returned an unexpected response.", false);
        dispatch({ type: "reject", page, generation: requestGeneration, queryKey: requestKey, error: known });
      });
    }).finally(() => { controllers.current.finish(requestId, controller); });
  }, [adapter]);

  useEffect(() => {
    controllers.current.abortAll();
    dispatch({ type: "reset", queryKey: key, generation });
    requestPage(0, requestQuery, key, generation);
    return () => { controllers.current.abortAll(); };
  }, [generation, key, requestPage, requestQuery]);

  const loadMore = useCallback(() => {
    const latest = currentState.current;
    if (latest.generation !== generation || latest.queryKey !== key || latest.status === "loading" || latest.status === "error" || latest.exhausted) return;
    requestPage(latest.nextPage, requestQuery, key, generation);
  }, [generation, key, requestPage, requestQuery]);

  const retry = useCallback(() => {
    const page = currentState.current.failedPage;
    if (page !== null && currentState.current.error?.retryable) requestPage(page, requestQuery, key, generation);
  }, [generation, key, requestPage, requestQuery]);

  const toggleSaved = useCallback((item: GalleryItem) => {
    setSavedIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
      const ids = [...next].sort(compareIds);
      try { store.write({ version: 1, ids }); setStorageNotice(""); }
      catch { setStorageNotice("Saved for this session; browser storage is unavailable."); }
      return next;
    });
  }, [store]);

  const clearFilters = useCallback(() => { setSearch(""); setCategory(null); }, []);
  const displayedState = state.generation === generation && state.queryKey === key
    ? state
    : { ...initialGalleryState(key, generation), status: "loading" as const };
  return { state: displayedState, view, search, category, savedIds, storageNotice, setView, setSearch, setCategory, clearFilters, toggleSaved, loadMore, retry };
}

function compareIds(left: GalleryItemId, right: GalleryItemId): number {
  return Number(left.slice(6)) - Number(right.slice(6));
}

function safeStorage(): StorageLike | null {
  try { return window.localStorage; } catch { return null; }
}
