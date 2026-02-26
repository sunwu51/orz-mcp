/**
 * ORZ MCP Server - Web Search & Fetch MCP Tool (Remote / Deno Deploy)
 *
 * 一个基于 Deno 的远程 MCP 服务器，提供 web_search 和 web_fetch 两个工具。
 * 使用 Streamable HTTP 传输协议，适合部署到 Deno Deploy。
 *
 * - web_search: 同时查询 Brave、搜狗、DuckDuckGo，合并去重结果
 *   (Google/Bing/百度 在服务端环境依赖 JS 渲染或返回验证码，无法直接抓取)
 * - web_fetch: 抓取网页内容，可选简化为 Markdown 格式
 *
 * 本地运行:
 *   deno run --allow-net --allow-env server.ts
 *
 * 部署到 Deno Deploy:
 *   直接将此文件作为入口部署即可
 *
 * MCP 客户端配置:
 *   { "mcpServers": { "orz": { "url": "https://<your-deploy-url>/mcp" } } }
 */

import { Server } from "npm:@modelcontextprotocol/sdk@1.12.0/server/index.js";
import { StreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.12.0/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolRequest,
} from "npm:@modelcontextprotocol/sdk@1.12.0/types.js";
import TurndownService from "npm:turndown@7.2.0";
import { Hono, type Context } from "npm:hono@4.7.0";
import { cors } from "npm:hono@4.7.0/cors";
import { toFetchResponse, toReqRes } from "npm:fetch-to-node@2.1.0";

// ============================================================================
// 常量与配置
// ============================================================================

/** 模拟浏览器的 User-Agent，避免被 429 限制 */
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

function getRandomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/** 通用 fetch headers，模拟浏览器请求 */
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
// 搜索结果类型定义
// ============================================================================

/** 单条搜索结果 */
export interface SearchItem {
  url: string;
  title: string;
  summary: string;
}

// ============================================================================
// HTML 实体解码
// ============================================================================

/** 解码常见的 HTML 实体 */
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

/** 清理 HTML 标签并解码实体 */
function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, "")).trim();
}

// ============================================================================
// 广告过滤规则
// ============================================================================

/**
 * 判断一个 URL 是否为广告链接
 * 通过域名关键词和路径特征来识别广告
 */
export function isAdUrl(url: string): boolean {
  const adPatterns = [
    // 广告平台域名
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
    // 百度广告
    /baidu\.com\/aclick/i,
    /pos\.baidu\.com/i,
    /cpro\.baidu\.com/i,
    /e\.baidu\.com/i,
    // Bing 广告
    /bingads\./i,
    /microsoftadvertising\./i,
    // DuckDuckGo 广告（URL 中包含 ad_provider / ad_domain）
    /ad_provider=/i,
    /ad_domain=/i,
    // 通用广告路径特征
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
// 搜索引擎解析 — 每个解析函数只负责 HTML -> SearchItem[]
// 网络请求在外层统一处理，便于测试
// ============================================================================

/**
 * 解析 Brave Search 的 HTML 结果
 *
 * 结构: 每个搜索结果块以 data-type="web" 分隔
 * - URL: 第一个 <a href="https://...">
 * - 标题: <a> 内的文本
 * - 摘要: class 中包含 "snippet" 的 <div> 内的 <div class="...description..."> 文本
 *         或退而求其次: 块内第一段较长纯文本
 */
export function parseBrave(html: string): SearchItem[] {
  const results: SearchItem[] = [];

  const blocks = html.split('data-type="web"');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].substring(0, 5000); // 只看前 5000 字符

    // URL: 第一个非 Brave 站内的 https 链接
    const urlMatch = block.match(
      /<a[^>]+href="(https?:\/\/(?!search\.brave\.com|brave\.com)[^"]+)"/
    );
    if (!urlMatch) continue;
    const url = decodeHtmlEntities(urlMatch[1]);

    // 标题: 该 <a> 标签内的文本
    const aTagMatch = block.match(
      /<a[^>]+href="(https?:\/\/(?!search\.brave\.com|brave\.com)[^"]+)"[^>]*>([\s\S]*?)<\/a>/
    );
    const title = aTagMatch ? stripHtml(aTagMatch[2]) : "";

    // 摘要: 找 class 中含 "snippet" 的容器内文本
    let summary = "";
    const descMatch = block.match(
      /class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div|span)>/
    );
    if (descMatch) {
      summary = stripHtml(descMatch[1]);
    }
    if (!summary) {
      // 兜底: class 含 "generic-snippet" 的 div
      const genericMatch = block.match(
        /class="[^"]*generic-snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/
      );
      if (genericMatch) {
        summary = stripHtml(genericMatch[1]);
      }
    }

    // 过滤掉没有标题或 title 太短的噪声
    if (title && title.length > 1 && url) {
      results.push({ url, title, summary });
    }
  }
  return results;
}

/**
 * 解析搜狗搜索的 HTML 结果
 *
 * 结构: 每个搜索结果在 class="vrwrap" 的块内
 * - 标题: <h3 class="vr-title"> 内 <a href="...">title</a>
 * - URL: 搜狗跳转链接 (/link?url=...) 或完整 URL
 * - 摘要: class 含 "text-layout" 或 "summary" 的 div
 *
 * 注意: 部分块是视频/电影等特殊卡片（无 h3），直接跳过
 */
export function parseSogou(html: string): SearchItem[] {
  const results: SearchItem[] = [];

  const blocks = html.split('class="vrwrap"');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].substring(0, 5000);

    // 提取 <h3> 中的标题和链接（没有 h3 的是特殊卡片，跳过）
    const h3Match = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!h3Match) continue;

    const linkMatch = h3Match[1].match(
      /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
    );
    if (!linkMatch) continue;

    let url = decodeHtmlEntities(linkMatch[1]);
    const title = stripHtml(linkMatch[2]);
    if (!title) continue;

    // URL 处理: 搜狗的相对路径需要补全域名
    if (url.startsWith("/link?")) {
      url = "https://www.sogou.com" + url;
    }

    // 摘要提取: 优先级 text-layout > summary > str-text
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

/**
 * 解析 DuckDuckGo HTML 版本的搜索结果
 *
 * 结构:
 * - 链接: <a class="result__a" href="//duckduckgo.com/l/?uddg=ENCODED_URL&...">
 *   注意 URL 以 // 开头（没有 https:），并且用 &amp; 做 HTML 实体编码
 * - 标题: <a class="result__a"> 的文本内容
 * - 摘要: <a class="result__snippet"> 的文本内容
 *
 * DDG 会返回验证码（anomaly 页面），此时无结果
 */
export function parseDuckDuckGo(html: string): SearchItem[] {
  const results: SearchItem[] = [];

  // 如果是验证码页面直接返回空
  if (html.includes("anomaly-modal") || html.includes("Please complete the following challenge")) {
    console.log("[DuckDuckGo] Got captcha page, skipping");
    return results;
  }

  // 提取所有 result__a 链接
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

    // 解码 HTML 实体 (href 中的 &amp; -> &)
    rawUrl = decodeHtmlEntities(rawUrl);

    // DDG 的 URL 处理:
    // 格式1: //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=...
    // 格式2: https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com
    let url = rawUrl;
    if (rawUrl.includes("uddg=")) {
      const uddgParam = rawUrl.split("uddg=")[1]?.split("&")[0] ?? "";
      const decoded = decodeURIComponent(uddgParam);
      if (decoded) url = decoded;
    } else if (rawUrl.startsWith("//")) {
      url = "https:" + rawUrl;
    }

    // 过滤 DDG 广告（URL 包含 duckduckgo.com/y.js 或 ad_provider）
    if (
      url.includes("duckduckgo.com/y.js") ||
      isAdUrl(url)
    ) {
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
// 搜索引擎网络请求封装
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
// 搜索结果去重与合并
// ============================================================================

/**
 * 标准化 URL 用于去重
 * 去掉协议头、www 前缀、末尾斜杠、跟踪参数等
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "fbclid", "gclid", "msclkid", "spm", "from",
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

/**
 * 合并多个搜索引擎的结果并去重
 * 交替从各引擎取结果，保证来源多样性，同时过滤广告
 */
export function mergeAndDeduplicate(
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
// web_search 实现
// ============================================================================

async function webSearch(
  query: string,
  numResults: number = 8
): Promise<SearchItem[]> {
  console.log(`[web_search] query="${query}", numResults=${numResults}`);

  // 并发请求三个搜索引擎
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
      console.log(`[web_search] ${engineNames[i]}: ${result.value.length} results`);
    } else {
      console.log(`[web_search] ${engineNames[i]}: failed - ${result.reason}`);
    }
  }

  return mergeAndDeduplicate(allResults, numResults);
}

// ============================================================================
// web_fetch 实现
// ============================================================================

/** 从 HTML 中移除无用标签 */
function removeUselessTags(html: string): string {
  const tagsToRemove = [
    "script", "style", "iframe", "noscript", "svg",
    "object", "embed", "applet", "link", "meta",
    "head", "nav", "footer", "aside",
  ];
  let cleaned = html;
  for (const tag of tagsToRemove) {
    const regex = new RegExp(`<${tag}[\\s\\S]*?(?:<\\/${tag}>|\\/>)`, "gi");
    cleaned = cleaned.replace(regex, "");
  }
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
  return cleaned;
}

/** 使用 Turndown 将 HTML 转换为 Markdown */
function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  turndownService.remove([
    "script", "style", "iframe", "noscript", "svg", "nav", "footer",
  ]);

  try {
    let md = turndownService.turndown(html);
    md = md.replace(/\n{3,}/g, "\n\n");
    md = md.replace(/[ \t]+$/gm, "");
    return md.trim();
  } catch (e) {
    console.error("[htmlToMarkdown] conversion error:", (e as Error).message);
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

/**
 * 从 HTML 中提取核心内容
 * 优先级: <main> > <article> > <div id="content"> > <body> > 全部
 */
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

/** 执行 web_fetch，默认 10 秒超时 */
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
// MCP 工具定义
// ============================================================================

const TOOLS: Tool[] = [
  {
    name: "web_search",
    description:
      "Search the web using multiple search engines (Brave, Sogou, DuckDuckGo) simultaneously. " +
      "Results are deduplicated and ads are filtered out. " +
      "Returns an array of search results with url, title, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search keywords separated by spaces, e.g. 'deno mcp server'",
        },
        num_results: {
          type: "number",
          description: "Number of results to return (default: 8)",
          default: 8,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a web page and return its content. " +
      "When simplify is enabled (default), removes useless HTML tags (script, style, iframe, etc.), " +
      "extracts the main content, and converts it to clean Markdown format. " +
      "Has a 10-second timeout.",
    inputSchema: {
      type: "object" as const,
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
  },
];

// ============================================================================
// MCP 工具调用处理
// ============================================================================

async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  switch (name) {
    case "web_search": {
      const query = args.query as string;
      const numResults = (args.num_results as number) ?? 8;

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
        const results = await webSearch(query, numResults);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }

    case "web_fetch": {
      const url = args.url as string;
      const maxCharSize = (args.max_char_size as number) ?? 50000;
      const simplify = (args.simplify as boolean) ?? true;

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
        const content = await webFetch(url, maxCharSize, simplify);
        return {
          content: [{ type: "text", text: content }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
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
// 创建 MCP Server 实例（每个请求创建新实例，无状态模式）
// ============================================================================

function createMCPServer(): Server {
  const server = new Server(
    { name: "orz", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    (request: CallToolRequest) =>
      handleToolCall(request.params.name, request.params.arguments ?? {})
  );

  return server;
}

// ============================================================================
// HTTP 服务器 (Hono + Streamable HTTP Transport)
// ============================================================================

const app = new Hono();

// 允许跨域访问
app.use("*", cors());

// 首页 - 健康检查 / 服务信息
app.get("/", (c: Context) => {
  return c.json({
    name: "orz",
    version: "1.0.0",
    description: "ORZ MCP Server - Web Search & Fetch",
    mcp_endpoint: "/mcp",
    tools: ["web_search", "web_fetch"],
  });
});

/**
 * MCP Streamable HTTP 端点 - POST /mcp
 * 无状态模式: 每个请求创建新的 Server + Transport 实例
 */
app.post("/mcp", async (c: Context) => {
  const { req, res } = toReqRes(c.req.raw);
  const server = createMCPServer();

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, await c.req.json());

    res.on("close", () => {
      transport.close();
      server.close();
    });

    return toFetchResponse(res);
  } catch (error) {
    console.error("[MCP] request error:", error);
    server.close();
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      },
      500
    );
  }
});

/** 无状态模式不支持 SSE 长连接 */
app.get("/mcp", (c: Context) => {
  return c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "SSE not supported in stateless mode. Use POST /mcp for requests.",
      },
      id: null,
    },
    405
  );
});

/** 无状态模式无会话可关闭 */
app.delete("/mcp", (c: Context) => {
  return c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Session management not supported in stateless mode.",
      },
      id: null,
    },
    405
  );
});

// ============================================================================
// 启动服务器（仅在直接运行时启动，import 时不启动）
// ============================================================================

// 启动服务器
// import.meta.main: 直接运行或 deno task start 时为 true
// Deno Deploy: 入口文件的 import.meta.main 也为 true
// 测试 import 时为 false，不会启动服务器
if (import.meta.main) {
  const port = Number(Deno.env.get("PORT")) || 8000;
  Deno.serve({ port }, app.fetch);
  console.log(`ORZ MCP server running on http://localhost:${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
}
