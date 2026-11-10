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
import {
  FetchFailed,
  type Fetcher,
  type FetchProfile,
} from "./fetcher/types.js";
import { gtinMatches } from "./gtin.js";
import { identityFromBarcode } from "./identity/from-barcode.js";
import { identityFromSearchResults } from "./identity/from-search-results.js";
import { identityFromStructuredData } from "./identity/from-structured-data.js";
import { isOwnHostUrl } from "./own-hosts.js";
import { createIndexCache, type IndexCache } from "./product-index.js";
import {
  boundText,
  MAX_QUERY_LENGTH,
  withinEvidenceLimits,
} from "./wire-limits.js";
import {
  mergeIdentities,
  type IdentityProvenance,
  type ProductIdentity,
} from "./identity/types.js";
import { barcodeQuery, planQueries } from "./query-plan.js";
import {
  brandAgrees,
  hasConclusiveCandidate,
  hasPartNumberEvidence,
  namesThePartNumber,
  MIN_EVIDENCE_TO_REPORT,
  probeOrder,
  rankCandidates,
  tokenise,
} from "./ranking.js";
import type {
  ParsedCandidate,
  ParsedProduct,
  ProductIndexEntry,
} from "./adapters/types.js";

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
  /**
   * The price the page that settled the pairing states, else the search
   * result's. `null` where neither shows one.
   */
  readonly priceCents: number | null;
  /**
   * Stock as that page states it, else as the search result does. `null`
   * where neither says — unknown, which the gateway stores as `unknown`.
   */
  readonly inStock: boolean | null;
  readonly isFirstParty: boolean | null;
  readonly sellerName: string | null;
  /** The retailer's own product photo, absolute https URL, or `null`. */
  readonly imageUrl: string | null;
  /** The barcode the retailer published, verbatim. `null` if it published none. */
  readonly retailerBarcode: string | null;
  /** Evidence score at the moment it was chosen. */
  readonly score: number;
  /**
   * Why the listing publishes no barcode, in the retailer page's own terms,
   * where the adapter can say — and only on an `unverifiable` pairing, one
   * that matched by part number (and brand, where the retailer needs it) and
   * could not be proven. `null` everywhere else.
   *
   * 🔑 **Jody's rule: a candidate without a barcode match goes to a person**,
   * and this is what that person reads beside it ("discontinued at B&H, no
   * UPC published"). Never longer than `MAX_UNVERIFIABLE_REASON_LENGTH`: the
   * gateway client sends one that is as `null`, and logs it as an error.
   */
  readonly unverifiableReason: string | null;
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
  /**
   * Searches this item asked the retailer that could not be fetched at all.
   *
   * 🔑 **Carried on every resolution, not only on a failure**, because a run
   * reports how many of its searches went unanswered and why — a credential
   * gone bad reads as fetch failures, a block as pages that are not results
   * pages, and the two are fixed differently. A retried item carries both of
   * its attempts' counts, as it carries both attempts' requests.
   */
  readonly searchesUnfetched: number;
  /** Searches answered by a page that was not a results page — a block, a robot check, a truncated body. */
  readonly searchesNotResultsPage: number;
  /**
   * Product pages this item probed that answered nothing about the listing:
   * a page that could not be fetched, or a body that was not a product page.
   *
   * 🔴 **Jody's rule: a failed or refused read is never "not carried".** A
   * `not-found` with any of these carries a `failure`, because the listing
   * that would have proven the pairing may be the very page nobody read.
   */
  readonly probesUnanswered: number;
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

/**
 * Product pages the barcode stage may open, outside the item's `maxProbes`.
 *
 * 🔴 **Its own allowance, because the barcode stage runs first.** Counted
 * against the item's budget, a barcode answered with look-alikes spent every
 * probe before identity was even known, and the part-number search after it
 * found the real listing with nothing left to open it. Two: a barcode names
 * one product, so a retailer answering it well puts that product first.
 */
export const BARCODE_STAGE_PROBES = 2;

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
  /**
   * The manufacturer part number the client's list states, and its brand.
   *
   * 🔑 **The client's word outranks anything derived** — provenance
   * `"client"`, asked right after the barcode and ahead of the barcode's own
   * item reference, and its brand is the brand a B&H part number is checked
   * against and a product index is looked up by. A disagreeing brand from any
   * other source never replaces it.
   *
   * ⚠️ **Optional, as `productName` is**, for the same reason: an older
   * gateway sends neither, and with both absent every plan is what it was.
   */
  readonly partNumber?: string | null;
  readonly brand?: string | null;
}

/** A supplied value worth using, or `null`: absent, null and blank are one. */
const supplied = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

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
  /**
   * The competitor's profile, for a competitor's page only. 🔴 Never for the
   * client's catalogue or the search engine: a competitor's country and
   * timeout say nothing about how those pages are fetched.
   */
  profile?: FetchProfile,
): Promise<{ body: string | null; fetchFailed: boolean }> {
  try {
    const result = await fetcher.fetch(url, profile);
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

  // 🔑 The client's own word, first and free. With neither field supplied
  // nothing is recorded, and every step below is what it always was.
  const clientPartNumber = supplied(request.partNumber);
  const clientBrand = supplied(request.brand);
  if (clientPartNumber !== null || clientBrand !== null) {
    found.set("client", {
      partNumber: clientPartNumber,
      brand: clientBrand,
      title: null,
    });
    // First among the candidates, so the plan asks it before anything
    // derived; and, being a part number, it spares the search-engine lookup
    // below exactly as a catalogue's would.
    if (clientPartNumber !== null) partNumbers.push(clientPartNumber);
  }

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
        if (
          fromCatalogue.partNumber !== null &&
          !partNumbers.includes(fromCatalogue.partNumber)
        ) {
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
  /**
   * The run's read of the retailer's product index, where it has one. Absent
   * = a lone item, which reads the index for itself.
   */
  index?: IndexCache,
): Promise<Resolution> {
  // 🔑 Counted as the probes happen and stamped on whatever comes back, so
  // no return below can report a figure from before its last probe.
  const tally: ProbeTally = { probes: 0, unanswered: 0 };
  const resolution = await resolveCounted(
    request,
    adapter,
    sharedFetcher,
    options,
    tally,
    memory,
    index,
  );
  return {
    ...resolution,
    // 🔴 A query is recorded at the gateway's limit, never sent cut: a client's
    // product name of any length is still asked as written.
    queriesTried: resolution.queriesTried.map((q) =>
      boundText(q, MAX_QUERY_LENGTH),
    ),
    probesUnanswered: tally.unanswered,
  };
}

/** Probes made for one item, and how many of them answered nothing. */
interface ProbeTally {
  probes: number;
  unanswered: number;
}

async function resolveCounted(
  request: ResolveRequest,
  adapter: RetailerAdapter,
  sharedFetcher: Fetcher,
  options: ResolveOptions,
  tally: ProbeTally,
  memory?: ProbeMemory,
  index?: IndexCache,
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
    searchesUnfetched: 0,
    searchesNotResultsPage: 0,
    probesUnanswered: 0,
  };

  // Gather across every attempt into one pool, then rank globally.
  //
  // Ranking per attempt burned the probe budget on a weak early query's top
  // hits while a later, better query never got probed at all — the handover
  // records that as a real defect it had to fix.
  const pool = new Map<string, ParsedCandidate>();
  const tried: string[] = [];
  let candidatesSeen = 0;
  /**
   * 🔴 **How many searches the retailer did NOT answer, and why.** A miss is a
   * fact about the retailer only when the retailer answered every search the
   * item asked. On 2026-10-22 an expired proxy credential made a production
   * run fetch nothing: every search here was dropped with a bare `continue`,
   * the empty pool returned a clean `not-found`, and the gateway filed all 227
   * items `not_carried` — "the retailer does not stock this", on the strength
   * of zero pages. `establishIdentity` already kept this rule; the search step
   * did not.
   */
  let unfetched = 0;
  let notAResultsPage = 0;

  /**
   * Add a found listing to the pool, the first finding of it winning.
   *
   * 🔴 **The check before every probe, and every proposal: a listing off the
   * competitor's own hosts never enters the pool** (security finding 5). Its
   * url came from a page the competitor controls; probing it would send the
   * paid proxy somewhere that is not the retailer, and proposing it would
   * persist that link for every reviewer. Every probe and every match is
   * drawn from this pool, so nothing past here can reach one.
   */
  const admit = (candidate: ParsedCandidate): void => {
    if (!isOwnHostUrl(candidate.url, adapter.hosts)) return;
    if (!pool.has(candidate.itemId)) pool.set(candidate.itemId, candidate);
  };

  /**
   * Ask the retailer one query, adding what it answers to the pool.
   *
   * Returns whether it answered with a results page. A fetch that failed and
   * a body that is not a results page are both tallied as unanswered.
   */
  const search = async (query: string): Promise<boolean> => {
    tried.push(query);
    const { body } = await tryFetch(
      fetcher,
      adapter.buildSearchUrl(query),
      adapter.fetchProfile,
    );
    if (body === null) {
      unfetched++;
      return false;
    }

    const candidates = adapter.parseSearchResults(body);
    // A robot check or an error page is no more an answer than a failed
    // fetch. The adapter says which it got; it never guesses `[]`.
    if (candidates === null) {
      notAResultsPage++;
      return false;
    }
    candidatesSeen += candidates.length;
    for (const candidate of candidates) admit(candidate);
    return true;
  };

  let probes = 0;
  /** This retailer's own ceiling, else the run's. */
  const maxProbes = adapter.maxProbes ?? options.maxProbes;
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
   * Every url probed for this item, and every barcode it published — `null`
   * where the page could not be had, or was not a product page. 🔑 So a listing the barcode stage
   * already opened is never bought again by the probes after identity.
   */
  const probed = new Map<string, readonly string[] | null>();
  /**
   * What each product page this item bought says, by url — where the
   * evidence's price and stock come from. 🔑 The page that proved a pairing
   * is fresher than the search result that found it, and for a retailer
   * whose search shows no price it is the only source.
   */
  const pages = new Map<string, ParsedProduct>();

  /** Buy one listing's page and read every barcode it publishes. */
  const probe = async (
    candidate: ParsedCandidate,
  ): Promise<readonly string[] | null> => {
    const { body } = await tryFetch(
      fetcher,
      candidate.url,
      adapter.fetchProfile,
    );
    probes++;
    tally.probes = probes;
    if (body === null) {
      tally.unanswered++;
      probed.set(candidate.url, null);
      return null;
    }

    const product = adapter.parseProductPage(body);
    // 🔴 Not a product page: an unanswered probe, as a failed fetch is —
    // never "publishes no barcode". Nothing is remembered, because nothing
    // was learned about the listing.
    if (product === null) {
      tally.unanswered++;
      probed.set(candidate.url, null);
      return null;
    }
    probeOutcomes.set(candidate.url, {
      retailerBarcode: product.barcode,
    });
    pages.set(candidate.url, product);

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
    memory?.remember(candidate.itemId, published);
    probed.set(candidate.url, published);
    return published;
  };

  const agreeingIn = (published: readonly string[]): string | null =>
    published.find((value) => gtinMatches(request.barcode, value)) ?? null;

  /**
   * What this run already read off a listing in `ranked` that agrees with the
   * client's barcode — the first such listing, or `null`.
   *
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
  const rememberedAgreement = (
    ranked: readonly { candidate: ParsedCandidate; score: number }[],
  ): {
    entry: { candidate: ParsedCandidate; score: number };
    known: string;
  } | null => {
    for (const entry of ranked) {
      const remembered = memory?.get(entry.candidate.itemId);
      if (remembered === undefined) continue;
      const known = agreeingIn(remembered);
      if (known !== null) return { entry, known };
    }
    return null;
  };

  // ── The barcode first, where the retailer answers one ─────────────────
  //
  // 🔑 **Before identity, because a hit makes identity unnecessary.** The
  // barcode names exactly this product, so a listing found by it and
  // publishing it is proven by the value that found it — and the client
  // catalogue page or search-engine lookup identity costs is never bought.
  //
  // ⚠️ **A miss carries forward rather than starting over.** The pool, the
  // probes made and the answered/unanswered tally all feed the normal path
  // below, which skips the barcode query because it has been asked: a 0-result
  // answer is an answered search, and a refused one stays unanswered.
  //
  // Where the retailer cannot search a barcode, `barcodeQuery` is `null`,
  // nothing here runs, and every path below is what it always was.
  const firstQuery = barcodeQuery(request.barcode, adapter.querySupport);
  if (firstQuery !== null && canQuery(adapter.querySupport, firstQuery)) {
    await search(firstQuery);
    if (pool.size > 0) {
      const stageInput = {
        partNumbers: [],
        brand: null,
        barcode: request.barcode,
        queryTokens: tokenise(tried),
      };
      const stageRanked = probeOrder(
        rankCandidates([...pool.values()], stageInput),
      );
      const counted = {
        ...base,
        searchesUnfetched: unfetched,
        searchesNotResultsPage: notAResultsPage,
      };
      // Nothing was bought to establish what the item is: the barcode proved
      // the pairing, so no identity is claimed.
      const proven = (
        entry: { candidate: ParsedCandidate; score: number },
        agreeing: string,
        probedSoFar: ReadonlyMap<string, ProbeOutcome>,
      ): Resolution => ({
        ...counted,
        outcome: "verified",
        identity: null,
        queriesTried: tried,
        candidatesSeen,
        probes,
        requests: fetcher.liveRequestCount,
        match: evidence(
          entry.candidate,
          entry.score,
          agreeing,
          pages.get(entry.candidate.url),
        ),
        alternatives: alternativesFor({
          ranked: stageRanked,
          chosen: entry.candidate,
          probed: probedSoFar,
          scoreInput: stageInput,
        }),
      });

      const remembered = rememberedAgreement(stageRanked);
      if (remembered !== null) {
        return proven(
          remembered.entry,
          remembered.known,
          new Map([
            [
              remembered.entry.candidate.url,
              { retailerBarcode: remembered.known },
            ],
          ]),
        );
      }
      let stageProbes = 0;
      for (const entry of stageRanked) {
        if (stageProbes >= BARCODE_STAGE_PROBES) break;
        // 🔴 A result the retailer marked as a partial or look-alike answer
        // to the barcode is not the barcode's product: never opened here.
        if (entry.candidate.partialMatch) continue;
        stageProbes++;
        const published = await probe(entry.candidate);
        const agreeing = published === null ? null : agreeingIn(published);
        if (agreeing !== null) return proven(entry, agreeing, probeOutcomes);
      }
    }
  }

  /**
   * Where this retailer lists what it sells instead of answering a search,
   * read BEFORE the item is identified.
   *
   * 🔴 **An index that cannot be read makes every item a failure, so it is
   * read before anything else is bought for the item.** Read after identity,
   * a failed index cost each item its client catalogue page — and the retry
   * at the end of the run bought that page a second time — for an answer the
   * index read alone had already settled. The read is run-scoped and
   * single-flight, so reading it first costs a working index nothing.
   */
  const productIndex = adapter.productIndex;
  let indexEntries: readonly ProductIndexEntry[] = [];
  if (productIndex !== null) {
    const read = await (
      index ?? createIndexCache(productIndex, adapter.fetchProfile)
    ).read(fetcher);
    if (read.kind === "failed") {
      return {
        ...base,
        outcome: "not-found",
        // Nothing was bought to identify it, and nothing was looked up.
        identity: null,
        queriesTried: tried,
        candidatesSeen,
        probes,
        requests: fetcher.liveRequestCount,
        failure:
          `the retailer's product index could not be read, so this item was ` +
          `never looked up in it: ${read.reason}`,
      };
    }
    indexEntries = read.entries;
  }

  const { identity, partNumbers, phrase, fetchFailed } =
    await establishIdentity(request, fetcher, options);
  const itemBrand = identity?.brand ?? null;

  /**
   * Whether a listing found by searching is a candidate for this item at all.
   *
   * 🔴 **Where a part number names a product only with its brand**, a listing
   * needs part-number evidence AND a brand that agrees with the item's — the
   * rule that keeps a C2G cable sharing an Allsop wrist rest's MFR # from
   * being probed, or proposed. Everywhere else every listing found is one, as
   * it always was. See `QuerySupport.partNumberNeedsBrand`.
   */
  const isCandidate = (candidate: ParsedCandidate): boolean =>
    !adapter.querySupport.partNumberNeedsBrand ||
    (namesThePartNumber({
      candidate,
      partNumbers,
      brand: itemBrand,
      barcode: request.barcode,
      queryTokens: [],
    }) &&
      brandAgrees(itemBrand, candidate));

  /**
   * 🔑 **Candidates from the index, then the same probes and the same
   * proof.** Nothing below the gathering step knows where a candidate came
   * from: it is probed, and verified only by a barcode its own page states.
   */
  if (productIndex !== null) {
    const productName = request.productName ?? identity?.title ?? null;
    if (itemBrand === null && productName === null) {
      // The index path's twin of an empty query plan, and the same rule: a
      // failure, never a clean miss, because nothing was looked up.
      return {
        ...base,
        outcome: "not-found",
        identity,
        queriesTried: [],
        requests: fetcher.liveRequestCount,
        failure: fetchFailed
          ? `could not establish what this item is: a source needed to ` +
            `identify it could not be fetched, so it was never looked up in ` +
            `the retailer's product index`
          : `neither a brand nor a name could be found for this item, and ` +
            `the retailer is looked up by one or the other in its product ` +
            `index, so it was never looked up`,
      };
    }
    tried.push(`index:${itemBrand ?? productName}`);
    const found = productIndex.candidates(indexEntries, {
      brand: itemBrand,
      partNumbers,
      productName,
    });
    candidatesSeen += found.length;
    for (const candidate of found) admit(candidate);
  } else {
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
      //
      // ⚠️ Unreachable after a barcode search: the plan puts that same query
      // first, so a plan that asked it is never empty.
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

    for (const query of queries) {
      if (!canQuery(adapter.querySupport, query)) continue;
      // The barcode stage's query has been asked; never twice.
      if (tried.includes(query)) continue;
      if (!(await search(query))) continue;

      if (
        hasConclusiveCandidate(
          [...pool.values()].filter(isCandidate),
          partNumbers,
          request.barcode,
        )
      ) {
        break;
      }
      if (pool.size > options.candidateFlood * 4) break; // runaway generic query
    }
  }

  /**
   * 🔴 **A miss needs EVERY search answered, not any.** The plan asks its most
   * specific query first and its vaguest last, so "one answered" would let a
   * throttled exact-part-number search be outvoted by an empty answer to a
   * vague phrase — "the retailer does not carry this", resting on the search
   * least able to say so. Every return below that reports a miss consults
   * this; a finding never does, because a listing found is found.
   *
   * The counts go in the words so a run's record says whether to fix a
   * credential or wait out a block.
   */
  const unanswered = unfetched + notAResultsPage;
  /**
   * 🔴 **And a miss needs the item identified, where identifying it failed.**
   * With no part number known because a source could not be FETCHED, the plan
   * asks only what needs none — the barcode, the client's name — and every
   * part-number search is skipped. Each of those can be answered and the miss
   * still rest on less than the plan meant to ask: a barcode search finds
   * only a listing published under that barcode, and the part-number route is
   * the plan's answer for one published under another. Best Buy answers a
   * barcode with nothing for 9 of the 20 sampled rows, and a run that then
   * cannot identify the item would have filed all 9 as not carried.
   */
  //
  // ⚠️ For a lookup in a product index the brand is what an item is found
  // by, so an identity that could not be fetched leaves a miss resting on the
  // name alone.
  const identityUnfetched =
    fetchFailed &&
    (productIndex === null ? partNumbers.length === 0 : itemBrand === null);
  /**
   * Why a miss here is not a finding, or `null` where it is one.
   *
   * 🔴 **A function, read at the moment of the miss**, because the probes it
   * counts happen after this is declared: a value computed here would say
   * "every page answered" about pages not yet asked for.
   *
   * 🔴 **Jody's rule: a failed or refused read is never "not carried".** A
   * product page that could not be fetched, or came back as something other
   * than a product page, may be the one listing that would have proven the
   * pairing — so a miss over it is a failure, exactly as a miss over a search
   * nobody answered is.
   */
  const missFailure = (): string | null => {
    const unread = tally.unanswered;
    const clauses: string[] = [];
    if (unanswered !== 0) {
      clauses.push(
        `${unanswered} of ${tried.length} searches went unanswered by the ` +
          `retailer: ${unfetched} could not be fetched and ${notAResultsPage} ` +
          `came back as not a results page`,
      );
    }
    if (unread !== 0) {
      clauses.push(
        `${unread} of ${probes} product pages could not be read: they could ` +
          `not be fetched or were not product pages`,
      );
    }
    if (clauses.length > 0) {
      const nobody =
        unanswered !== 0 && unread !== 0
          ? "a search or a listing nobody answered"
          : unanswered !== 0
            ? "a search nobody answered"
            : "a listing nobody read";
      return `${clauses.join("; ")}, so a miss here cannot be told from ${nobody}`;
    }
    if (!identityUnfetched) return null;
    return productIndex !== null
      ? `could not establish what this item is: a source needed to ` +
          `identify it could not be fetched, so it was looked up in the ` +
          `retailer's product index by its name only, never by its brand`
      : `could not establish what this item is: a source needed to ` +
          `identify it could not be fetched, so it was searched only by ` +
          `${searchedBy()} (${tried.length} search(es)) and never by part number`;
  };

  /**
   * The kinds of search this item asked, never their text.
   *
   * 🔴 **The words of a query are not quoted into a failure.** One of them is
   * the client's own product name, of any length, and a failure past the
   * gateway's `MAX_FAILURE_LENGTH` costs the whole batch it rides in. The
   * queries themselves are in `queriesTried`.
   */
  const searchedBy = (): string => {
    const barcode = barcodeQuery(request.barcode, adapter.querySupport);
    const name = request.productName?.trim() ?? null;
    const kinds: string[] = [];
    for (const query of tried) {
      const kind =
        query === barcode
          ? "its barcode"
          : query === name
            ? "the client's product name"
            : query === phrase?.trim()
              ? "a phrase from search results"
              : "a query derived from its barcode";
      if (!kinds.includes(kind)) kinds.push(kind);
    }
    return kinds.length === 0 ? "nothing" : kinds.join(" and ");
  };
  const counted = {
    ...base,
    searchesUnfetched: unfetched,
    searchesNotResultsPage: notAResultsPage,
  };

  if (pool.size === 0) {
    return {
      ...counted,
      outcome: "not-found",
      identity,
      queriesTried: tried,
      candidatesSeen,
      probes,
      requests: fetcher.liveRequestCount,
      failure: missFailure(),
    };
  }

  /**
   * 🔑 **For candidates from a product index, the index's order decides among
   * equals.** It chose them by the item's brand and name already; crediting
   * the brand again here would rank every one of the brand's weaker names
   * above a better one that does not spell the brand — Costco's AirPods are
   * `airpods-4-with-…`, while `apple-airpods-max-2` leads with "apple". And
   * the lookup's record (`index:<brand>`) is not a query whose words a
   * listing could share. Part-number evidence still counts as ever.
   */
  const rankInput = {
    partNumbers,
    brand: productIndex === null ? itemBrand : null,
    barcode: request.barcode,
    queryTokens: productIndex === null ? tokenise(tried) : [],
  };
  const ranked = probeOrder(
    rankCandidates([...pool.values()].filter(isCandidate), rankInput),
  );

  /** The best listing we found but could not compare — an `unverifiable`. */
  let noBarcodeFound: { candidate: ParsedCandidate; score: number } | null =
    null;

  // 🔑 Over EVERY listing found, not only the candidates: a barcode this run
  // already read that agrees with the client's proves the pairing whatever
  // the brand reads as. Where the brand rule is off, the two lists are one.
  const remembered = rememberedAgreement(
    adapter.querySupport.partNumberNeedsBrand
      ? probeOrder(rankCandidates([...pool.values()], rankInput))
      : ranked,
  );
  if (remembered !== null) {
    return {
      ...counted,
      outcome: "verified",
      identity,
      queriesTried: tried,
      candidatesSeen,
      // No page was fetched to learn this, and the count must not claim one.
      probes,
      requests: fetcher.liveRequestCount,
      match: evidence(
        remembered.entry.candidate,
        remembered.entry.score,
        remembered.known,
        pages.get(remembered.entry.candidate.url),
      ),
      alternatives: alternativesFor({
        ranked,
        chosen: remembered.entry.candidate,
        probed: new Map([
          [
            remembered.entry.candidate.url,
            { retailerBarcode: remembered.known },
          ],
        ]),
        scoreInput: rankInput,
      }),
    };
  }

  /** A pairing proven by a page this item read. */
  const verifiedOn = (
    entry: { candidate: ParsedCandidate; score: number },
    agreeing: string,
  ): Resolution => ({
    ...counted,
    outcome: "verified",
    identity,
    queriesTried: tried,
    candidatesSeen,
    probes,
    requests: fetcher.liveRequestCount,
    // The value that AGREED, not the field's first token — otherwise the
    // evidence a reviewer reads names a barcode that did not match.
    match: evidence(
      entry.candidate,
      entry.score,
      agreeing,
      pages.get(entry.candidate.url),
    ),
    alternatives: alternativesFor({
      ranked,
      chosen: entry.candidate,
      probed: probeOutcomes,
      scoreInput: rankInput,
    }),
  });

  /** Probes after identity: the item's `maxProbes`, the barcode stage's apart. */
  let itemProbes = 0;
  for (const entry of ranked) {
    // 🔑 A listing the barcode stage already opened costs nothing here: its
    // answer is reused, never bought again, and it spends no probe.
    let published = probed.get(entry.candidate.url);
    if (published === undefined) {
      if (itemProbes >= maxProbes) continue;
      itemProbes++;
      published = await probe(entry.candidate);
    }
    if (published === null) continue;

    const agreeing = agreeingIn(published);
    if (agreeing !== null) return verifiedOn(entry, agreeing);

    // 🔴 No barcode at all is NOT a mismatch. Remember the best such listing:
    // if nothing verifies, this is an `unverifiable`, not an `unconfirmed`.
    if (published.length === 0 && noBarcodeFound === null) {
      noBarcodeFound = entry;
    }
  }

  const best = ranked[0];
  if (best === undefined) {
    return {
      ...counted,
      outcome: "not-found",
      identity,
      queriesTried: tried,
      candidatesSeen,
      probes,
      requests: fetcher.liveRequestCount,
      failure: missFailure(),
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
  /**
   * 🔴 **The best listing's page, read once more where it was not read**,
   * within what is left of the item's probes.
   *
   * A live Best Buy run (2026-11-10, Bright Data delivering 67 of 107
   * requests) proposed Kensington's best listing — the one the investigation
   * verified — as `unconfirmed` without ever reading it: the barcode stage's
   * read had failed, and the loop above reuses an answer rather than buying
   * it twice. Only a page that was READ can disagree. See `proposal` below
   * for what happens when this read fails too.
   *
   * Only when nothing verified, nothing read published no barcode — an
   * `unverifiable` already rests on a page that was read — and the best
   * listing clears the floor to be reported at all: one that does not is a
   * miss whose unread pages already make it a failure, which the run retries
   * after the rest of its list.
   */
  let bestRead = probed.get(best.candidate.url) ?? null;
  if (
    bestRead === null &&
    noBarcodeFound === null &&
    bestHasEvidence &&
    best.score >= MIN_EVIDENCE_TO_REPORT &&
    itemProbes < maxProbes
  ) {
    itemProbes++;
    bestRead = await probe(best.candidate);
    if (bestRead !== null) {
      const agreeing = agreeingIn(bestRead);
      if (agreeing !== null) return verifiedOn(best, agreeing);
      // Ranked first, so it is the best such listing whatever came before.
      if (bestRead.length === 0) noBarcodeFound = best;
    }
  }

  /**
   * 🔴 **Jody's rule: a candidate without a barcode match goes to a person.**
   * A product index states no model, so an index candidate can never show
   * part-number evidence, and one whose page published no barcode would
   * otherwise be filed as not carried. Every index candidate matched the item
   * by its lead word — its brand, or its product line (`ProductIndex.
   * candidates`) — and that match is the floor for `unverifiable` ONLY: a
   * page whose barcode disagrees is another product, never `unconfirmed`, and
   * nothing but an agreeing barcode verifies.
   */
  const leadWordFloor = productIndex !== null && noBarcodeFound !== null;
  if (
    !leadWordFloor &&
    (best.score < MIN_EVIDENCE_TO_REPORT || !bestHasEvidence)
  ) {
    return {
      ...counted,
      outcome: "not-found",
      identity,
      queriesTried: tried,
      candidatesSeen,
      probes,
      requests: fetcher.liveRequestCount,
      // A miss, so the same rule: weak candidates from the vague searches
      // that answered say nothing about the specific one that did not.
      failure: missFailure(),
    };
  }

  if (noBarcodeFound !== null) {
    return {
      ...counted,
      outcome: "unverifiable",
      identity,
      queriesTried: tried,
      candidatesSeen,
      probes,
      requests: fetcher.liveRequestCount,
      match: evidence(
        noBarcodeFound.candidate,
        noBarcodeFound.score,
        null,
        pages.get(noBarcodeFound.candidate.url),
        true,
      ),
      alternatives: alternativesFor({
        ranked,
        chosen: noBarcodeFound.candidate,
        probed: probeOutcomes,
        scoreInput: rankInput,
      }),
    };
  }

  /**
   * What goes to a person as `unconfirmed`: a listing whose page was READ and
   * whose published barcode disagrees — never one nobody read.
   *
   * 🔴 **The best listing, where its page was read**, as it always was. Where
   * it was not — even after the read above — the best listing below it
   * qualifies only when its page WAS read (so the disagreement a reviewer is
   * shown is a fact) and it clears, on its own evidence, the floor the best
   * had to clear: part-number evidence and the reporting score. The unread
   * best stays among the alternatives for the reviewer to choose instead.
   *
   * Every read page here disagrees: an agreeing one returned `verified`, and
   * an empty one made this an `unverifiable` above.
   */
  const proposal =
    bestRead !== null
      ? best
      : (ranked.slice(1).find((entry) => {
          const read = probed.get(entry.candidate.url);
          return (
            read !== undefined &&
            read !== null &&
            entry.score >= MIN_EVIDENCE_TO_REPORT &&
            hasPartNumberEvidence({ ...rankInput, candidate: entry.candidate })
          );
        }) ?? null);

  if (proposal === null) {
    // 🔴 **A failure, never a proposal and never a miss.** The listing most
    // likely to be this item was never compared by barcode, so this is an
    // item nobody managed to look at — `runList` retries it after the rest of
    // the list, and the gateway files it as an error.
    return {
      ...counted,
      outcome: "not-found",
      identity,
      queriesTried: tried,
      candidatesSeen,
      probes,
      requests: fetcher.liveRequestCount,
      // The run's own account of what went unread follows, in the words
      // every other miss over an unread page uses.
      failure:
        `the best candidate's page could not be read, and no listing that ` +
        `was read clears the evidence floor, so none is proposed: ` +
        (missFailure() ??
          `${tally.unanswered} of ${probes} product pages could not be read`),
    };
  }

  return {
    ...counted,
    outcome: "unconfirmed",
    identity,
    queriesTried: tried,
    candidatesSeen,
    probes,
    requests: fetcher.liveRequestCount,
    match: evidence(
      proposal.candidate,
      proposal.score,
      null,
      pages.get(proposal.candidate.url),
    ),
    alternatives: alternativesFor({
      ranked,
      chosen: proposal.candidate,
      probed: probeOutcomes,
      scoreInput: rankInput,
    }),
  };
}

/**
 * What a reviewer sees about the chosen listing.
 *
 * 🔑 **Price and stock from the page that settled the pairing, where it says**
 * — the search result's otherwise. Newegg's and Amazon's page parses state
 * neither, so their evidence is the search result's, as it always was.
 *
 * @param page The listing's product page as this item read it, or
 * `undefined` where it was never read (a pairing proven from the run's memory,
 * or a match nobody probed).
 */
function evidence(
  candidate: ParsedCandidate,
  score: number,
  retailerBarcode: string | null,
  page: ParsedProduct | undefined,
  /** Whether this is an `unverifiable` pairing, the only one with a reason. */
  unverifiable = false,
): ResolutionEvidence {
  // 🔴 Held to the gateway's limits: every string here is a competitor's.
  return withinEvidenceLimits({
    itemId: candidate.itemId,
    url: candidate.url,
    title: candidate.title,
    brand: candidate.brand,
    model: candidate.model,
    priceCents: page?.priceCents ?? candidate.priceCents,
    inStock: page?.inStock ?? candidate.inStock,
    // 🔑 The page's seller class first: a Best Buy card past the first few
    // states none, and its page does.
    isFirstParty: page?.isFirstParty ?? candidate.isFirstParty,
    sellerName: page?.sellerName ?? candidate.sellerName,
    imageUrl: candidate.imageUrl,
    retailerBarcode,
    score,
    unverifiableReason: unverifiable
      ? (page?.unverifiableReason ?? null)
      : null,
  });
}
