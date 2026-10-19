#!/usr/bin/env node

/**
 * ORZ MCP Server - Web Search & Fetch (stdio / Node.js)
 *
 * 本地运行的 MCP 服务器，通过 stdio 与客户端通信。
 * 提供 web_search 和 web_fetch 两个工具。
 *
 * 特性:
 * - 支持 HTTP/HTTPS 代理（命令行参数 --proxy 或环境变量兜底）
 *   方便国内用户通过 VPN 访问海外搜索引擎
 * - 通过 DuckDuckGo 搜索，过滤广告
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
import { gfm } from "turndown-plugin-gfm";
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--proxy" && i + 1 < args.length) {
      proxy = args[i + 1];
      i++;
    } else if (args[i].startsWith("--proxy=")) {
      proxy = args[i].slice("--proxy=".length);
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.error(`
ORZ MCP Server - Web Search & Fetch

Usage:
  npx -y orz-mcp [options]

Options:
  --proxy <url>             HTTP/HTTPS proxy URL (e.g. http://127.0.0.1:7890)
  -h, --help                Show this help message

Environment variables:
  HTTPS_PROXY, HTTP_PROXY, ALL_PROXY

Examples:
  npx -y orz-mcp --proxy http://127.0.0.1:7890
`);
      process.exit(0);
    }
  }

  return { proxy };
}

// ============================================================================
// 代理配置
// ============================================================================

const cliArgs = parseArgs();

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
    // 非内容类的第三方/基础设施链接
    /\/\/platform\.twitter\.com/i,
    /\/\/analytics\./i,
    /\/cdn-cgi\//i,
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

// ============================================================================
// 搜索引擎请求
// ============================================================================

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

  const results = await searchDuckDuckGo(query);
  console.error(`[web_search] DuckDuckGo: ${results.length} results`);

  return mergeAndDeduplicate([results], numResults);
}

// ============================================================================
// web_fetch
// ============================================================================

/** meta refresh 最多跟随的次数 */
const MAX_REFRESH_HOPS = 2;

/** 有成对闭合标签的噪音标签 */
const PAIRED_NOISE_TAGS = [
  "script", "style", "iframe", "noscript", "svg",
  "object", "embed", "applet", "head", "nav", "footer", "aside",
];
/** 没有闭合标签的噪音标签（void element） */
const VOID_NOISE_TAGS = ["meta", "link"];

/**
 * 删除噪音标签。
 * 标签名后用 (?=[\s/>]) 限定边界，避免 <head 误匹配 <header；
 * void 标签（<link>、<meta>）不能按「到下一个 />」懒匹配，否则会吞掉后面的正文。
 */
function removeUselessTags(html) {
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

function htmlToMarkdown(html) {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.use(gfm);
  // 默认规则只处理 <pre><code>，裸 <pre> 会丢换行；统一取 textContent 保留原始排版
  td.addRule("preBlock", {
    filter: "pre",
    replacement: (_content, node) => {
      const cls =
        node.querySelector?.("code")?.getAttribute("class") ||
        node.getAttribute("class") ||
        "";
      const lang = cls.match(/(?:language|lang)-([\w+#-]+)/)?.[1] ?? "";
      const text = (node.textContent ?? "").replace(/\n$/, "");
      const fence = text.includes("```") ? "~~~" : "```";
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
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

/**
 * 从 from 位置起找第一个匹配 openRe 的元素，按同名标签嵌套深度配对其闭合标签。
 * 返回内部 HTML 与元素结束位置；找不到开始标签返回 null，未闭合则取到文末。
 */
function findBalanced(html, openRe, from = 0) {
  const open = new RegExp(openRe.source, openRe.flags.replace("g", "") + "g");
  open.lastIndex = from;
  const m = open.exec(html);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const start = m.index + m[0].length;
  const tagRe = new RegExp(`<(\\/?)${tag}(?=[\\s/>])[^>]*>`, "gi");
  tagRe.lastIndex = start;
  let depth = 1;
  let t;
  while ((t = tagRe.exec(html)) !== null) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) {
      return { inner: html.slice(start, t.index), end: t.index + t[0].length };
    }
  }
  return { inner: html.slice(start), end: html.length };
}

function visibleTextLength(html) {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
}

function extractMainContent(html) {
  const body = findBalanced(html, /<(body)\b[^>]*>/i)?.inner ?? html;
  const bodyLen = visibleTextLength(body);

  let candidate = findBalanced(html, /<(main)\b[^>]*>/i)?.inner ?? null;
  if (candidate === null) {
    // 没有 <main> 时，保留全部 <article>（列表页每个条目都是一个 article）
    const articles = [];
    for (let pos = 0, a; (a = findBalanced(html, /<(article)\b[^>]*>/i, pos)); pos = a.end) {
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

  // 候选区域几乎没有文字（例如只命中了一张卡片）时回退到整个 body
  if (candidate !== null) {
    const len = visibleTextLength(candidate);
    if (len >= 200 || len >= bodyLen * 0.3) return candidate;
  }
  return body;
}

/** 非文本类型（PDF、图片、压缩包等）无法转换，明确报错而不是返回乱码 */
function isTextContentType(contentType) {
  if (!contentType) return true;
  return /^text\/|json|xml|javascript|yaml|toml|markdown|x-www-form-urlencoded/i.test(contentType);
}

/** 解析 <meta http-equiv="refresh" content="0; url=..."> 的跳转目标；页面有实际内容时不跟随 */
function findMetaRefresh(html, baseUrl) {
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

function httpError(resp) {
  let msg = `HTTP ${resp.status}${resp.statusText ? `: ${resp.statusText}` : ""}`;
  if ([401, 403, 429, 503].includes(resp.status)) {
    msg += " (the site refused the request; it may block automated access — try a proxy via --proxy or another source)";
  }
  return new Error(msg);
}

async function webFetch(url, maxCharSize = 50000, simplify = true) {
  console.error(
    `[web_fetch] url="${url}", maxCharSize=${maxCharSize}, simplify=${simplify}`
  );

  // 超时覆盖整个流程（含读取 body 与 meta refresh 跳转）
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    let currentUrl = url;
    for (let refreshHops = 0; ; refreshHops++) {
      let resp;
      try {
        resp = await proxyFetch(currentUrl, {
          headers: getBrowserHeaders(),
          signal: controller.signal,
          redirect: "follow",
        });
      } catch (e) {
        // undici 只报 "fetch failed"，真正原因（ECONNREFUSED、ENOTFOUND 等）在 cause 里
        if (e.name !== "AbortError" && e.cause instanceof Error) throw e.cause;
        throw e;
      }
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
      if (!contentType.includes("html")) return body.substring(0, maxCharSize);

      const refreshUrl =
        refreshHops < MAX_REFRESH_HOPS ? findMetaRefresh(body, resp.url || currentUrl) : null;
      if (refreshUrl) {
        currentUrl = refreshUrl;
        continue;
      }

      if (!simplify) return body.substring(0, maxCharSize);
      const main = extractMainContent(removeUselessTags(body));
      return htmlToMarkdown(main).substring(0, maxCharSize);
    }
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Timeout: Failed to fetch "${url}" within 10 seconds.`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// MCP 工具定义
// ============================================================================

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web using DuckDuckGo. " +
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

