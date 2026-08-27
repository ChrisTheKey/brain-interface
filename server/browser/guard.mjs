/**
 * URL policy for the browser bridge.
 *
 * Giving ZERO a real browser gives it the internet — and a browser running on
 * this machine can also reach this machine. HWD-ZERO listens on
 * `127.0.0.1:8000`, the gateway on `:3000`, Ollama and every child agent on
 * loopback as well; the whole point of the gateway is that none of them are
 * reachable from outside. A browser tab is outside.
 *
 * So the bridge navigates to public internet addresses only. Loopback,
 * link-local, private ranges, unique-local IPv6 and non-http schemes are
 * refused, and the hostname is resolved first so a public name that points at
 * a private address (DNS rebinding) is refused too. `ZERO_BROWSER_ALLOW_PRIVATE=true`
 * lifts the restriction for an operator who knowingly wants it.
 */
import { lookup } from 'node:dns/promises';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hostname suffixes that never leave the local network. */
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];

export class BlockedUrlError extends Error {
  constructor(message, url) {
    super(message);
    this.name = 'BlockedUrlError';
    this.url = url;
  }
}

/** True for an address that is not routable on the public internet. */
export function isPrivateAddress(address) {
  const value = String(address).trim().toLowerCase().replace(/^\[|\]$/g, '');

  if (value === '' || value === 'localhost') return true;

  // IPv4 (also inside an IPv4-mapped IPv6 address such as ::ffff:127.0.0.1).
  const mapped = value.startsWith('::ffff:') ? value.slice(7) : value;
  const ipv4 = mapped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (ipv4.slice(1).some((part) => Number(part) > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(value)) return true; // unique-local
  if (value.startsWith('ff')) return true; // multicast

  return false;
}

/**
 * Parses and vets a navigation target. Returns the normalised URL.
 * `resolve` is injectable so the check is testable without DNS.
 */
export async function assertNavigable(rawUrl, options = {}) {
  const allowPrivate = options.allowPrivate ?? false;
  const resolve = options.resolve ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }));

  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new BlockedUrlError(`not a valid URL: ${rawUrl}`, String(rawUrl));
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError(
      `only http:// and https:// can be opened (got ${url.protocol})`,
      url.href,
    );
  }

  if (allowPrivate) return url;

  const hostname = url.hostname.toLowerCase();
  if (isPrivateAddress(hostname) || LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new BlockedUrlError(
      `${hostname} is a local address — the browser bridge only opens public internet addresses (set ZERO_BROWSER_ALLOW_PRIVATE=true to override)`,
      url.href,
    );
  }

  // A public name may still resolve to a private address.
  let addresses;
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    throw new BlockedUrlError(`${hostname} could not be resolved: ${error.message}`, url.href);
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  const blocked = list.map((entry) => entry.address ?? entry).filter((entry) => isPrivateAddress(entry));
  if (blocked.length > 0) {
    throw new BlockedUrlError(
      `${hostname} resolves to a local address (${blocked.join(', ')}) — refused`,
      url.href,
    );
  }

  return url;
}

/** The search engines the bridge can query, all privacy-neutral defaults. */
export const SEARCH_ENGINES = {
  duckduckgo: (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
  google: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  bing: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  brave: (query) => `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
};

export function searchUrl(query, engine = 'duckduckgo') {
  const build = SEARCH_ENGINES[engine];
  if (!build) {
    throw new BlockedUrlError(
      `unknown search engine "${engine}" (known: ${Object.keys(SEARCH_ENGINES).join(', ')})`,
      engine,
    );
  }
  const trimmed = String(query ?? '').trim();
  if (trimmed.length === 0) throw new BlockedUrlError('empty search query', engine);
  return build(trimmed);
}
