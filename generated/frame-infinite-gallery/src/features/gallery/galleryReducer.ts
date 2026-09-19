import type { GalleryItem, GalleryView, RequestError } from "../../domain/gallery";

export interface GalleryState {
  readonly generation: number;
  readonly queryKey: string;
  readonly items: readonly GalleryItem[];
  readonly nextPage: number;
  readonly total: number;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly error: RequestError | null;
  readonly failedPage: number | null;
  readonly exhausted: boolean;
}

export type GalleryAction =
  | { readonly type: "reset"; readonly queryKey: string; readonly generation: number }
  | { readonly type: "load"; readonly page: number; readonly generation: number; readonly queryKey: string }
  | { readonly type: "resolve"; readonly page: number; readonly generation: number; readonly queryKey: string; readonly items: readonly GalleryItem[]; readonly total: number; readonly hasMore: boolean }
  | { readonly type: "reject"; readonly page: number; readonly generation: number; readonly queryKey: string; readonly error: RequestError };

export function initialGalleryState(queryKey = "", generation = 0): GalleryState {
  return { generation, queryKey, items: [], nextPage: 0, total: 0, status: "idle", error: null, failedPage: null, exhausted: false };
}

export function galleryReducer(state: GalleryState, action: GalleryAction): GalleryState {
  if (action.type === "reset") return initialGalleryState(action.queryKey, action.generation);
  if (action.generation !== state.generation || action.queryKey !== state.queryKey) return state;
  if (action.type === "load") {
    if (state.status === "loading" || state.exhausted || (state.status === "error" && action.page !== state.failedPage)) return state;
    return { ...state, status: "loading", error: null };
  }
  if (action.type === "reject") {
    if (action.error.code === "ABORTED") return state;
    return { ...state, status: "error", error: action.error, failedPage: action.page, exhausted: false };
  }
  if (action.page !== state.nextPage && action.page !== state.failedPage) return state;
  const seen = new Set(state.items.map((item) => item.id));
  const unique = action.items.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));
  return {
    ...state,
    items: [...state.items, ...unique],
    nextPage: action.page + 1,
    total: action.total,
    status: "ready",
    error: null,
    failedPage: null,
    exhausted: !action.hasMore,
  };
}

export function savedIdsForQuery(view: GalleryView, ids: readonly string[]): readonly string[] {
  return view === "saved" ? ids : [];
}
