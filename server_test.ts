/**
 * WY MCP Server - 搜索引擎解析逻辑单元测试
 *
 * 使用真实抓取的 HTML 样本（testdata/）验证各搜索引擎的解析函数。
 * 运行: deno test --allow-read server_test.ts
 */

import {
  assertEquals,
  assert,
  assertGreater,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseBrave,
  parseSogou,
  parseDuckDuckGo,
  normalizeUrl,
  isAdUrl,
  mergeAndDeduplicate,
  type SearchItem,
} from "./server.ts";

// ============================================================================
// Brave Search 解析测试
// ============================================================================

Deno.test("parseBrave - 应从真实 HTML 样本中解析出搜索结果", async () => {
  const html = await Deno.readTextFile("testdata/brave.html");
  const results = parseBrave(html);

  console.log(`  Brave: parsed ${results.length} results`);
  assertGreater(results.length, 0, "Brave 应解析出至少 1 条结果");

  // 验证每条结果的字段完整性
  for (const item of results) {
    assert(item.url.startsWith("http"), `URL 应以 http 开头: ${item.url}`);
    assert(item.title.length > 0, `标题不应为空: ${JSON.stringify(item)}`);
    // URL 不应包含 Brave 自身域名
    assert(
      !item.url.includes("search.brave.com"),
      `URL 不应包含 Brave 域名: ${item.url}`
    );
  }

  // 打印前 3 条用于人工验证
  for (const item of results.slice(0, 3)) {
    console.log(`    [${item.title.substring(0, 50)}] ${item.url.substring(0, 60)}`);
    console.log(`     summary: ${item.summary.substring(0, 80)}`);
  }
});

Deno.test("parseBrave - 合成 HTML 结构测试", () => {
  const html = `
    <div data-type="web" class="result">
      <a href="https://example.com/page1" class="heading">
        <span>Example Page Title</span>
      </a>
      <div class="snippet-description">This is the description of the page.</div>
    </div>
    <div data-type="web" class="result">
      <a href="https://another.com/page2">Another Title</a>
      <div class="generic-snippet">Another description here.</div>
    </div>
    <div data-type="video" class="result">
      <a href="https://video.com/v1">Video Title</a>
    </div>
  `;
  const results = parseBrave(html);

  assertEquals(results.length, 2, "应解析出 2 条 web 结果（跳过 video）");
  assertEquals(results[0].url, "https://example.com/page1");
  assertEquals(results[0].title, "Example Page Title");
  assertEquals(results[0].summary, "This is the description of the page.");
  assertEquals(results[1].url, "https://another.com/page2");
  assertEquals(results[1].title, "Another Title");
  assertEquals(results[1].summary, "Another description here.");
});

// ============================================================================
// 搜狗搜索解析测试
// ============================================================================

Deno.test("parseSogou - 应从真实 HTML 样本中解析出搜索结果", async () => {
  const html = await Deno.readTextFile("testdata/sogou.html");
  const results = parseSogou(html);

  console.log(`  Sogou: parsed ${results.length} results`);
  assertGreater(results.length, 0, "搜狗应解析出至少 1 条结果");

  for (const item of results) {
    assert(item.url.length > 0, `URL 不应为空`);
    assert(item.title.length > 0, `标题不应为空: ${JSON.stringify(item)}`);
  }

  const withSummary = results.filter((r: SearchItem) => r.summary.length > 0);
  console.log(
    `  Sogou: ${withSummary.length}/${results.length} results have summary`
  );

  for (const item of results.slice(0, 3)) {
    console.log(`    [${item.title.substring(0, 50)}]`);
    console.log(`     url: ${item.url.substring(0, 60)}`);
    console.log(`     summary: ${item.summary.substring(0, 80)}`);
  }
});

Deno.test("parseSogou - 合成 HTML 结构测试", () => {
  const html = `
    <div class="vrwrap">
      <h3 class="vr-title">
        <a href="/link?url=abc123">Deno Deploy 入门教程</a>
      </h3>
      <div class="text-layout ">这是搜狗搜索的摘要内容，来自 text-layout 容器。</div>
    </div>
    <div class="vrwrap">
      <h3 class="vr-title">
        <a href="https://example.com/page2">第二个结果标题</a>
      </h3>
      <div class="card_normal_result__summary_fd6d">第二条摘要，来自 summary 容器。</div>
    </div>
    <div class="vrwrap">
      <div class="video-frame">没有 h3 的视频卡片，应被跳过</div>
    </div>
  `;
  const results = parseSogou(html);

  assertEquals(results.length, 2, "应解析出 2 条结果（跳过无 h3 的视频卡片）");
  assertEquals(results[0].title, "Deno Deploy 入门教程");
  assertEquals(results[0].url, "https://www.sogou.com/link?url=abc123");
  assertEquals(results[0].summary, "这是搜狗搜索的摘要内容，来自 text-layout 容器。");

  assertEquals(results[1].title, "第二个结果标题");
  assertEquals(results[1].url, "https://example.com/page2");
  assertEquals(results[1].summary, "第二条摘要，来自 summary 容器。");
});

// ============================================================================
// DuckDuckGo 解析测试
// ============================================================================

Deno.test("parseDuckDuckGo - 应从真实 HTML 样本中解析出搜索结果", async () => {
  // 使用有结果的 ddg2.html 样本
  const html = await Deno.readTextFile("testdata/ddg2.html");
  const results = parseDuckDuckGo(html);

  console.log(`  DuckDuckGo: parsed ${results.length} results`);
  assertGreater(results.length, 0, "DDG 应解析出至少 1 条结果");

  // 验证 URL 已正确解码
  for (const item of results) {
    assert(item.url.startsWith("http"), `URL 应以 http 开头: ${item.url}`);
    assert(
      !item.url.includes("duckduckgo.com/l/"),
      `URL 不应是 DDG 跳转链接: ${item.url}`
    );
    assert(!item.url.includes("&amp;"), `URL 不应包含未解码的 &amp;: ${item.url}`);
    assert(item.title.length > 0, `标题不应为空`);
  }

  // 不应包含广告
  const ads = results.filter(
    (r) => r.url.includes("ad_provider") || r.url.includes("duckduckgo.com/y.js")
  );
  assertEquals(ads.length, 0, "不应包含广告结果");

  // 打印前 3 条
  for (const item of results.slice(0, 3)) {
    console.log(`    [${item.title.substring(0, 50)}] ${item.url.substring(0, 60)}`);
    console.log(`     summary: ${item.summary.substring(0, 80)}`);
  }
});

Deno.test("parseDuckDuckGo - 验证码页面应返回空数组", async () => {
  const html = await Deno.readTextFile("testdata/ddg.html");
  // ddg.html 可能有验证码也可能有结果，取决于抓取时的状态
  const results = parseDuckDuckGo(html);
  // 如果有验证码，结果应为空
  if (html.includes("anomaly-modal")) {
    assertEquals(results.length, 0, "验证码页面应返回空数组");
    console.log("  DuckDuckGo captcha page: correctly returned 0 results");
  } else {
    console.log(`  DuckDuckGo normal page: parsed ${results.length} results`);
  }
});

Deno.test("parseDuckDuckGo - 合成 HTML 含 uddg 编码链接", () => {
  const html = `
    <div class="result results_links results_links_deep web-result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">
        Example Page
      </a>
      <a class="result__snippet">This is a snippet for example page.</a>
    </div>
    <div class="result results_links results_links_deep web-result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dspam.com%26ad_provider%3Dbingv7aa&amp;rut=def">
        Sponsored Result
      </a>
      <a class="result__snippet">This is a sponsored result.</a>
    </div>
    <div class="result results_links results_links_deep web-result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fanother.org%2Fpath%3Fq%3D1&amp;rut=ghi">
        Another Result
      </a>
      <a class="result__snippet">Another snippet here.</a>
    </div>
  `;
  const results = parseDuckDuckGo(html);

  // 应过滤掉广告（第 2 个）
  assertEquals(results.length, 2, "应解析出 2 条结果（过滤 1 条广告）");
  assertEquals(results[0].url, "https://example.com/page");
  assertEquals(results[0].title, "Example Page");
  assertEquals(results[0].summary, "This is a snippet for example page.");

  assertEquals(results[1].url, "https://another.org/path?q=1");
  assertEquals(results[1].title, "Another Result");
});

Deno.test("parseDuckDuckGo - 验证码 HTML 应返回空", () => {
  const html = `
    <div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
    <div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div>
  `;
  const results = parseDuckDuckGo(html);
  assertEquals(results.length, 0);
});

// ============================================================================
// URL 标准化测试
// ============================================================================

Deno.test("normalizeUrl - 应去掉 www 前缀和末尾斜杠", () => {
  assertEquals(
    normalizeUrl("https://www.example.com/"),
    normalizeUrl("https://example.com")
  );
});

Deno.test("normalizeUrl - 应去掉跟踪参数", () => {
  assertEquals(
    normalizeUrl("https://example.com/page?utm_source=google&id=1"),
    normalizeUrl("https://example.com/page?id=1")
  );
});

Deno.test("normalizeUrl - 不同协议的相同 URL 应标准化为相同结果", () => {
  assertEquals(
    normalizeUrl("http://example.com/page"),
    normalizeUrl("https://example.com/page")
  );
});

// ============================================================================
// 广告过滤测试
// ============================================================================

Deno.test("isAdUrl - 应识别广告链接", () => {
  assert(isAdUrl("https://googleads.example.com/click"));
  assert(isAdUrl("https://www.baidu.com/aclick?url=xxx"));
  assert(isAdUrl("https://pos.baidu.com/track"));
  assert(isAdUrl("https://example.com/ads/banner"));
  assert(isAdUrl("https://example.com?ad_provider=bingv7"));
  assert(isAdUrl("https://example.com?ad_domain=spam.com"));
});

Deno.test("isAdUrl - 不应误判正常链接", () => {
  assert(!isAdUrl("https://www.example.com/page"));
  assert(!isAdUrl("https://github.com/deno/deno"));
  assert(!isAdUrl("https://stackoverflow.com/questions/12345"));
  assert(!isAdUrl("https://docs.deno.com/deploy"));
});

// ============================================================================
// 去重合并测试
// ============================================================================

Deno.test("mergeAndDeduplicate - 应基于 URL 去重", () => {
  const engine1: SearchItem[] = [
    { url: "https://www.example.com/page", title: "A", summary: "a" },
    { url: "https://unique1.com", title: "B", summary: "b" },
  ];
  const engine2: SearchItem[] = [
    { url: "https://example.com/page", title: "A dup", summary: "a dup" },
    { url: "https://unique2.com", title: "C", summary: "c" },
  ];

  const merged = mergeAndDeduplicate([engine1, engine2], 10);

  // example.com/page 应只出现一次（去掉 www 后相同）
  const exampleResults = merged.filter((r) =>
    normalizeUrl(r.url) === normalizeUrl("https://example.com/page")
  );
  assertEquals(exampleResults.length, 1, "相同 URL 应去重");
  assertEquals(merged.length, 3, "应有 3 条不同的结果");
});

Deno.test("mergeAndDeduplicate - 应过滤广告", () => {
  const results: SearchItem[] = [
    { url: "https://googleads.com/click", title: "Ad", summary: "ad" },
    { url: "https://example.com", title: "Real", summary: "real" },
  ];
  const merged = mergeAndDeduplicate([results], 10);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].title, "Real");
});

Deno.test("mergeAndDeduplicate - 应交替取各引擎结果", () => {
  const engine1: SearchItem[] = [
    { url: "https://a1.com", title: "A1", summary: "" },
    { url: "https://a2.com", title: "A2", summary: "" },
  ];
  const engine2: SearchItem[] = [
    { url: "https://b1.com", title: "B1", summary: "" },
    { url: "https://b2.com", title: "B2", summary: "" },
  ];

  const merged = mergeAndDeduplicate([engine1, engine2], 4);
  // 交替取: A1, B1, A2, B2
  assertEquals(merged[0].title, "A1");
  assertEquals(merged[1].title, "B1");
  assertEquals(merged[2].title, "A2");
  assertEquals(merged[3].title, "B2");
});

Deno.test("mergeAndDeduplicate - 应限制返回数量", () => {
  const results: SearchItem[] = Array.from({ length: 20 }, (_, i) => ({
    url: `https://example${i}.com`,
    title: `Result ${i}`,
    summary: "",
  }));
  const merged = mergeAndDeduplicate([results], 5);
  assertEquals(merged.length, 5);
});
