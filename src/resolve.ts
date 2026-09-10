/**
 * Resolving one client item to a listing at one retailer.
 *
 * The pipeline is adapter-agnostic and identity-agnostic: it asks the fetcher
 * for pages, the adapter to parse them, and the identity sources what the item
 * is. It never learns which retailer it is talking to.
 */

import {
  alternativesFor,
  type ProbeOutcome,
  type ResolutionAlternative,
} from "./alternatives.js";
import { canQuery, type RetailerAdapter } from "./adapters/types.js";
import { FetchFailed, type Fetcher } from "./fetcher/types.js";
import { gtinMatches } from "./gtin.js";
import { identityFromBarcode } from "./identity/from-barcode.js";
import { identityFromSearchResults } from "./identity/from-search-results.js";
import { identityFromStructuredData } from "./identity/from-structured-data.js";
import {
  mergeIdentities,
  type IdentityProvenance,
  type ProductIdentity,
} from "./identity/types.js";
import { planQueries } from "./query-plan.js";
import {
  hasConclusiveCandidate,
  hasPartNumberEvidence,
  MIN_EVIDENCE_TO_REPORT,
  probeOrder,
  rankCandidates,
  tokenise,
} from "./ranking.js";
import type { ParsedCandidate } from "./adapters/types.js";

/**
 * What became of one item.
 *
 * 🔴 **Four outcomes, and the two middle ones are the whole point.** The
 * handover had three — verified, probable, not-found — which forced two
 * genuinely different findings into one bucket:
 *
 *   - the retailer publishes **no** comparable barcode for a listing we found
 *   - the retailer publishes one and it **disagrees**
 *
 * Measured: **91 of 255 captured product pages publish an empty barcode —
 * 35.7%**. Collapsing that into "probable" reports "we think this is it" for a
 * third of everything probed, when the truthful answer is "this cannot be
 * proven either way here". A client deciding what to review needs them apart.
 */
export type Outcome =
  /** A listing whose published barcode equals the client's. */
  | "verified"
  /** A listing found, but the retailer publishes no barcode to compare. */
  | "unverifiable"
  /** A listing with part-number-level evidence and no barcode agreement. */
  | "unconfirmed"
  /** Nothing with part-number-level evidence. */
  | "not-found";

export interface ResolutionEvidence {
  readonly itemId: string;
  readonly url: string;
  readonly title: string;
  readonly brand: string | null;
  readonly model: string | null;
  readonly priceCents: number | null;
  readonly inStock: boolean;
  readonly isFirstParty: boolean | null;
  readonly sellerName: string | null;
  /** The barcode the retailer published, verbatim. `null` if it published none. */
  readonly retailerBarcode: string | null;
  /** Evidence score at the moment it was chosen. */
  readonly score: number;
}

export interface Resolution {
  readonly barcode: string;
  readonly clientSku: string;
  readonly outcome: Outcome;
  readonly identity: ProductIdentity | null;
  readonly queriesTried: readonly string[];
  readonly candidatesSeen: number;
  readonly probes: number;
  readonly requests: number;
  readonly match: ResolutionEvidence | null;
  /**
   * The runners-up worth offering instead, best first.
   *
   * 🔴 **Only candidates that cleared the same evidence floor the match had
   * to clear.** A candidate below it is the top hit for a vague phrase, and
   * the reviewed screen puts a *use this listing instead* button next to
   * every one of these — offering junk would hand a reviewer the
   * $3,727-server-for-a-$13-accessory mistake with a control on it.
   *
   * ⚠️ Empty for a `not-found`: there is no pairing to swap.
   */
  readonly alternatives: readonly ResolutionAlternative[];
  /** Set only when the pipeline could not complete — never for a clean miss. */
  readonly failure: string | null;
}

export interface ResolveOptions {
  /** Ceiling on product-page probes per item, across every query attempt. */
  readonly maxProbes: number;
  /** A query returning this many candidates is a failed query, not a deep one. */
  readonly candidateFlood: number;
  /** Template for the client's own catalogue page, `{sku}` substituted. */
  readonly clientCatalogueUrlTemplate: string | null;
  /** Where to ask for general search results, `{query}` substituted. */
  readonly searchEngineUrlTemplate: string;
}

export const DEFAULT_OPTIONS: ResolveOptions = {
  maxProbes: 8,
  candidateFlood: 15,
  clientCatalogueUrlTemplate: null,
  searchEngineUrlTemplate: "https://www.google.com/search?q=%22{query}%22",
};

export interface ResolveRequest {
  readonly barcode: string;
  readonly clientSku: string;
}

/** Fetch a page, returning null when it could not be had. */
async function tryFetch(fetcher: Fetcher, url: string): Promise<string | null> {
  try {
    const result = await fetcher.fetch(url);
    return result.body;
  } catch (error) {
    if (error instanceof FetchFailed) return null;
    throw error; // a corpus gap is a defect, not a network problem
  }
}

/**
 * Establish what the item is, consulting sources in order of **authority**.
 *
 * The free barcode derivation is always consulted, because it costs nothing and
 * its agreement with an authoritative source is evidence. It is never allowed
 * to win over one: measured, it reproduces the published part number for 3 of
 * 4 numeric ones and yields `01043` where the real answer is `63005`.
 */
async function establishIdentity(
  request: ResolveRequest,
  fetcher: Fetcher,
  options: ResolveOptions,
): Promise<{
  identity: ProductIdentity | null;
  partNumbers: string[];
  phrase: string | null;
}> {
  const found = new Map<
    IdentityProvenance,
    Omit<ProductIdentity, "provenance" | "corroboratedBy">
  >();
  const partNumbers: string[] = [];
  let phrase: string | null = null;

  // Free, no request.
  const fromBarcode = identityFromBarcode(request);
  if (fromBarcode !== null) found.set("barcode-derived", fromBarcode);

  // Authoritative, one request — when the client publishes a catalogue at all.
  if (options.clientCatalogueUrlTemplate !== null) {
    const url = options.clientCatalogueUrlTemplate.replace(
      "{sku}",
      encodeURIComponent(request.clientSku),
    );
    const body = await tryFetch(fetcher, url);
    if (body !== null) {
      const fromCatalogue = identityFromStructuredData({
        ...request,
        document: body,
      });
      if (fromCatalogue !== null) {
        found.set("client-catalogue", fromCatalogue);
        if (fromCatalogue.partNumber !== null) {
          partNumbers.push(fromCatalogue.partNumber);
        }
      }
    }
  }

  // Last resort, one request. Consulted when nothing authoritative produced a
  // part number — the search plan needs something to ask for.
  if (partNumbers.length === 0) {
    const url = options.searchEngineUrlTemplate.replace(
      "{query}",
      encodeURIComponent(request.barcode),
    );
    const body = await tryFetch(fetcher, url);
    if (body !== null) {
      const inferred = identityFromSearchResults({
        ...request,
        document: body,
      });
      if (inferred !== null) {
        found.set("search-inference", {
          partNumber: inferred.partNumber,
          brand: inferred.brand,
          title: inferred.title,
        });
        partNumbers.push(...inferred.partNumberCandidates);
        phrase = inferred.phrase;
      }
    }
  }

  return { identity: mergeIdentities(found), partNumbers, phrase };
}

export async function resolveItem(
  request: ResolveRequest,
  adapter: RetailerAdapter,
  fetcher: Fetcher,
  options: ResolveOptions = DEFAULT_OPTIONS,
): Promise<Resolution> {
  const startedAt = fetcher.liveRequestCount;
  const base = {
    barcode: request.barcode,
    clientSku: request.clientSku,
    candidatesSeen: 0,
    probes: 0,
    match: null,
    alternatives: [],
    failure: null,
  };

  const { identity, partNumbers, phrase } = await establishIdentity(
    request,
    fetcher,
    options,
  );

  const queries = planQueries(
    {
      barcode: request.barcode,
      brand: identity?.brand ?? null,
      partNumbers,
      phrase,
    },
    adapter.querySupport,
  );

  if (queries.length === 0) {
    return {
      ...base,
      outcome: "not-found",
      identity,
      queriesTried: [],
      requests: fetcher.liveRequestCount - startedAt,
    };
  }

  // Gather across every attempt into one pool, then rank globally.
  //
  // Ranking per attempt burned the probe budget on a weak early query's top
  // hits while a later, better query never got probed at all — the handover
  // records that as a real defect it had to fix.
  const pool = new Map<string, ParsedCandidate>();
  const tried: string[] = [];
  let candidatesSeen = 0;

  for (const query of queries) {
    if (!canQuery(adapter.querySupport, query)) continue;
    tried.push(query);
    const body = await tryFetch(fetcher, adapter.buildSearchUrl(query));
    if (body === null) continue;

    const candidates = adapter.parseSearchResults(body);
    candidatesSeen += candidates.length;
    for (const candidate of candidates) {
      if (!pool.has(candidate.itemId)) pool.set(candidate.itemId, candidate);
    }

    if (
      hasConclusiveCandidate([...pool.values()], partNumbers, request.barcode)
    ) {
      break;
    }
    if (pool.size > options.candidateFlood * 4) break; // runaway generic query
  }

  if (pool.size === 0) {
    return {
      ...base,
      outcome: "not-found",
      identity,
      queriesTried: tried,
      candidatesSeen,
      requests: fetcher.liveRequestCount - startedAt,
    };
  }

  const rankInput = {
    partNumbers,
    brand: identity?.brand ?? null,
    barcode: request.barcode,
    queryTokens: tokenise(tried),
  };
  const ranked = probeOrder(rankCandidates([...pool.values()], rankInput));

  let probes = 0;
  /** The best listing we found but could not compare — an `unverifiable`. */
  let noBarcodeFound: { candidate: ParsedCandidate; score: number } | null =
    null;
  /**
   * What each probe learned, keyed by url.
   *
   * 🔑 Recorded as the loop goes rather than reconstructed afterwards: an
   * alternative nobody opened and one opened to find no barcode are
   * different facts, and only the loop knows which is which. Reconstructing
   * it from `probes` and the ranking order would be a guess that looks like
   * a record.
   */
  const probeOutcomes = new Map<string, ProbeOutcome>();

  for (const entry of ranked.slice(0, options.maxProbes)) {
    const body = await tryFetch(fetcher, entry.candidate.url);
    probes++;
    if (body === null) continue;

    const product = adapter.parseProductPage(body);
    probeOutcomes.set(entry.candidate.url, {
      retailerBarcode: product.barcode,
    });

    if (
      product.barcode !== null &&
      gtinMatches(request.barcode, product.barcode)
    ) {
      return {
        ...base,
        outcome: "verified",
        identity,
        queriesTried: tried,
        candidatesSeen,
        probes,
        requests: fetcher.liveRequestCount - startedAt,
        match: evidence(entry.candidate, entry.score, product.barcode),
        alternatives: alternativesFor({
          ranked,
          chosen: entry.candidate,
          probed: probeOutcomes,
          scoreInput: rankInput,
        }),
      };
    }

    // 🔴 No barcode at all is NOT a mismatch. Remember the best such listing:
    // if nothing verifies, this is an `unverifiable`, not an `unconfirmed`.
    if (product.barcode === null && noBarcodeFound === null) {
      noBarcodeFound = entry;
    }
  }

  const best = ranked[0];
  if (best === undefined) {
    return {
      ...base,
      outcome: "not-found",
      identity,
      queriesTried: tried,
      candidatesSeen,
      probes,
      requests: fetcher.liveRequestCount - startedAt,
    };
  }

  // Without part-number-level evidence the "best" candidate is just the top hit
  // for a vague phrase. Report nothing rather than something wrong.
  //
  // 🔴 Both conditions, not just the score. With the inherited weights, brand +
  // first-party + in-stock totals exactly the floor, so the numeric test alone
  // admitted a candidate with NO part-number evidence — the precise case this
  // guard exists to refuse.
  const bestHasEvidence = hasPartNumberEvidence({
    ...rankInput,
    candidate: best.candidate,
  });
  if (best.score < MIN_EVIDENCE_TO_REPORT || !bestHasEvidence) {
    return {
      ...base,
      outcome: "not-found",
      identity,
      queriesTried: tried,
      candidatesSeen,
      probes,
      requests: fetcher.liveRequestCount - startedAt,
    };
  }

  if (noBarcodeFound !== null) {
    return {
      ...base,
      outcome: "unverifiable",
      identity,
      queriesTried: tried,
      candidatesSeen,
      probes,
      requests: fetcher.liveRequestCount - startedAt,
      match: evidence(noBarcodeFound.candidate, noBarcodeFound.score, null),
      alternatives: alternativesFor({
        ranked,
        chosen: noBarcodeFound.candidate,
        probed: probeOutcomes,
        scoreInput: rankInput,
      }),
    };
  }

  return {
    ...base,
    outcome: "unconfirmed",
    identity,
    queriesTried: tried,
    candidatesSeen,
    probes,
    requests: fetcher.liveRequestCount - startedAt,
    match: evidence(best.candidate, best.score, null),
    alternatives: alternativesFor({
      ranked,
      chosen: best.candidate,
      probed: probeOutcomes,
      scoreInput: rankInput,
    }),
  };
}

function evidence(
  candidate: ParsedCandidate,
  score: number,
  retailerBarcode: string | null,
): ResolutionEvidence {
  return {
    itemId: candidate.itemId,
    url: candidate.url,
    title: candidate.title,
    brand: candidate.brand,
    model: candidate.model,
    priceCents: candidate.priceCents,
    inStock: candidate.inStock,
    isFirstParty: candidate.isFirstParty,
    sellerName: candidate.sellerName,
    retailerBarcode,
    score,
  };
}
