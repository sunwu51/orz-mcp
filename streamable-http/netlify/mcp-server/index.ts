/**
 * ORZ MCP Server - Web Search & Fetch MCP Tool (Netlify Functions)
 *
 * MCP server setup with web_search and web_fetch tools.
 * - web_search: Brave, DuckDuckGo simultaneous search with dedup
 * - web_fetch: Fetch web page content, optionally simplified to Markdown
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import TurndownService from "turndown";
import { ProxyAgent, fetch as undiciFetch } from "undici";

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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

if (PROXY_URL) {
  console.log(`[streamable-http] Using proxy: ${PROXY_URL}`);
}
if (GEMINI_API_KEY) {
  console.log(`[streamable-http] Google search: Gemini API Grounding enabled`);
}

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

/** Google Search */
function parseGoogle(html: string): SearchItem[] {
  const results: SearchItem[] = [];
  if (
    html.includes("Enable JavaScript to use search") ||
    html.includes("sorry/index") ||
    html.includes("recaptcha")
  ) {
    console.log("[Google] Bot detection / JS requirement triggered, skipping");
    return results;
  }

  const h3Regex = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let match;
  while ((match = h3Regex.exec(html)) !== null) {
    const title = stripHtml(match[1]);
    const startIndex = Math.max(0, match.index - 800);
    const endIndex = Math.min(html.length, match.index + 800);
    const context = html.substring(startIndex, endIndex);

    const linkMatch =
      context.match(/<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<h3/i) ||
      context.match(/<a[^>]+href="([^"]+)"/i);

    if (!linkMatch) continue;
    let url = linkMatch[1];
    if (url.includes("/url?q=")) {
      const q = url.split("/url?q=")[1]?.split("&")[0];
      if (q) url = decodeURIComponent(q);
    }

    if (
      !url.startsWith("http") ||
      url.includes("google.com/") ||
      url.includes("gstatic.com") ||
      isAdUrl(url)
    ) {
      continue;
    }

    let summary = "";
    const snippetMatch = context.match(/class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (snippetMatch) {
      summary = stripHtml(snippetMatch[1]);
    }

    if (title && url) {
      results.push({ url, title, summary });
    }
  }
  return results;
}

// ============================================================================
// Search engine requests
// ============================================================================

/**
 * Google Search via Gemini API Grounding
 * 当配置了 GEMINI_API_KEY 时使用 Google 官方 Search Grounding（每月 5000 次免费搜索，免被爬虫拦截）
 */
async function searchGoogleGemini(query: string): Promise<SearchItem[]> {
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const payload = {
      contents: [
        {
          parts: [
            {
              text: `Search the web and provide detailed summary with sources for: "${query}"`,
            },
          ],
        },
      ],
      tools: [
        {
          google_search: {},
        },
      ],
    };

    const resp = await timedFetch("Google Gemini search", endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.error(`[Google Gemini] HTTP ${resp.status}: ${await resp.text()}`);
      return [];
    }

    const data = (await resp.json()) as any;
    const candidate = data.candidates?.[0];
    const groundingMetadata = candidate?.groundingMetadata;
    const chunks = groundingMetadata?.groundingChunks || [];

    const modelText =
      candidate?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("\n") || "";

    const supports = groundingMetadata?.groundingSupports || [];
    const chunkSummaries = new Map<number, string[]>();
    for (const support of supports) {
      const indices: number[] = support.groundingChunkIndices || [];
      const text = support.segment?.text?.trim();
      if (!text) continue;
      for (const idx of indices) {
        if (!chunkSummaries.has(idx)) {
          chunkSummaries.set(idx, []);
        }
        chunkSummaries.get(idx)!.push(text);
      }
    }

    const rawItems: SearchItem[] = [];
    const seenUris = new Set<string>();

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const uri = chunk.web?.uri;
      const title = chunk.web?.title || "";
      if (uri && !seenUris.has(uri) && !isAdUrl(uri)) {
        seenUris.add(uri);
        const specificTexts = chunkSummaries.get(i);
        const specificSummary =
          specificTexts && specificTexts.length > 0
            ? specificTexts.join(" ").slice(0, 300)
            : modelText.slice(0, 300);

        rawItems.push({
          url: uri,
          title: title || uri,
          summary: specificSummary,
        });
      }
    }

    const results = await Promise.all(
      rawItems.map(async (item) => {
        if (item.url.includes("grounding-api-redirect")) {
          try {
            const redirectResp = await timedFetch("Unwrap redirect", item.url, {
              method: "GET",
              redirect: "manual",
              signal: AbortSignal.timeout(3000),
            });
            const location = redirectResp.headers.get("location");
            if (location && location.startsWith("http")) {
              return { ...item, url: location };
            }
          } catch {
            // 失败时保持原 url
          }
        }
        return item;
      })
    );

    return results;
  } catch (e) {
    console.error("[Google Gemini] search error:", (e as Error).message);
    return [];
  }
}

async function searchGoogle(query: string): Promise<SearchItem[]> {
  if (!GEMINI_API_KEY) {
    return [];
  }
  return searchGoogleGemini(query);
}



async function fetchDuckDuckGoHtml(url: string): Promise<string> {
  const resp = await timedFetch("DuckDuckGo search", url, {
    headers: getBrowserHeaders(),
    signal: AbortSignal.timeout(10000),
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
  source: string
): Promise<DuckDuckGoSearchAttempt> {
  try {
    console.log(`[DuckDuckGo] Trying ${source}: ${url}`);
    const html = await fetchDuckDuckGoHtml(url);

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

async function retryDuckDuckGoViaFallbacks(query: string): Promise<SearchItem[]> {
  const fallbackBaseUrls = [...DUCKDUCKGO_FALLBACK_SEARCH_URLS].sort(() => Math.random() - 0.5);
  for (const fallbackBaseUrl of fallbackBaseUrls) {
    const fallbackUrl = buildDuckDuckGoSearchUrl(fallbackBaseUrl, query);
    const attempt = await tryDuckDuckGoSearchUrl(fallbackUrl, "fallback");
    if (attempt.kind === "success" || attempt.kind === "empty") {
      return attempt.results;
    }
    if (attempt.kind !== "captcha") {
      return [];
    }
  }

  return [];
}

async function searchDuckDuckGo(query: string): Promise<SearchItem[]> {
  const primaryUrl = buildDuckDuckGoSearchUrl(DUCKDUCKGO_HTML_SEARCH_URL, query);
  const primaryAttempt = await tryDuckDuckGoSearchUrl(primaryUrl, "primary");

  if (primaryAttempt.kind === "success" || primaryAttempt.kind === "empty") {
    return primaryAttempt.results;
  }

  if (primaryAttempt.kind !== "captcha") {
    return [];
  }

  return retryDuckDuckGoViaFallbacks(query);
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
    const tasks: Promise<SearchItem[]>[] = [];
    const engineNames: string[] = [];

    if (GEMINI_API_KEY) {
      tasks.push(searchGoogle(query));
      engineNames.push("Google");
    }

    tasks.push(searchDuckDuckGo(query));
    engineNames.push("DuckDuckGo");

    const engineResults = await Promise.allSettled(tasks);
    const allResults: SearchItem[][] = [];
    for (let i = 0; i < engineResults.length; i++) {
      const result = engineResults[i];
      if (result.status === "fulfilled") {
        allResults.push(result.value);
        console.log(
          `[web_search] ${engineNames[i]}: ${result.value.length} results`
        );
      } else {
        console.log(
          `[web_search] ${engineNames[i]}: failed - ${result.reason}`
        );
      }
    }

    const mergedResults = mergeAndDeduplicate(allResults, numResults);
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

function removeUselessTags(html: string): string {
  const tagsToRemove = [
    "script",
    "style",
    "iframe",
    "noscript",
    "svg",
    "object",
    "embed",
    "applet",
    "link",
    "meta",
    "head",
    "nav",
    "footer",
    "aside",
  ];
  let cleaned = html;
  for (const tag of tagsToRemove) {
    const regex = new RegExp(`<${tag}[\\s\\S]*?(?:<\\/${tag}>|\\/>)`, "gi");
    cleaned = cleaned.replace(regex, "");
  }
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
  return cleaned;
}

function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
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

function extractMainContent(html: string): string {
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return mainMatch[1];
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) return articleMatch[1];
  const contentMatch = html.match(
    /<div[^>]*id=["']content["'][^>]*>([\s\S]*?)<\/div>/i
  );
  if (contentMatch) return contentMatch[1];
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1];
  return html;
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await timedFetch("web_fetch", url, {
      headers: getBrowserHeaders(),
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      const text = await resp.text();
      const result = text.substring(0, maxCharSize);
      console.log(
        `[web_fetch] total completed in ${getElapsedMs(startTime)}ms, contentLength=${result.length}`
      );
      return result;
    }
    let html = await resp.text();
    if (simplify) {
      html = removeUselessTags(html);
      const mainContent = extractMainContent(html);
      const markdown = htmlToMarkdown(mainContent);
      const result = markdown.substring(0, maxCharSize);
      console.log(
        `[web_fetch] total completed in ${getElapsedMs(startTime)}ms, contentLength=${result.length}`
      );
      return result;
    } else {
      const result = html.substring(0, maxCharSize);
      console.log(
        `[web_fetch] total completed in ${getElapsedMs(startTime)}ms, contentLength=${result.length}`
      );
      return result;
    }
  } catch (e) {
    clearTimeout(timeoutId);
    console.error(
      `[web_fetch] total failed in ${getElapsedMs(startTime)}ms: ${(e as Error).message}`
    );
    if ((e as Error).name === "AbortError") {
      throw new Error(`Timeout: Failed to fetch "${url}" within 10 seconds.`);
    }
    throw e;
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
        "Search the web using search engines (DuckDuckGo, and Google when GEMINI_API_KEY is configured) simultaneously. " +
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
