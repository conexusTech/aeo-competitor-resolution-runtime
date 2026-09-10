/**
 * The offline fetcher: serves a committed corpus of distilled responses.
 *
 * The corpus is keyed by url, so the pipeline is driven exactly as a live run
 * drives it and nothing above this file changes between the two. Bodies are
 * distilled rather than raw — 611 real responses are 160 MB — and the
 * distillation is **proven equivalent** for every parser in use: the distiller
 * runs each parser on the original and on the distilled body and refuses to
 * emit one whose parse differs.
 */

import { createHash } from "node:crypto";

import { type Fetcher, type FetchResult, NotInCorpus } from "./types.js";

export interface CorpusEntry {
  readonly url: string;
  readonly body: string;
}

export interface Corpus {
  readonly note?: string;
  readonly distilledOn?: string;
  readonly entries: readonly CorpusEntry[];
}

/** Stable key for a url. Shared by the distiller and the replay. */
export function corpusKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export class ReplayFetcher implements Fetcher {
  readonly liveRequestCount = 0;

  private readonly byKey: Map<string, CorpusEntry>;
  private readonly served = new Set<string>();

  constructor(corpus: Corpus) {
    this.byKey = new Map(corpus.entries.map((e) => [corpusKey(e.url), e]));
  }

  fetch(url: string): Promise<FetchResult> {
    const entry = this.byKey.get(corpusKey(url));
    if (entry === undefined) return Promise.reject(new NotInCorpus(url));
    this.served.add(corpusKey(url));
    return Promise.resolve({ url, body: entry.body, cached: true });
  }

  /** How many corpus entries this run never asked for. */
  get unusedEntryCount(): number {
    return this.byKey.size - this.served.size;
  }

  get entryCount(): number {
    return this.byKey.size;
  }
}
