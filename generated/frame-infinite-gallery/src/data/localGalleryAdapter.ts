import {
  CATEGORIES,
  FIXTURE_ITEM_COUNT,
  PAGE_SIZE,
  type FailedPageDemo,
  type GalleryDataAdapter,
  type GalleryItem,
  type GalleryQuery,
  type PageRequest,
  type RequestContext,
  type RequestError,
} from "../domain/gallery";
import { galleryFixtures } from "./fixtures.generated";

export type Delay = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface LocalAdapterOptions {
  readonly fixtures?: readonly GalleryItem[];
  readonly delay?: Delay;
  readonly latencyMs?: number;
  readonly failedPage?: FailedPageDemo | null;
}

export function queryKey(query: GalleryQuery): string {
  return JSON.stringify({
    search: normalize(query.search),
    category: query.category,
    view: query.view,
    savedIds: [...new Set(query.savedIds)].sort(compareIds),
  });
}

export function filterGallery(items: readonly GalleryItem[], query: GalleryQuery): readonly GalleryItem[] {
  const term = normalize(query.search);
  const saved = new Set(query.savedIds);
  return items.filter((item) =>
    (query.view === "browse" || saved.has(item.id)) &&
    (query.category === null || item.category === query.category) &&
    (term === "" || normalize(item.title).includes(term) || normalize(item.creator).includes(term)),
  );
}

export function createLocalGalleryAdapter(options: LocalAdapterOptions = {}): GalleryDataAdapter {
  const fixtures = options.fixtures ?? galleryFixtures;
  const delay = options.delay ?? timerDelay;
  const latencyMs = options.latencyMs ?? 180;
  const failure = options.failedPage ?? null;

  return {
    async getPage(request: PageRequest, context: RequestContext) {
      validateRequest(request);
      validateFixtures(fixtures);
      await delay(latencyMs, context.signal);
      throwIfAborted(context.signal);
      const key = queryKey(request.query);
      if (failure?.enabled && !failure.consumed && failure.page === request.page && failure.queryKey === key) {
        failure.consumed = true;
        throw requestError("DEMO_FAILURE", "The next collection could not be opened.", true);
      }
      const filtered = filterGallery(fixtures, request.query);
      const start = request.page * PAGE_SIZE;
      return {
        items: filtered.slice(start, start + PAGE_SIZE),
        page: request.page,
        pageSize: PAGE_SIZE,
        total: filtered.length,
        hasMore: start + PAGE_SIZE < filtered.length,
        queryKey: key,
      };
    },
  };
}

function validateRequest(request: PageRequest): void {
  if (!Number.isInteger(request.page) || request.page < 0 || request.pageSize !== PAGE_SIZE) {
    throw requestError("DATA_INVALID", "The gallery request is invalid.", false);
  }
}

function validateFixtures(items: readonly GalleryItem[]): void {
  const ids = new Set<string>();
  if (items.length !== FIXTURE_ITEM_COUNT) throw requestError("DATA_INVALID", "The gallery data is incomplete.", false);
  for (const item of items) {
    if (ids.has(item.id) || !/^frame-(?:[1-9]|[1-9][0-9]|1[01][0-9]|120)$/.test(item.id) ||
      !CATEGORIES.includes(item.category) || !item.artworkSrc.startsWith("/artwork/") || item.width <= 0 || item.height <= 0) {
      throw requestError("DATA_INVALID", "The gallery data is invalid.", false);
    }
    ids.add(item.id);
  }
}

export function requestError(code: RequestError["code"], message: string, retryable: boolean): RequestError {
  return { code, message, retryable };
}

export function isRequestError(value: unknown): value is RequestError {
  if (typeof value !== "object" || value === null) return false;
  return "code" in value && "message" in value && "retryable" in value;
}

function normalize(value: string): string { return value.trim().toLocaleLowerCase("en-US"); }
function compareIds(left: string, right: string): number { return Number(left.slice(6)) - Number(right.slice(6)); }
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw requestError("ABORTED", "The gallery request was cancelled.", false);
}
function timerDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(requestError("ABORTED", "The gallery request was cancelled.", false)); return; }
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(requestError("ABORTED", "The gallery request was cancelled.", false)); }, { once: true });
  });
}
