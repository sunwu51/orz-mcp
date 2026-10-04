#!/usr/bin/env node

/**
 * ORZ MCP Server - Web Search & Fetch (stdio / Node.js)
 *
 * 本地运行的 MCP 服务器，通过 stdio 与客户端通信。
 * 提供 web_search 和 web_fetch 两个工具。
 *
 * 特性:
 * - 支持 HTTP/HTTPS 代理（命令行参数 --proxy 或环境变量兜底）
 *   方便国内用户通过 VPN 访问 Brave 等海外搜索引擎
 * - 同时查询 Brave、DuckDuckGo，合并去重
 * - 抓取网页内容，可选简化为 Markdown
 *
 * 使用:
 *   npx -y orz-mcp
 *   npx -y orz-mcp --proxy http://127.0.0.1:7890
 *
 * MCP 客户端配置:
 *   {
 *     "mcpServers": {
 *       "orz": {
 *         "command": "npx",
 *         "args": ["-y", "orz-mcp", "--proxy", "http://127.0.0.1:7890"]
 *       }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import TurndownService from "turndown";
import { ProxyAgent, fetch as undiciFetch } from "undici";

// ============================================================================
// 命令行参数解析
// ============================================================================

/**
 * 解析 --proxy <url> 参数
 * 优先级: --proxy 命令行参数 > 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 */
function parseArgs() {
  const args = process.argv.slice(2);
  let proxy = "";
  let geminiApiKey = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--proxy" && i + 1 < args.length) {
      proxy = args[i + 1];
      i++;
    } else if (args[i].startsWith("--proxy=")) {
      proxy = args[i].slice("--proxy=".length);
    } else if (args[i] === "--gemini-api-key" && i + 1 < args.length) {
      geminiApiKey = args[i + 1];
      i++;
    } else if (args[i].startsWith("--gemini-api-key=")) {
      geminiApiKey = args[i].slice("--gemini-api-key=".length);
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.error(`
ORZ MCP Server - Web Search & Fetch

Usage:
  npx -y orz-mcp [options]

Options:
  --proxy <url>             HTTP/HTTPS proxy URL (e.g. http://127.0.0.1:7890)
  --gemini-api-key <key>    Google Gemini API Key (uses official Google Search Grounding)
  -h, --help                Show this help message

Environment variables:
  GEMINI_API_KEY            Google Gemini API Key
  HTTPS_PROXY, HTTP_PROXY, ALL_PROXY

Examples:
  npx -y orz-mcp --gemini-api-key AIzaSy...
  npx -y orz-mcp --proxy http://127.0.0.1:7890
`);
      process.exit(0);
    }
  }

  return { proxy, geminiApiKey };
}

// ============================================================================
// 代理与 API 配置
// ============================================================================

const cliArgs = parseArgs();

const GEMINI_API_KEY = cliArgs.geminiApiKey || process.env.GEMINI_API_KEY || "";

const PROXY_URL =
  cliArgs.proxy ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy ||
  "";

/** 如果配置了代理，创建 undici ProxyAgent 作为 dispatcher */
const proxyDispatcher = PROXY_URL
  ? new ProxyAgent(PROXY_URL)
  : undefined;

if (PROXY_URL) {
  console.error(`[orz] proxy: ${PROXY_URL}`);
}
if (GEMINI_API_KEY) {
  console.error(`[orz] Google search: Gemini API Grounding enabled`);
}

// ============================================================================
// 带代理支持的 fetch 封装
// ============================================================================

/**
 * 带代理的 fetch 封装
 * 使用 undici.fetch + ProxyAgent dispatcher 实现代理支持
 */
function proxyFetch(url, options = {}) {
  const fetchOptions = { ...options };
  if (proxyDispatcher) {
    fetchOptions.dispatcher = proxyDispatcher;
  }
  return undiciFetch(url, fetchOptions);
}

// ============================================================================
// 常量与配置
// ============================================================================

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBrowserHeaders() {
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
// HTML 工具函数
// ============================================================================

function decodeHtmlEntities(text) {
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

function stripHtml(html) {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, "")).trim();
}

// ============================================================================
// 广告过滤
// ============================================================================

function isAdUrl(url) {
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
// 搜索引擎解析
// ============================================================================

/** DuckDuckGo */

/** DuckDuckGo */
function parseDuckDuckGo(html) {
  const results = [];

  if (
    html.includes("anomaly-modal") ||
    html.includes("Please complete the following challenge")
  ) {
    console.error("[DuckDuckGo] Got captcha page, skipping");
    return results;
  }

  const linkRegex =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const links = [];
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    links.push({ rawUrl: linkMatch[1], title: stripHtml(linkMatch[2]) });
  }

  const snippets = [];
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

    if (url.includes("duckduckgo.com/y.js") || isAdUrl(url)) continue;

    const summary = i < snippets.length ? snippets[i] : "";
    if (title && url) results.push({ url, title, summary });
  }
  return results;
}

/** Google Search */
function parseGoogle(html) {
  const results = [];
  if (
    html.includes("Enable JavaScript to use search") ||
    html.includes("sorry/index") ||
    html.includes("recaptcha")
  ) {
    console.error("[Google] Bot detection / JS requirement triggered, skipping");
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
// 搜索引擎请求
// ============================================================================

/**
 * Google Search via Gemini API Grounding
 * 当配置了 GEMINI_API_KEY 时使用 Google 官方 Search Grounding（每月 5000 次免费搜索，免被爬虫拦截）
 */
async function searchGoogleGemini(query) {
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

    const resp = await proxyFetch(endpoint, {
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

    const data = await resp.json();
    const candidate = data.candidates?.[0];
    const groundingMetadata = candidate?.groundingMetadata;
    const chunks = groundingMetadata?.groundingChunks || [];

    // 提炼模型输出的整体总结作为通用 fallback summary
    const modelText =
      candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n") || "";

    const rawItems = [];
    const seenUris = new Set();

    for (const chunk of chunks) {
      const uri = chunk.web?.uri;
      const title = chunk.web?.title || "";
      if (uri && !seenUris.has(uri) && !isAdUrl(uri)) {
        seenUris.add(uri);
        rawItems.push({
          url: uri,
          title: title || uri,
          summary: modelText.slice(0, 300),
        });
      }
    }

    // 并发还原 Google 重定向真实 URL，确保跨引擎 URL 去重精准生效
    const results = await Promise.all(
      rawItems.map(async (item) => {
        if (item.url.includes("grounding-api-redirect")) {
          try {
            const redirectResp = await proxyFetch(item.url, {
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
    console.error("[Google Gemini] search error:", e.message);
    return [];
  }
}

async function searchGoogle(query) {
  // 只有配置了 GEMINI_API_KEY 时才开启 Google 搜索（走 Google 官方 Search Grounding，每月 5000 次免费额度）
  if (!GEMINI_API_KEY) {
    return [];
  }
  return searchGoogleGemini(query);
}

async function searchDuckDuckGo(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await proxyFetch(url, {
      headers: getBrowserHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    return parseDuckDuckGo(await resp.text());
  } catch (e) {
    console.error("[DuckDuckGo] search error:", e.message);
    return [];
  }
}

// ============================================================================
// 去重合并
// ============================================================================

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "fbclid", "gclid", "msclkid", "spm", "from",
    ];
    const params = new URLSearchParams(parsed.search);
    for (const tp of trackingParams) params.delete(tp);
    const search = params.toString() ? `?${params.toString()}` : "";
    // 注意：parsed.hash 默认被丢弃（不拼入返回值），从而完全忽略 #xxx 页面锚点/哈希定位
    return `${host}${path}${search}`.toLowerCase();
  } catch {
    // 降级兜底：去除末尾的 # 及其后面的部分
    return url.split("#")[0].toLowerCase();
  }
}

function mergeAndDeduplicate(allResults, maxResults) {
  const seen = new Set();
  const merged = [];
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

async function webSearch(query, numResults = 8) {
  console.error(`[web_search] query="${query}", numResults=${numResults}`);

  const tasks = [];
  const engineNames = [];

  if (GEMINI_API_KEY) {
    tasks.push(searchGoogle(query));
    engineNames.push("Google");
  }

  tasks.push(searchDuckDuckGo(query));
  engineNames.push("DuckDuckGo");

  const results = await Promise.allSettled(tasks);
  const allResults = [];

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const name = engineNames[i];
    if (res.status === "fulfilled") {
      allResults.push(res.value);
      console.error(`[web_search] ${name}: ${res.value.length} results`);
    } else {
      console.error(`[web_search] ${name}: failed - ${res.reason}`);
    }
  }

  return mergeAndDeduplicate(allResults, numResults);
}

// ============================================================================
// web_fetch
// ============================================================================

function removeUselessTags(html) {
  const tags = [
    "script", "style", "iframe", "noscript", "svg",
    "object", "embed", "applet", "link", "meta",
    "head", "nav", "footer", "aside",
  ];
  let cleaned = html;
  for (const tag of tags) {
    cleaned = cleaned.replace(
      new RegExp(`<${tag}[\\s\\S]*?(?:<\\/${tag}>|\\/>)`, "gi"),
      ""
    );
  }
  return cleaned.replace(/<!--[\s\S]*?-->/g, "");
}

function htmlToMarkdown(html) {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.remove(["script", "style", "iframe", "noscript", "svg", "nav", "footer"]);
  try {
    let md = td.turndown(html);
    md = md.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "");
    return md.trim();
  } catch {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

function extractMainContent(html) {
  for (const [tag] of [["main"], ["article"]]) {
    const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (m) return m[1];
  }
  const contentMatch = html.match(
    /<div[^>]*id=["']content["'][^>]*>([\s\S]*?)<\/div>/i
  );
  if (contentMatch) return contentMatch[1];
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1];
  return html;
}

async function webFetch(url, maxCharSize = 50000, simplify = true) {
  console.error(
    `[web_fetch] url="${url}", maxCharSize=${maxCharSize}, simplify=${simplify}`
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await proxyFetch(url, {
      headers: getBrowserHeaders(),
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeoutId);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      return (await resp.text()).substring(0, maxCharSize);
    }

    let html = await resp.text();
    if (simplify) {
      html = removeUselessTags(html);
      const main = extractMainContent(html);
      return htmlToMarkdown(main).substring(0, maxCharSize);
    }
    return html.substring(0, maxCharSize);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error(`Timeout: Failed to fetch "${url}" within 10 seconds.`);
    }
    throw e;
  }
}

// ============================================================================
// MCP 工具定义
// ============================================================================

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web using search engines (DuckDuckGo, and Google when GEMINI_API_KEY is configured) simultaneously. " +
      "Results are deduplicated and ads are filtered out. " +
      "Returns an array of search results with url, title, and summary.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keywords separated by spaces",
        },
        num_results: {
          type: "number",
          description: "Number of results to return (default: 8)",
          default: 8,
        },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
        },
        num_results: {
          type: "number",
        },
        total: {
          type: "number",
        },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              title: { type: "string" },
              summary: { type: "string" },
            },
            required: ["url", "title", "summary"],
          },
        },
      },
      required: ["query", "num_results", "total", "results"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a web page and return its content. " +
      "When simplify is enabled (default), removes useless HTML tags and converts to Markdown. " +
      "Has a 10-second timeout.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        max_char_size: {
          type: "number",
          description:
            "Maximum character size of the returned content (default: 50000)",
          default: 50000,
        },
        simplify: {
          type: "boolean",
          description:
            "Whether to simplify the content by removing useless tags and converting to Markdown (default: true)",
          default: true,
        },
      },
      required: ["url"],
    },
    outputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
        },
        simplify: {
          type: "boolean",
        },
        content_length: {
          type: "number",
        },
        content: {
          type: "string",
        },
      },
      required: ["url", "simplify", "content_length", "content"],
    },
  },
];

// ============================================================================
// 工具调用处理
// ============================================================================

async function handleToolCall(name, args) {
  switch (name) {
    case "web_search": {
      const query = args.query;
      const numResults = args.num_results ?? 8;
      if (!query || query.trim() === "") {
        return {
          content: [{ type: "text", text: "Error: query is required." }],
          isError: true,
        };
      }
      try {
        const results = await webSearch(query, numResults);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          structuredContent: {
            query,
            num_results: numResults,
            total: results.length,
            results,
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    }
    case "web_fetch": {
      const url = args.url;
      const maxCharSize = args.max_char_size ?? 50000;
      const simplify = args.simplify ?? true;
      if (!url || url.trim() === "") {
        return {
          content: [{ type: "text", text: "Error: url is required." }],
          isError: true,
        };
      }
      try {
        const content = await webFetch(url, maxCharSize, simplify);
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
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    }
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

// ============================================================================
// MCP Server 启动 (stdio)
// ============================================================================

const server = new Server(
  { name: "orz", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, (request) =>
  handleToolCall(request.params.name, request.params.arguments ?? {})
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[orz] MCP server running on stdio");

