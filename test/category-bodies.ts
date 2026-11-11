import { extractPreloadedData } from "../src/adapters/bh.js";

/**
 * SYNTHETIC category bodies built from real ones, for the cases no capture
 * shows: a category page whose product list is empty while its count says
 * otherwise.
 */

/** HTML attribute encoding, the inverse of what B&H's reader decodes. */
const encodeAttribute = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * SYNTHETIC: a real B&H category page with its listing payload rewritten —
 * by default its items emptied, everything else (its count, its page size,
 * its page number) as captured.
 */
export function rewriteBhCategoryPage(
  body: string,
  rewrite: (data: Record<string, unknown>) => void = (data) => {
    data["items"] = [];
  },
): string {
  const pre = extractPreloadedData(body);
  const data = (
    pre as {
      ListingStore?: {
        state?: { response?: { data?: Record<string, unknown> } };
      };
    } | null
  )?.ListingStore?.state?.response?.data;
  if (pre === null || data === undefined) {
    throw new Error("fixture has moved: no B&H listing payload");
  }
  rewrite(data);
  return `<html><body><div class="bh-preloaded-data" data-data="${encodeAttribute(JSON.stringify(pre))}"></div></body></html>`;
}

/** SYNTHETIC: a minimal Newegg listing body around `state`. */
export function neweggBody(state: unknown, pagination: string | null): string {
  return (
    `<html><head><script>window.__initialState__ = ${JSON.stringify(state)};</script></head><body>` +
    (pagination === null
      ? ""
      : `<div class="list-tool-pagination-text">Page<!-- --> <strong>${pagination}</strong></div>`) +
    "</body></html>"
  );
}
