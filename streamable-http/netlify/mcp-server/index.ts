/**
 * ORZ MCP Server - Web Search & Fetch MCP Tool (Netlify Functions)
 *
 * MCP server setup with web_search and web_fetch tools.
 * - web_search: DuckDuckGo search with dedup
 * - web_fetch: Fetch web page content, optionally simplified to Markdown
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import dns from "node:dns";
import net from "node:net";
import TurndownService from "turndown";
// @ts-ignore -- turndown-plugin-gfm ships no type declarations
import { gfm } from "turndown-plugin-gfm";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";

// ============================================================================
// Proxy & Config
// ============================================================================

const PROXY_URL =
  process.env.PROXY_URL ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy ||
  "";

const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

if (PROXY_URL) {
  console.log(`[streamable-http] Using proxy: ${PROXY_URL}`);
}

/**
 * Hosts web_fetch may reach even though they are private/loopback
 * (comma-separated, exact match). Empty by default: all private ranges are blocked.
 */
const ALLOWED_PRIVATE_HOSTS = new Set(
  (process.env.ORZ_ALLOW_PRIVATE_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const DUCKDUCKGO_HTML_SEARCH_URL = "https://html.duckduckgo.com/html/";
const DUCKDUCKGO_FALLBACK_SEARCH_URLS = [
  "https://spin-ddg-proxy-idmlnajw.fermyon.app/",
  "https://ddg-368306689698.europe-west1.run.app/",
  "https://olg3d54tkkk5gv452mz42sdu6a0xzlsu.lambda-url.us-east-1.on.aws/",
  "https://ddg.workers.rocks/",
  "https://ddg2.workers.rocks/",
];

const mockHeaders = {
    'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://duckduckgo.com/',
    'Origin': 'https://duckduckgo.com',
    'Upgrade-Insecure-Requests': '1',
    'DNT': '1',
    'Cookie': 'kl=us-en',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua':
        '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
};

function getBrowserHeaders(): Record<string, string> {
  return mockHeaders;
}

function getElapsedMs(startTime: number): number {
  return Date.now() - startTime;
}

async function timedFetch(
  label: string,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const startTime = Date.now();
  try {
    const fetchOptions: any = { ...init };
    if (proxyDispatcher) {
      fetchOptions.dispatcher = proxyDispatcher;
    }
    const response = (proxyDispatcher
      ? await undiciFetch(url, fetchOptions)
      : await fetch(url, init)) as unknown as Response;
    console.log(
      `[fetch] ${label} completed in ${getElapsedMs(startTime)}ms (${response.status}) url="${url}"`
    );
    return response;
  } catch (e) {
    console.error(
      `[fetch] ${label} failed in ${getElapsedMs(startTime)}ms url="${url}": ${(e as Error).message}`
    );
    throw e;
  }
}

// ============================================================================
// Search result types
// ============================================================================

interface SearchItem {
  url: string;
  title: string;
  summary: string;
}

const searchItemSchema = z.object({
  url: z.string(),
  title: z.string(),
  summary: z.string(),
});

// ============================================================================
// HTML entity decoding
// ============================================================================

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, "")).trim();
}

function isDuckDuckGoCaptchaHtml(html: string): boolean {
  return (
    html.includes("anomaly-modal") ||
    html.includes("Please complete the following challenge")
  );
}

// ============================================================================
// Ad filtering
// ============================================================================

function isAdUrl(url: string): boolean {
  const adPatterns = [
    /googleads\./i,
    /doubleclick\./i,
    /googlesyndication\./i,
    /googleadservices\./i,
    /adclick\./i,
    /adsense\./i,
    /adservice\./i,
    /adserver\./i,
    /clickserve\./i,
    /clicktrack\./i,
    /baidu\.com\/aclick/i,
    /pos\.baidu\.com/i,
    /cpro\.baidu\.com/i,
    /e\.baidu\.com/i,
    /bingads\./i,
    /microsoftadvertising\./i,
    /ad_provider=/i,
    /ad_domain=/i,
    /\/ads?\//i,
    /\/advert/i,
    /\/sponsor/i,
    /\/promo\//i,
    /\/click\?/i,
    /\/aclk\?/i,
    /\/pagead\//i,
    // Non-content third-party / infrastructure links
    /\/\/platform\.twitter\.com/i,
    /\/\/analytics\./i,
    /\/cdn-cgi\//i,
  ];
  return adPatterns.some((p) => p.test(url));
}

// ============================================================================
// Search engine parsers
// ============================================================================



function parseDuckDuckGo(html: string): SearchItem[] {
  const results: SearchItem[] = [];
  if (isDuckDuckGoCaptchaHtml(html)) {
    console.log("[DuckDuckGo] Got captcha page, skipping");
    return results;
  }
  const linkRegex =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: Array<{ rawUrl: string; title: string }> = [];
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    links.push({
      rawUrl: linkMatch[1],
      title: stripHtml(linkMatch[2]),
    });
  }
  const snippets: string[] = [];
  let snippetMatch;
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(snippetMatch[1]));
  }
  for (let i = 0; i < links.length; i++) {
    let { rawUrl, title } = links[i];
    rawUrl = decodeHtmlEntities(rawUrl);
    let url = rawUrl;
    if (rawUrl.includes("uddg=")) {
      const uddgParam = rawUrl.split("uddg=")[1]?.split("&")[0] ?? "";
      const decoded = decodeURIComponent(uddgParam);
      if (decoded) url = decoded;
    } else if (rawUrl.startsWith("//")) {
      url = "https:" + rawUrl;
    }
    if (url.includes("duckduckgo.com/y.js") || isAdUrl(url)) {
      continue;
    }
    const summary = i < snippets.length ? snippets[i] : "";
    if (title && url) {
      results.push({ url, title, summary });
    }
  }
  return results;
}

// ============================================================================
// Search engine requests
// ============================================================================


/** The primary endpoint is normally fast; give up early so fallbacks can take over */
const DUCKDUCKGO_PRIMARY_TIMEOUT_MS = 3000;
const DUCKDUCKGO_FALLBACK_TIMEOUT_MS = 4000;
/** If the primary has not answered after this long, start the fallbacks in parallel */
const DUCKDUCKGO_HEDGE_DELAY_MS = 1500;
const DUCKDUCKGO_MAX_FALLBACK_ATTEMPTS = 3;
/** Upper bound for a whole search (Netlify functions time out at 10s by default) */
const DUCKDUCKGO_TOTAL_TIMEOUT_MS = 8000;

async function fetchDuckDuckGoHtml(url: string, timeoutMs: number): Promise<string> {
  const resp = await timedFetch("DuckDuckGo search", url, {
    headers: getBrowserHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }

  return resp.text();
}

type DuckDuckGoSearchAttempt =
  | { kind: "success"; results: SearchItem[] }
  | { kind: "captcha" }
  | { kind: "empty"; results: SearchItem[] }
  | { kind: "error" };

function buildDuckDuckGoSearchUrl(baseUrl: string, query: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("q", query);
  return url.toString();
}

async function tryDuckDuckGoSearchUrl(
  url: string,
  source: string,
  timeoutMs: number
): Promise<DuckDuckGoSearchAttempt> {
  try {
    console.log(`[DuckDuckGo] Trying ${source}: ${url}`);
    const html = await fetchDuckDuckGoHtml(url, timeoutMs);

    if (isDuckDuckGoCaptchaHtml(html)) {
      console.log(`[DuckDuckGo] ${source} returned captcha`);
      return { kind: "captcha" };
    }

    const results = parseDuckDuckGo(html);
    if (results.length === 0) {
      console.log(`[DuckDuckGo] ${source} returned 0 results`);
      return { kind: "empty", results };
    }

    return { kind: "success", results };
  } catch (e) {
    console.error(`[DuckDuckGo] ${source} error:`, (e as Error).message);
    return { kind: "error" };
  }
}

/** Try fallback endpoints one by one; null when none of them produced an answer */
async function retryDuckDuckGoViaFallbacks(query: string): Promise<SearchItem[] | null> {
  const fallbackBaseUrls = [...DUCKDUCKGO_FALLBACK_SEARCH_URLS]
    .sort(() => Math.random() - 0.5)
    .slice(0, DUCKDUCKGO_MAX_FALLBACK_ATTEMPTS);
  for (const fallbackBaseUrl of fallbackBaseUrls) {
    const fallbackUrl = buildDuckDuckGoSearchUrl(fallbackBaseUrl, query);
    const attempt = await tryDuckDuckGoSearchUrl(
      fallbackUrl,
      "fallback",
      DUCKDUCKGO_FALLBACK_TIMEOUT_MS
    );
    if (attempt.kind === "success" || attempt.kind === "empty") {
      return attempt.results;
    }
  }

  return null;
}

/** Resolves with the first non-null value, or null once every task has finished without one */
function firstNonNull<T>(tasks: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = tasks.length;
    if (pending === 0) return resolve(null);
    for (const task of tasks) {
      task
        .then((value) => {
          if (value !== null) resolve(value);
        })
        .catch(() => {})
        .finally(() => {
          if (--pending === 0) resolve(null);
        });
    }
  });
}

async function searchDuckDuckGo(query: string): Promise<SearchItem[]> {
  const primaryUrl = buildDuckDuckGoSearchUrl(DUCKDUCKGO_HTML_SEARCH_URL, query);
  let primaryWon = false;

  const primaryTask = tryDuckDuckGoSearchUrl(
    primaryUrl,
    "primary",
    DUCKDUCKGO_PRIMARY_TIMEOUT_MS
  ).then((attempt) => {
    if (attempt.kind === "success" || attempt.kind === "empty") {
      primaryWon = true;
      return attempt.results;
    }
    return null;
  });

  // Hedged request: start the fallbacks as soon as the primary fails, or when it is slow.
  // A fast successful primary never touches the fallback services.
  const startFallbacks = new Promise<void>((resolve) => {
    setTimeout(resolve, DUCKDUCKGO_HEDGE_DELAY_MS);
    primaryTask.then((results) => {
      if (results === null) resolve();
    });
  });
  const fallbackTask = startFallbacks.then(() =>
    primaryWon ? null : retryDuckDuckGoViaFallbacks(query)
  );

  // Hard cap so a search never outlives the serverless function limit
  const deadline = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), DUCKDUCKGO_TOTAL_TIMEOUT_MS)
  );
  return (await Promise.race([firstNonNull([primaryTask, fallbackTask]), deadline])) ?? [];
}

// ============================================================================
// Merge & dedup
// ============================================================================

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "ref",
      "fbclid",
      "gclid",
      "msclkid",
      "spm",
      "from",
    ];
    const params = new URLSearchParams(parsed.search);
    for (const tp of trackingParams) {
      params.delete(tp);
    }
    const search = params.toString() ? `?${params.toString()}` : "";
    // 丢弃 hash 锚点
    return `${host}${path}${search}`.toLowerCase();
  } catch {
    return url.split("#")[0].toLowerCase();
  }
}

function mergeAndDeduplicate(
  allResults: SearchItem[][],
  maxResults: number
): SearchItem[] {
  const seen = new Set<string>();
  const merged: SearchItem[] = [];
  const maxLen = Math.max(...allResults.map((r) => r.length), 0);
  for (let idx = 0; idx < maxLen; idx++) {
    for (const engineResults of allResults) {
      if (idx >= engineResults.length) continue;
      const item = engineResults[idx];
      if (isAdUrl(item.url)) continue;
      const normalized = normalizeUrl(item.url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(item);
      if (merged.length >= maxResults) return merged;
    }
  }
  return merged;
}

// ============================================================================
// web_search
// ============================================================================

async function webSearch(
  query: string,
  numResults: number = 8
): Promise<SearchItem[]> {
  const startTime = Date.now();
  console.log(`[web_search] query="${query}", numResults=${numResults}`);
  try {
    const results = await searchDuckDuckGo(query);
    console.log(`[web_search] DuckDuckGo: ${results.length} results`);

    const mergedResults = mergeAndDeduplicate([results], numResults);
    console.log(
      `[web_search] total completed in ${getElapsedMs(startTime)}ms, merged=${mergedResults.length}`
    );
    return mergedResults;
  } catch (e) {
    console.error(
      `[web_search] total failed in ${getElapsedMs(startTime)}ms: ${(e as Error).message}`
    );
    throw e;
  }
}

// ============================================================================
// web_fetch
// ============================================================================

/** Noise tags that have a closing tag */
const PAIRED_NOISE_TAGS = [
  "script",
  "style",
  "iframe",
  "noscript",
  "svg",
  "object",
  "embed",
  "applet",
  "head",
  "nav",
  "footer",
  "aside",
];
/** Noise tags without a closing tag (void elements) */
const VOID_NOISE_TAGS = ["meta", "link"];

/**
 * Remove noise tags. The (?=[\s/>]) boundary stops `<head` from matching `<header`;
 * void tags (<link>, <meta>) must not be matched lazily up to the next `/>`,
 * which used to swallow the page body.
 */
function removeUselessTags(html: string): string {
  let cleaned = html;
  for (const tag of PAIRED_NOISE_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}(?=[\\s/>])[^>]*\\/>`, "gi"), "");
    cleaned = cleaned.replace(
      new RegExp(`<${tag}(?=[\\s/>])[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"),
      ""
    );
  }
  for (const tag of VOID_NOISE_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}(?=[\\s/>])[^>]*>`, "gi"), "");
  }
  return cleaned.replace(/<!--[\s\S]*?-->/g, "");
}

function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndownService.use(gfm);
  // The default rule only handles <pre><code>; a bare <pre> loses its line breaks.
  // Use textContent so the original layout is kept.
  turndownService.addRule("preBlock", {
    filter: "pre",
    replacement: (_content: string, node: any) => {
      const cls: string =
        node.querySelector?.("code")?.getAttribute("class") ||
        node.getAttribute("class") ||
        "";
      const lang = cls.match(/(?:language|lang)-([\w+#-]+)/)?.[1] ?? "";
      const text = String(node.textContent ?? "").replace(/\n$/, "");
      const fence = text.includes("```") ? "~~~" : "```";
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });
  turndownService.remove([
    "script",
    "style",
    "iframe",
    "noscript",
    "svg",
    "nav",
    "footer",
  ]);
  try {
    let md = turndownService.turndown(html);
    md = md.replace(/\n{3,}/g, "\n\n");
    md = md.replace(/[ \t]+$/gm, "");
    return md.trim();
  } catch (e) {
    console.error("[htmlToMarkdown] conversion error:", (e as Error).message);
    return html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

/**
 * Find the first element matching openRe (group 1 must capture the tag name),
 * starting at `from`, and pair its closing tag by same-name nesting depth.
 * Returns null when no opening tag is found; an unclosed element runs to the end.
 */
function findBalanced(
  html: string,
  openRe: RegExp,
  from: number = 0
): { inner: string; end: number } | null {
  const open = new RegExp(openRe.source, openRe.flags.replace("g", "") + "g");
  open.lastIndex = from;
  const m = open.exec(html);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const start = m.index + m[0].length;
  const tagRe = new RegExp(`<(\\/?)${tag}(?=[\\s/>])[^>]*>`, "gi");
  tagRe.lastIndex = start;
  let depth = 1;
  let t: RegExpExecArray | null;
  while ((t = tagRe.exec(html)) !== null) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) {
      return { inner: html.slice(start, t.index), end: t.index + t[0].length };
    }
  }
  return { inner: html.slice(start), end: html.length };
}

function visibleTextLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
}

function extractMainContent(html: string): string {
  const body = findBalanced(html, /<(body)\b[^>]*>/i)?.inner ?? html;
  const bodyLen = visibleTextLength(body);

  let candidate: string | null = findBalanced(html, /<(main)\b[^>]*>/i)?.inner ?? null;
  if (candidate === null) {
    // Without <main>, keep every <article> (listing pages use one per entry)
    const articles: string[] = [];
    let pos = 0;
    for (let a; (a = findBalanced(html, /<(article)\b[^>]*>/i, pos)); pos = a.end) {
      articles.push(a.inner);
    }
    if (articles.length > 0) candidate = articles.join("\n");
  }
  if (candidate === null) {
    candidate =
      findBalanced(
        html,
        /<(div|section)\b[^>]*(?:\bid=["'](?:content|main-content|main)["']|\brole=["']main["'])[^>]*>/i
      )?.inner ?? null;
  }

  // If the candidate has almost no text (e.g. it matched a single card), use the whole body
  if (candidate !== null) {
    const len = visibleTextLength(candidate);
    if (len >= 200 || len >= bodyLen * 0.3) return candidate;
  }
  return body;
}

/** Binary types (PDF, images, archives...) cannot be converted: fail loudly instead of returning garbage */
function isTextContentType(contentType: string): boolean {
  if (!contentType) return true;
  return /^text\/|json|xml|javascript|yaml|toml|markdown|x-www-form-urlencoded/i.test(contentType);
}

/** Target of <meta http-equiv="refresh" content="0; url=...">; ignored when the page has real content */
function findMetaRefresh(html: string, baseUrl: string): string | null {
  const tag = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i)?.[0];
  if (!tag) return null;
  const content = tag.match(/content=(["'])([\s\S]*?)\1/i)?.[2];
  const target = content?.match(/url\s*=\s*['"]?([^'";]+)/i)?.[1]?.trim();
  if (!target) return null;
  if (visibleTextLength(removeUselessTags(html)) >= 500) return null;
  try {
    const next = new URL(decodeHtmlEntities(target), baseUrl);
    if (!/^https?:$/.test(next.protocol) || next.href === baseUrl) return null;
    return next.href;
  } catch {
    return null;
  }
}

function httpError(resp: Response): Error {
  let msg = `HTTP ${resp.status}${resp.statusText ? `: ${resp.statusText}` : ""}`;
  if ([401, 403, 429, 503].includes(resp.status)) {
    msg +=
      " (the site refused the request; it may block automated access — configure PROXY_URL or try another source)";
  }
  return new Error(msg);
}

// ----------------------------------------------------------------------------
// SSRF protection
// web_fetch is reachable by anyone who can reach the public /mcp endpoint, so it
// must not be usable to read loopback / link-local (cloud metadata) / private
// networks. Every hop (including redirects) is validated before a request is made.
// ----------------------------------------------------------------------------

const MAX_REDIRECT_HOPS = 5;
const MAX_REFRESH_HOPS = 2;

const privateRanges = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  privateRanges.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64 (can embed a private IPv4)
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (can embed a private IPv4)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  privateRanges.addSubnet(addr, prefix, "ipv6");
}

/** IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are matched against the IPv4 ranges */
function isPrivateIp(ip: string): boolean {
  const family = net.isIPv6(ip) ? "ipv6" : "ipv4";
  return privateRanges.check(ip, family);
}

function blockedError(host: string): Error {
  return new Error(
    `Blocked: "${host}" is a private or internal address and cannot be fetched.`
  );
}

/** Validate scheme and destination of one request URL. Throws "Blocked: ..." when not allowed. */
async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked: unsupported URL scheme "${url.protocol}" (only http and https).`);
  }
  // WHATWG URL already normalises decimal/hex/octal IPv4 forms to dotted quad
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (ALLOWED_PRIVATE_HOSTS.has(host)) return;

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw blockedError(host);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw blockedError(host);
    return;
  }
  // Behind a proxy the proxy resolves the name; a local lookup would be meaningless
  // (e.g. fake-ip DNS) and the connect-time guard below does not apply.
  if (proxyDispatcher) return;

  const addresses = await dns.promises.lookup(host, { all: true });
  if (addresses.some((a) => isPrivateIp(a.address))) throw blockedError(host);
}

/** Connect-time DNS check, so a name cannot resolve to a public IP above and a private IP here (DNS rebinding) */
function guardedLookup(hostname: string, options: any, callback: (...args: any[]) => void) {
  dns.lookup(hostname, options, (err: any, address: any, family: any) => {
    if (err) return callback(err, address, family);
    const list: Array<{ address: string }> = Array.isArray(address)
      ? address
      : [{ address }];
    if (!ALLOWED_PRIVATE_HOSTS.has(hostname.toLowerCase()) && list.some((a) => isPrivateIp(a.address))) {
      return callback(blockedError(hostname));
    }
    callback(null, address, family);
  });
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup as any } });

/**
 * GET with manual redirect handling so every hop is validated.
 * Returns the final response and its URL.
 */
async function safeFetch(
  startUrl: string,
  signal: AbortSignal
): Promise<{ resp: Response; finalUrl: string }> {
  let current: URL;
  try {
    current = new URL(startUrl);
  } catch {
    throw new Error(`Invalid URL: "${startUrl}"`);
  }

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    await assertPublicHttpUrl(current);
    const startTime = Date.now();
    let resp: Response;
    try {
      resp = (await undiciFetch(current.href, {
        headers: getBrowserHeaders(),
        signal,
        redirect: "manual",
        dispatcher: proxyDispatcher ?? guardedAgent,
      })) as unknown as Response;
    } catch (e) {
      // undici reports only "fetch failed"; the useful reason (ECONNREFUSED, Blocked, ...) is the cause
      const cause = (e as any)?.cause;
      if ((e as Error).name !== "AbortError" && cause instanceof Error) throw cause;
      throw e;
    }
    console.log(
      `[fetch] web_fetch completed in ${getElapsedMs(startTime)}ms (${resp.status}) url="${current.href}"`
    );

    const location = resp.headers.get("location");
    if (resp.status >= 300 && resp.status < 400 && location) {
      resp.body?.cancel().catch(() => {});
      current = new URL(location, current);
      continue;
    }
    return { resp, finalUrl: current.href };
  }
  throw new Error(`Too many redirects (more than ${MAX_REDIRECT_HOPS}).`);
}

async function webFetch(
  url: string,
  maxCharSize: number = 50000,
  simplify: boolean = true
): Promise<string> {
  const startTime = Date.now();
  console.log(
    `[web_fetch] url="${url}", maxCharSize=${maxCharSize}, simplify=${simplify}`
  );
  // The timeout covers the whole flow, including reading the body and meta-refresh hops
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  const done = (result: string): string => {
    console.log(
      `[web_fetch] total completed in ${getElapsedMs(startTime)}ms, contentLength=${result.length}`
    );
    return result;
  };
  try {
    let currentUrl = url;
    for (let refreshHops = 0; ; refreshHops++) {
      const { resp, finalUrl } = await safeFetch(currentUrl, controller.signal);
      if (!resp.ok) {
        resp.body?.cancel().catch(() => {});
        throw httpError(resp);
      }

      const contentType = resp.headers.get("content-type") ?? "";
      if (!isTextContentType(contentType)) {
        resp.body?.cancel().catch(() => {});
        throw new Error(
          `Unsupported content type "${contentType.split(";")[0]}": only text and HTML pages can be fetched.`
        );
      }

      const body = await resp.text();
      if (!contentType.includes("html")) {
        return done(body.substring(0, maxCharSize));
      }

      const refreshUrl =
        refreshHops < MAX_REFRESH_HOPS ? findMetaRefresh(body, finalUrl) : null;
      if (refreshUrl) {
        currentUrl = refreshUrl;
        continue;
      }

      if (!simplify) return done(body.substring(0, maxCharSize));
      const mainContent = extractMainContent(removeUselessTags(body));
      return done(htmlToMarkdown(mainContent).substring(0, maxCharSize));
    }
  } catch (e) {
    console.error(
      `[web_fetch] total failed in ${getElapsedMs(startTime)}ms: ${(e as Error).message}`
    );
    if ((e as Error).name === "AbortError") {
      throw new Error(`Timeout: Failed to fetch "${url}" within 10 seconds.`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// MCP Server setup
// ============================================================================

export const setupMCPServer = (): McpServer => {
  const server = new McpServer(
    {
      name: "orz",
      version: "1.0.0",
    },
    { capabilities: { logging: {} } }
  );

  // Tool: web_search
  server.registerTool(
    "web_search",
    {
      title: "Web Search",
      description:
        "Search the web using DuckDuckGo. " +
        "Results are deduplicated and ads are filtered out. " +
        "Returns an array of search results with url, title, and summary.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Search keywords separated by spaces, e.g. 'deno mcp server'"
          ),
        num_results: z
          .number()
          .describe("Number of results to return (default: 8)")
          .default(8),
      },
      outputSchema: {
        query: z.string(),
        num_results: z.number(),
        total: z.number(),
        results: z.array(searchItemSchema),
      },
    },
    async ({ query, num_results }) => {
      if (!query || query.trim() === "") {
        return {
          content: [
            {
              type: "text",
              text: "Error: query parameter is required and cannot be empty.",
            },
          ],
          isError: true,
        };
      }
      try {
        const results = await webSearch(query, num_results);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          structuredContent: {
            query,
            num_results,
            total: results.length,
            results,
          },
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error: ${(e as Error).message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: web_fetch
  server.registerTool(
    "web_fetch",
    {
      title: "Web Fetch",
      description:
        "Fetch a web page and return its content. " +
        "When simplify is enabled (default), removes useless HTML tags (script, style, iframe, etc.), " +
        "extracts the main content, and converts it to clean Markdown format. " +
        "Has a 10-second timeout.",
      inputSchema: {
        url: z.string().describe("The URL to fetch"),
        max_char_size: z
          .number()
          .describe(
            "Maximum character size of the returned content (default: 50000)"
          )
          .default(50000),
        simplify: z
          .boolean()
          .describe(
            "Whether to simplify the content by removing useless tags and converting to Markdown (default: true)"
          )
          .default(true),
      },
      outputSchema: {
        url: z.string(),
        simplify: z.boolean(),
        content_length: z.number(),
        content: z.string(),
      },
    },
    async ({ url, max_char_size, simplify }) => {
      if (!url || url.trim() === "") {
        return {
          content: [
            {
              type: "text",
              text: "Error: url parameter is required and cannot be empty.",
            },
          ],
          isError: true,
        };
      }
      try {
        const content = await webFetch(url, max_char_size, simplify);
        return {
          content: [{ type: "text", text: content }],
          structuredContent: {
            url,
            simplify,
            content_length: content.length,
            content,
          },
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error: ${(e as Error).message}` },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
};
