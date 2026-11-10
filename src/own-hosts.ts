/**
 * Whether a url is one of a competitor's own pages, by the gateway's rule.
 *
 * 🔴 **The same four conditions as the gateway's `isReadableListingUrl`**
 * (`aeo-backend` `insights-listing-reads.filing.ts`): `https:` only, no
 * userinfo, no port, and a host exactly one of the competitor's. A url is
 * fetched through a paid proxy on the strength of this, and a product url
 * comes from a page the competitor controls; a look-alike host, a port or a
 * `user@` prefix is somewhere that is not the retailer.
 *
 * Pure. `hosts` are lower-case, as every adapter states them, and a parsed
 * url's hostname always is.
 */
export function isOwnHostUrl(raw: string, hosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    hosts.includes(url.hostname)
  );
}
