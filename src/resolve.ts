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
import { RequestMeter } from "./fetcher/meter.js";
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
  /** The retailer's own product photo, absolute http(s) URL, or `null`. */
  readonly imageUrl: string | null;
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

/**
 * What this run has already read off a listing's page, keyed by the retailer's
 * own id for it.
 *
 * ── 🔴 Why a run needs a memory at all ─────────────────────────────────
 *
 * A live Amazon run filed an item as a PROPOSAL against a listing publishing
 * no barcode, while the listing that would have PROVEN it — publishing exactly
 * that item's barcode — was fetched minutes earlier in the same run, as a
 * runner-up on a different item. Its barcode was read and thrown away.
 *
 * The immediate cause is a probe budget meeting a tiebreak that cannot break
 * anything: Amazon states no model and no first-party flag at search stage, so
 * every model-based weight is unreachable and `probeOrder` falls through to a
 * stable sort — which is to say, to the order Amazon returned results in. 80
 * candidates collapse onto a handful of identical scores and 8 of them get
 * probed. Every alternative on that item records the reason in as many words:
 * *"lost a tie on discovery order"*.
 *
 * 🔑 **The remedy is not a better guess at the order.** A barcode this run has
 * already read is EVIDENCE, and evidence outranks a budget. A listing can only
 * ever win through this memory by publishing a barcode that AGREES with the
 * client's — the same fact a probe would have established — so it can promote
 * an agreement and cannot invent one.
 *
 * ⚠️ **Deliberately not a title heuristic.** The handover's own recon records
 * that guessing a model from a trailing `(MODEL)` in an Amazon title produced
 * its two worst false positives: a perpetual calendar winning on `(10174)` and
 * a pipe cutter on `(63005)`, both pure numeric coincidences. The adapter
 * states `model: null` for that reason, and this does not reverse it.
 *
 * ⚠️ **Scoped to one run, and never persisted.** A retailer's published
 * barcode is a fact about a page fetched minutes ago; carrying it between runs
 * would be a cache with no expiry policy, which is a different change with a
 * different risk.
 */
export interface ProbeMemory {
  /** Every barcode a probe found on this listing, or `undefined` if unprobed. */
  get(retailerItemId: string): readonly string[] | undefined;
  remember(retailerItemId: string, barcodes: readonly string[]): void;
}

export function createProbeMemory(): ProbeMemory {
  const seen = new Map<string, readonly string[]>();
  return {
    get: (id) => seen.get(id),
    // 🔑 First reading wins. A page re-fetched later in the same run is the
    // same page; letting a later read overwrite an earlier one would make the
    // outcome depend on item order, which is the defect this fixes.
    remember: (id, barcodes) => {
      if (!seen.has(id)) seen.set(id, [...barcodes]);
    },
  };
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
  /**
   * What the client calls this product, when their list said.
   *
   * ⚠️ **Optional, and it has to stay optional.** A job file written by a
   * gateway that predates this field must still parse — the runtime and the
   * gateway deploy separately, and a required field here would fail every
   * in-flight run at intake rather than resolve it without a name.
   */
  readonly productName?: string | null;
}

/**
 * Fetch a page.
 *
 * 🔴 **Returns WHICH of the two nothings it got**, because collapsing them is
 * how a transient proxy failure reached a customer as assortment information. A
 * page that could not be had and a page that parsed to nothing are the same
 * `null` body, and the caller has to tell them apart: the first means nobody
 * looked, the second means we looked and there was nothing there.
 */
async function tryFetch(
  fetcher: Fetcher,
  url: string,
): Promise<{ body: string | null; fetchFailed: boolean }> {
  try {
    const result = await fetcher.fetch(url);
    return { body: result.body, fetchFailed: false };
  } catch (error) {
    if (error instanceof FetchFailed) return { body: null, fetchFailed: true };
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
  /**
   * 🔴 True when a source this step consulted could not be FETCHED, as
   * distinct from being fetched and yielding nothing useful. It decides whether
   * an item with no searchable identity is reported as a failure or as a fact
   * about the item — and before it existed, a proxy outage during identity was
   * filed as “the retailer does not carry this”.
   */
  fetchFailed: boolean;
}> {
  const found = new Map<
    IdentityProvenance,
    Omit<ProductIdentity, "provenance" | "corroboratedBy">
  >();
  const partNumbers: string[] = [];
  let phrase: string | null = null;
  let fetchFailed = false;

  // Free, no request.
  const fromBarcode = identityFromBarcode(request);
  if (fromBarcode !== null) found.set("barcode-derived", fromBarcode);

  // Authoritative, one request — when the client publishes a catalogue at all.
  if (options.clientCatalogueUrlTemplate !== null) {
    const url = options.clientCatalogueUrlTemplate.replace(
      "{sku}",
      encodeURIComponent(request.clientSku),
    );
    const attempt = await tryFetch(fetcher, url);
    if (attempt.fetchFailed) fetchFailed = true;
    const body = attempt.body;
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
    const attempt = await tryFetch(fetcher, url);
    if (attempt.fetchFailed) fetchFailed = true;
    const body = attempt.body;
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

  return { identity: mergeIdentities(found), partNumbers, phrase, fetchFailed };
}

export async function resolveItem(
  request: ResolveRequest,
  adapter: RetailerAdapter,
  sharedFetcher: Fetcher,
  options: ResolveOptions = DEFAULT_OPTIONS,
  /** What earlier items in this run already read. Absent = a lone item. */
  memory?: ProbeMemory,
): Promise<Resolution> {
  // 🔴 **Every `requests` below used to be `liveRequestCount - startedAt` on
  // the fetcher this was handed — and that is not an attribution.** `runList`
  // runs three of these concurrently by default over ONE fetcher, so each
  // item's delta absorbed its peers': measured 117 against a true 58 at
  // concurrency 3, and 171 against 62 on a live queue run. A meter counts only
  // its own calls, so two of them over one fetcher cannot see each other.
  //
  // ⚠️ Wrapped HERE rather than only in `runList`, because this function is
  // called directly — by the 53-row exit-criterion spec among others — and a
  // caller passing a shared fetcher must not have to know to wrap it.
  // Double-wrapping is harmless: each level counts the calls made through it.
  const fetcher = new RequestMeter(sharedFetcher);
  const base = {
    barcode: request.barcode,
    clientSku: request.clientSku,
    candidatesSeen: 0,
    probes: 0,
    match: null,
    alternatives: [],
    failure: null,
  };

  const { identity, partNumbers, phrase, fetchFailed } =
    await establishIdentity(request, fetcher, options);

  const queries = planQueries(
    {
      barcode: request.barcode,
      brand: identity?.brand ?? null,
      partNumbers,
      phrase,
      productName: request.productName ?? null,
    },
    adapter.querySupport,
  );

  if (queries.length === 0) {
    // 🔴 **This returned a clean `not-found` with no `failure`, and the
    // gateway maps that to item state `not_carried` — which its own constants
    // define as "the competitor GENUINELY does not stock the item, which is
    // real assortment information".** Nothing had been searched. A live queue
    // run on 2026-09-11 filed 3 of 10 items that way, each noted "0
    // candidate(s) across 0 query attempt(s)": the run's own words admitted
    // nobody looked while the state it filed said the retailer does not carry
    // it.
    //
    // 🔑 **`runList` already guards the identical hazard on the throwing
    // route**, and says so in as many words: "never as a clean miss, which
    // would report 'this retailer does not carry it' for an item nobody
    // managed to look up." This is that case on the route that does not throw.
    //
    // ⚠️ **Two different reasons land here and the note distinguishes them**,
    // because one is ours and one is the item's. A fetch that failed is a
    // transient proxy or network problem and the run should be retried; an
    // item with nothing derivable will never resolve however often it is
    // retried, and somebody has to add a part number to the list.
    //
    // ⚠️ This changes what the customer is TOLD, not what gets bought: the
    // gateway re-attempts on `state <> 'approved'`, so `error` and
    // `not_carried` are retried identically.
    return {
      ...base,
      outcome: "not-found",
      identity,
      queriesTried: [],
      requests: fetcher.liveRequestCount,
      failure: fetchFailed
        ? `could not establish what this item is: a source needed to identify ` +
          `it could not be fetched, so no search was attempted`
        : `no searchable identity could be derived for this item and the ` +
          `retailer does not accept a barcode search, so no search was ` +
          `attempted`,
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
    const { body } = await tryFetch(fetcher, adapter.buildSearchUrl(query));
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
      requests: fetcher.liveRequestCount,
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

  /**
   * 🔑 **Before spending anything: has this run already read a barcode off one
   * of these listings?** A probe made for an earlier item answers this one for
   * free, and it answers it with the retailer's own published value rather
   * than with a guess about ranking.
   *
   * ⚠️ **The whole pool, not the probe budget.** The budget is exactly what
   * went wrong — the verifying listing sat outside it — so consulting only the
   * first `maxProbes` entries would reproduce the defect in the fix.
   *
   * 🔴 Only an AGREEING value returns. A remembered barcode that disagrees is
   * left to the probe loop, which will re-read the page and report it as the
   * disagreement it is; promoting it here would turn one item's evidence into
   * another item's false pairing.
   */
  for (const entry of ranked) {
    const remembered = memory?.get(entry.candidate.itemId);
    if (remembered === undefined) continue;
    const known =
      remembered.find((value) => gtinMatches(request.barcode, value)) ?? null;
    if (known === null) continue;
    return {
      ...base,
      outcome: "verified",
      identity,
      queriesTried: tried,
      candidatesSeen,
      // No page was fetched to learn this, and the count must not claim one.
      probes: 0,
      requests: fetcher.liveRequestCount,
      match: evidence(entry.candidate, entry.score, known),
      alternatives: alternativesFor({
        ranked,
        chosen: entry.candidate,
        probed: new Map([[entry.candidate.url, { retailerBarcode: known }]]),
        scoreInput: rankInput,
      }),
    };
  }

  for (const entry of ranked.slice(0, options.maxProbes)) {
    const { body } = await tryFetch(fetcher, entry.candidate.url);
    probes++;
    if (body === null) continue;

    const product = adapter.parseProductPage(body);
    probeOutcomes.set(entry.candidate.url, {
      retailerBarcode: product.barcode,
    });

    // 🔑 Every barcode the field published, not only the first. One real
    // product page returns two space-separated values in one field and the
    // client's was one of them — see `additionalBarcodes`. Checking only the
    // primary would lose a verified pairing and, worse, report the reason as
    // a disagreement rather than as nothing to compare.
    const published = [
      ...(product.barcode === null ? [] : [product.barcode]),
      ...product.additionalBarcodes,
    ];
    // Learned once, available to every later item in this run.
    memory?.remember(entry.candidate.itemId, published);
    const agreeing =
      published.find((value) => gtinMatches(request.barcode, value)) ?? null;

    if (agreeing !== null) {
      return {
        ...base,
        outcome: "verified",
        identity,
        queriesTried: tried,
        candidatesSeen,
        probes,
        requests: fetcher.liveRequestCount,
        // The value that AGREED, not the field's first token — otherwise the
        // evidence a reviewer reads names a barcode that did not match.
        match: evidence(entry.candidate, entry.score, agreeing),
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
    if (published.length === 0 && noBarcodeFound === null) {
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
      requests: fetcher.liveRequestCount,
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
      requests: fetcher.liveRequestCount,
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
      requests: fetcher.liveRequestCount,
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
    requests: fetcher.liveRequestCount,
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
    imageUrl: candidate.imageUrl,
    retailerBarcode,
    score,
  };
}
