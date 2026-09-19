import type { GalleryState } from "./galleryReducer";

export function isSuccessfulEndState(state: GalleryState): boolean {
  return state.status === "ready" && state.items.length > 0 && state.exhausted;
}
