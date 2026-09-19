import {
  BOOKMARK_STORAGE_KEY,
  parseBookmarkStorage,
  type BookmarkParseResult,
  type BookmarkStorageV1,
  type BookmarkStore,
} from "../domain/gallery";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createBookmarkStore(storage: StorageLike | null): BookmarkStore {
  return {
    read(): BookmarkParseResult {
      if (storage === null) return parseBookmarkStorage(null);
      try { return parseBookmarkStorage(storage.getItem(BOOKMARK_STORAGE_KEY)); }
      catch { return { ok: false, value: { version: 1, ids: [] }, reason: "missing" }; }
    },
    write(value: BookmarkStorageV1): void {
      if (storage === null) return;
      storage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(value));
    },
  };
}
