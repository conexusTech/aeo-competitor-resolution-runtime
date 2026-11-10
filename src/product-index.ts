/**
 * Reading a retailer's product index, once per run.
 *
 * 🔑 **Single-flight, and scoped to one run.** Costco's index is two requests
 * of several megabytes, and every item of a run asks it the same question —
 * so the first item to ask starts the read and every other item, on whatever
 * worker, awaits that same read. Twenty items at four workers make one fetch
 * of each file, not twenty.
 *
 * ⚠️ **Created per run, like the probe memory, and never persisted.** The
 * index lists what the retailer sells today; carrying it between runs would
 * be a cache with no expiry policy.
 */

import type { ProductIndex, ProductIndexEntry } from "./adapters/types.js";
import {
  FetchFailed,
  type Fetcher,
  type FetchProfile,
} from "./fetcher/types.js";

/**
 * What a read of the index came to.
 *
 * 🔴 **`failed` is never "the retailer carries none of these".** A list that
 * could not be fetched, a file cut short or a file that changed shape says
 * nothing about any item, and every item looked up against it is filed as a
 * failure with this reason — the same rule a search nobody answered keeps.
 */
export type IndexRead =
  | { readonly kind: "read"; readonly entries: readonly ProductIndexEntry[] }
  | { readonly kind: "failed"; readonly reason: string };

export interface IndexCache {
  /**
   * The index's entries, read through `fetcher` by whichever item asks first.
   *
   * ⚠️ The read's requests are charged to that item's meter, because they
   * pass through it; every other item is charged nothing for them, so the
   * run's per-item figures still sum to what it bought.
   */
  read(fetcher: Fetcher): Promise<IndexRead>;
  /**
   * Drop a failed read, so the next `read` tries once more.
   *
   * 🔑 **Called between a run's two passes, not after each failure.** A
   * failure is kept for the rest of the pass it happened in — otherwise a
   * retailer whose index is down would be asked for it once per item — and
   * forgotten before the retry at the end, which asks when the run has
   * stopped pressing. A read that worked is kept.
   */
  forgetFailure(): void;
}

const failed = (reason: string): IndexRead => ({ kind: "failed", reason });

/** Read the whole index: the list first, then every product file it names. */
async function readIndex(
  index: ProductIndex,
  profile: FetchProfile,
  fetcher: Fetcher,
): Promise<IndexRead> {
  /** A body, or the reason none arrived. Anything else is a defect and throws. */
  const get = async (
    url: string,
    asked: FetchProfile,
  ): Promise<string | { readonly failure: string }> => {
    try {
      return (await fetcher.fetch(url, asked)).body;
    } catch (error) {
      if (!(error instanceof FetchFailed)) throw error;
      return {
        failure:
          `${url} could not be fetched (status ${error.status ?? "none"}, ` +
          `${error.attempts} attempt(s))`,
      };
    }
  };

  const files: string[] = [];
  for (const url of index.urls) {
    const body = await get(url, {
      ...profile,
      minBodyBytes: index.minListBytes,
    });
    if (typeof body !== "string") return failed(body.failure);
    if (body.length < index.minListBytes) {
      return failed(
        `${url} answered ${body.length} bytes, too short to be the index's ` +
          `list (at least ${index.minListBytes})`,
      );
    }
    const listed = index.parseListing(body);
    if (listed === null) return failed(`${url} is not a list of product files`);
    for (const file of listed) if (!files.includes(file)) files.push(file);
  }
  if (files.length === 0) {
    return failed(`${index.urls.join(", ")} lists no product file`);
  }
  if (files.length > index.maxFiles) {
    return failed(
      `${index.urls.join(", ")} lists ${files.length} product files, more ` +
        `than the ${index.maxFiles} a whole index is read from, so none was read`,
    );
  }

  const byId = new Map<string, ProductIndexEntry>();
  for (const file of files) {
    const body = await get(file, profile);
    if (typeof body !== "string") return failed(body.failure);
    const entries = index.parse(body);
    if (entries === null) return failed(`${file} is not a product file`);
    for (const entry of entries) {
      if (!byId.has(entry.itemId)) byId.set(entry.itemId, entry);
    }
  }
  if (byId.size < index.minEntries) {
    return failed(
      `the index read ${byId.size} products, fewer than the ` +
        `${index.minEntries} a whole index holds, so it was cut short or ` +
        `changed shape`,
    );
  }
  return { kind: "read", entries: [...byId.values()] };
}

export function createIndexCache(
  index: ProductIndex,
  /** The competitor's fetch profile: the index is the competitor's pages. */
  profile: FetchProfile,
): IndexCache {
  let pending: Promise<IndexRead> | null = null;
  let settled: IndexRead | null = null;
  return {
    read(fetcher) {
      if (pending === null) {
        const started = readIndex(index, profile, fetcher);
        pending = started;
        started.then(
          (result) => {
            if (pending === started) settled = result;
          },
          () => {
            // A defect, not a network answer: nothing is kept, so a later
            // item meets it again rather than inheriting a stale promise.
            if (pending === started) pending = null;
          },
        );
      }
      return pending;
    },
    forgetFailure() {
      if (settled?.kind !== "failed") return;
      pending = null;
      settled = null;
    },
  };
}
