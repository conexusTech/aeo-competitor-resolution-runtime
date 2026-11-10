/**
 * The text of every JSON-LD block in a page, in page order.
 *
 * 🔴 **Linear, by construction, and it stops at the first JSON-LD tag with no
 * `</script>` after it.** The regular expression this replaced in three
 * adapters — `<script…ld+json…>([\s\S]*?)<\/script>` — re-scanned to the end
 * of the body from every unclosed opening tag, so a page ending in 20,000 of
 * them took three seconds to read, and a larger one a run's whole budget. An
 * opening with no close has no block, and nor can any opening after it.
 *
 * Shared, so the three adapters that read JSON-LD cannot scan it three ways;
 * outside `adapters/`, where every file is an adapter.
 * Pure, like the rest of the seam.
 */
export function ldJsonBlocks(html: string): string[] {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const open = lower.indexOf("<script", from);
    if (open < 0) return out;
    const tagEnd = lower.indexOf(">", open);
    if (tagEnd < 0) return out;
    from = tagEnd + 1;
    if (!LD_JSON_TAG.test(lower.slice(open, from))) continue;
    const close = lower.indexOf("</script>", from);
    if (close < 0) return out;
    out.push(html.slice(from, close));
    from = close + "</script>".length;
  }
}

/** An opening `<script>` tag declaring JSON-LD, already lower-cased. */
const LD_JSON_TAG = /^<script\s[^>]*type=["']application\/ld\+json["']/;
