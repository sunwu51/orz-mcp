# ORZ MCP

一个提供 **web_search** 和 **web_fetch** 能力的 MCP (Model Context Protocol) 服务器。

让你的 AI 助手（Claude、Cursor、OpenCode 等）能够搜索互联网和抓取网页内容。

## 功能

### web_search

通过 **DuckDuckGo** 搜索网页，自动去重、过滤广告。

- **入参**: `query`（搜索关键词）、`num_results`（返回数量，默认 8）
- **返回**: `{ url, title, summary }[]`

### web_fetch

抓取指定 URL 的网页内容，默认简化为 Markdown 格式。

- **入参**: `url`、`max_char_size`（最大字符数，默认 50000）、`simplify`（是否简化，默认 true）
- **返回**: 纯文本字符串（Markdown 格式）
- 内置 10 秒超时（覆盖重定向、`<meta refresh>` 跳转和读取正文）
- 支持表格（GFM）、保留代码块换行；PDF、图片等非文本类型会明确报错，不返回乱码
- Streamable HTTP 版内置 SSRF 防护：拒绝回环、内网、链路本地（如云元数据 `169.254.169.254`）等地址，每次重定向都会重新校验

## 两种使用方式（二选一）

ORZ MCP 提供 **stdio** 和 **Streamable HTTP** 两种 MCP 传输协议的实现，功能完全一致，根据你的需求选择其中一种即可。

| | stdio | Streamable HTTP |
|---|---|---|
| 运行方式 | 通过 npx 本地启动 | 远程 HTTP 服务（Netlify Functions） |
| 适用场景 | 本地运行，支持代理 | 开箱即用，支持云端部署、住宅代理 |
| 代理支持 | 支持 `--proxy` 命令行参数与环境变量 | 支持环境变量 `PROXY_URL`（如住宅 IP 代理） |
| 依赖 | Node.js >= 18 | 无 |

---

### 方式一：stdio（通过 npx 本地运行）

无需安装，直接通过 `npx` 运行。

在你的 MCP 客户端配置中添加：

**1. 配置住宅代理（或科学上网代理）：**

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

### 环境变量

| 变量 | 说明 |
|---|---|
| `PROXY_URL` | 出站代理（如住宅 IP 代理）。配置后域名由代理解析，SSRF 防护只校验 IP 字面量和 `localhost`、`.local`、`.internal` 等名称 |
| `ORZ_ALLOW_PRIVATE_HOSTS` | 逗号分隔的主机名/IP 白名单，允许 `web_fetch` 访问其中的内网地址（精确匹配）。默认为空，即全部拒绝；仅在本地调试需要抓取 `127.0.0.1` 等地址时设置 |

## License

MIT
