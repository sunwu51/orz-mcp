# ORZ MCP

一个提供 **web_search** 和 **web_fetch** 能力的 MCP (Model Context Protocol) 服务器。

让你的 AI 助手（Claude、Cursor、OpenCode 等）能够搜索互联网和抓取网页内容。

## 功能

### web_search

并发查询 **DuckDuckGo**（及配置 Key 时开启的 **Google**）搜索引擎，自动合并去重、过滤广告。

- **入参**: `query`（搜索关键词）、`num_results`（返回数量，默认 8）
- **返回**: `{ url, title, summary }[]`
- **Google 搜索（官方 Grounding）**：
  - 配置 `GEMINI_API_KEY`（或 `--gemini-api-key`），直接调用 Google 官方 Gemini API 的 Google Search Grounding（每月拥有 5000 次免费额度，官方实时数据，不惧爬虫风控）。未配置时默认只运行 DuckDuckGo。详细开启步骤见下方 [Google Search 配置指南](#google-search-配置指南)。

### Google Search 配置指南

#### 1. 获取 Gemini API Key
1. 访问 [Google AI Studio](https://aistudio.google.com/app/apikey)。
2. 点击 **Create API Key** 创建你的 API Key。
3. **重要说明**：Google Search Grounding 功能要求项目绑定结算账户（开启 Pay-as-you-go / Tier 1）。绑定后**每月享有前 5,000 次免费查询**（查询计费为 $0.00），超出部分才按 $35/1000次 计费。未绑定结算账户的项目调用 Grounding 搜索会报错。

#### 2. 如何开启
- **stdio（本地使用）**：
  - 方式 A（推荐，命令行参数）：通过 `--gemini-api-key <YOUR_KEY>` 传入。
  - 方式 B（环境变量）：在配置文件的 `env` 中设置 `GEMINI_API_KEY`。
- **Streamable HTTP（云端 Netlify / Railway 部署）**：
  - 在云平台的控制台环境变量（Environment Variables）中添加 `GEMINI_API_KEY=<YOUR_KEY>` 即可自动生效。

### web_fetch

抓取指定 URL 的网页内容，默认简化为 Markdown 格式。

- **入参**: `url`、`max_char_size`（最大字符数，默认 50000）、`simplify`（是否简化，默认 true）
- **返回**: 纯文本字符串（Markdown 格式）
- 内置 10 秒超时

## 两种使用方式（二选一）

ORZ MCP 提供 **stdio** 和 **Streamable HTTP** 两种 MCP 传输协议的实现，功能完全一致，根据你的需求选择其中一种即可。

| | stdio | Streamable HTTP |
|---|---|---|
| 运行方式 | 通过 npx 本地启动 | 远程 HTTP 服务（Netlify Functions） |
| 适用场景 | 本地运行，支持代理与 API Key | 开箱即用，支持云端部署、住宅代理与 API Key |
| 代理支持 | 支持 `--proxy` 命令行参数与环境变量 | 支持环境变量 `PROXY_URL`（如住宅 IP 代理） |
| 依赖 | Node.js >= 18 | 无 |

---

### 方式一：stdio（通过 npx 本地运行）

无需安装，直接通过 `npx` 运行。

在你的 MCP 客户端配置中添加：

**1. 开启 Gemini 官方 Google Search（推荐）：**

使用命令行参数：
```json
{
  "mcpServers": {
    "orz": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "orz-mcp", "--gemini-api-key", "AIzaSy..."]
    }
  }
}
```

或者使用环境变量：
```json
{
  "mcpServers": {
    "orz": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "orz-mcp"],
      "env": {
        "GEMINI_API_KEY": "AIzaSy..."
      }
    }
  }
}
```

**2. 配置住宅代理（或科学上网代理）：**

```json
{
  "mcpServers": {
    "orz": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "orz-mcp", "--proxy", "http://user:pass@proxy-host:port"]
    }
  }
}
```

也可以两者同时使用（`--gemini-api-key` + `--proxy`）。

---

### 方式二：Streamable HTTP（远程连接）

无需本地安装任何东西，直接连接部署在 Netlify 上的远程服务。

```json
{
  "mcpServers": {
    "orz": {
      "type": "http",
      "url": "https://<your-netlify-domain>/mcp"
    }
  }
}
```

如果你的 MCP 客户端不支持直接 URL 连接，可以通过 `mcp-remote` 桥接：

```json
{
  "mcpServers": {
    "orz": {
      "command": "npx",
      "args": ["mcp-remote@next", "https://<your-netlify-domain>/mcp"]
    }
  }
}
```

---

## 配置文件位置

不同的 MCP 客户端配置文件位置不同：

- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
- **Cursor**: Settings > MCP Servers
- **OpenCode**: `.opencode/config.json` 或通过 `/mcp` 命令添加

## 项目结构

```
orz-mcp/
├── stdio/                              # stdio 传输协议 (npm 包)
│   ├── client.mjs                      # 入口文件
│   └── package.json                    # npm 发布配置（依赖: mcp sdk, turndown, undici）
├── streamable-http/                    # Streamable HTTP 传输协议 (Netlify Functions)
│   ├── netlify/
│   │   ├── mcp-server/
│   │   │   └── index.ts                # MCP Server 定义（工具注册与业务逻辑）
│   │   └── functions/
│   │       └── hono-mcp-server.ts      # Hono HTTP handler (Netlify Function)
│   ├── public/
│   │   └── index.html                  # 静态首页
│   ├── netlify.toml                    # Netlify 构建配置
│   └── package.json                    # 服务端依赖（依赖: mcp sdk, hono, zod, turndown）
└── README.md
```

## 开发

### stdio

```bash
cd stdio
npm install

node client.mjs
node client.mjs --proxy http://127.0.0.1:7890
node client.mjs --help

# 用 MCP Inspector 调试
npx @modelcontextprotocol/inspector node client.mjs
```

### Streamable HTTP（本地调试）

```bash
cd streamable-http
npm install

# 启动本地开发服务器（需要 Netlify CLI）
netlify dev

# 用 MCP Inspector 测试（在 UI 中选择 Streamable HTTP，填入 URL）
npx @modelcontextprotocol/inspector --url http://localhost:8888/mcp
```

## 部署到 Netlify

```bash
cd streamable-http

# 安装 Netlify CLI
npm install -g netlify-cli

# 登录
netlify login

# 初始化并关联站点
netlify init

# 部署
netlify deploy --prod
```

或者通过 GitHub 连接 Netlify，push 到 main 分支自动部署。

## License

MIT
