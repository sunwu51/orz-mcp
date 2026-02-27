/**
 * ORZ MCP Server - Web Search & Fetch MCP Tool (Netlify Functions)
 *
 * MCP server setup with web_search and web_fetch tools.
 * - web_search: Brave, Sogou, DuckDuckGo simultaneous search with dedup
 * - web_fetch: Fetch web page content, optionally simplified to Markdown
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import TurndownService from "turndown";

// ============================================================================
// Constants & Config
// ============================================================================

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

function getRandomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBrowserHeaders(): Record<string, string> {
  return {
    "User-Agent": getRandomUA(),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
}

// ============================================================================
// Search result types
// ============================================================================

interface SearchItem {
  url: string;
  title: string;
  summary: string;
}

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

function parseBrave(html: string): SearchItem[] {
  const results: SearchItem[] = [];
  const blocks = html.split('data-type="web"');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].substring(0, 5000);
    const urlMatch = block.match(
      /<a[^>]+href="(https?:\/\/(?!search\.brave\.com|brave\.com)[^"]+)"/
    );
    if (!urlMatch) continue;
    const url = decodeHtmlEntities(urlMatch[1]);
    const aTagMatch = block.match(
      /<a[^>]+href="(https?:\/\/(?!search\.brave\.com|brave\.com)[^"]+)"[^>]*>([\s\S]*?)<\/a>/
    );
    const title = aTagMatch ? stripHtml(aTagMatch[2]) : "";
    let summary = "";
    const descMatch = block.match(
      /class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div|span)>/
    );
    if (descMatch) {
      summary = stripHtml(descMatch[1]);
    }
    if (!summary) {
      const genericMatch = block.match(
        /class="[^"]*generic-snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/
      );
      if (genericMatch) {
        summary = stripHtml(genericMatch[1]);
      }
    }
    if (title && title.length > 1 && url) {
      results.push({ url, title, summary });
    }
  }
  return results;
}

function parseSogou(html: string): SearchItem[] {
  const results: SearchItem[] = [];
  const blocks = html.split('class="vrwrap"');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].substring(0, 5000);
    const h3Match = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!h3Match) continue;
    const linkMatch = h3Match[1].match(
      /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
    );
    if (!linkMatch) continue;
    let url = decodeHtmlEntities(linkMatch[1]);
    const title = stripHtml(linkMatch[2]);
    if (!title) continue;
    if (url.startsWith("/link?")) {
      url = "https://www.sogou.com" + url;
    }
    let summary = "";
    const summaryPatterns = [
      /class="[^"]*text-layout[^"]*"[^>]*>([\s\S]*?)<\/div>/,
      /class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/div>/,
      /class="[^"]*str[-_]text[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/,
    ];
    for (const pat of summaryPatterns) {
      const m = block.match(pat);
      if (m) {
        const text = stripHtml(m[1]);
        if (text.length > 10) {
          summary = text;
          break;
        }
      }
    }
    results.push({ url, title, summary });
  }
  return results;
}

function parseDuckDuckGo(html: string): SearchItem[] {
  const results: SearchItem[] = [];
  if (
    html.includes("anomaly-modal") ||
    html.includes("Please complete the following challenge")
  ) {
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

async function searchBrave(query: string): Promise<SearchItem[]> {
  try {
    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: getBrowserHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseBrave(html);
  } catch (e) {
    console.error("[Brave] search error:", (e as Error).message);
    return [];
  }
}

async function searchSogou(query: string): Promise<SearchItem[]> {
  try {
    const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: getBrowserHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseSogou(html);
  } catch (e) {
    console.error("[Sogou] search error:", (e as Error).message);
    return [];
  }
}

async function searchDuckDuckGo(query: string): Promise<SearchItem[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: getBrowserHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseDuckDuckGo(html);
  } catch (e) {
    console.error("[DuckDuckGo] search error:", (e as Error).message);
    return [];
  }
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
    return `${host}${path}${search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
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
  console.log(`[web_search] query="${query}", numResults=${numResults}`);
  const [brave, sogou, ddg] = await Promise.allSettled([
    searchBrave(query),
    searchSogou(query),
    searchDuckDuckGo(query),
  ]);
  const allResults: SearchItem[][] = [];
  const engineNames = ["Brave", "Sogou", "DuckDuckGo"];
  const engineResults = [brave, sogou, ddg];
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
  return mergeAndDeduplicate(allResults, numResults);
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
  console.log(
    `[web_fetch] url="${url}", maxCharSize=${maxCharSize}, simplify=${simplify}`
  );
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
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
      return text.substring(0, maxCharSize);
    }
    let html = await resp.text();
    if (simplify) {
      html = removeUselessTags(html);
      const mainContent = extractMainContent(html);
      const markdown = htmlToMarkdown(mainContent);
      return markdown.substring(0, maxCharSize);
    } else {
      return html.substring(0, maxCharSize);
    }
  } catch (e) {
    clearTimeout(timeoutId);
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
  server.tool(
    "web_search",
    "Search the web using multiple search engines (Brave, Sogou, DuckDuckGo) simultaneously. " +
      "Results are deduplicated and ads are filtered out. " +
      "Returns an array of search results with url, title, and summary.",
    {
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
    async ({ query, num_results }): Promise<CallToolResult> => {
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
          content: [
            { type: "text", text: JSON.stringify(results, null, 2) },
          ],
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
  server.tool(
    "web_fetch",
    "Fetch a web page and return its content. " +
      "When simplify is enabled (default), removes useless HTML tags (script, style, iframe, etc.), " +
      "extracts the main content, and converts it to clean Markdown format. " +
      "Has a 10-second timeout.",
    {
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
    async ({ url, max_char_size, simplify }): Promise<CallToolResult> => {
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
