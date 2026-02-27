# ORZ MCP

一个提供 **web_search** 和 **web_fetch** 能力的 MCP (Model Context Protocol) 服务器。

让你的 AI 助手（Claude、Cursor、OpenCode 等）能够搜索互联网和抓取网页内容。

## 功能

### web_search

同时查询 Brave、搜狗、DuckDuckGo 三个搜索引擎，自动合并去重、过滤广告。

- **入参**: `query`（搜索关键词）、`num_results`（返回数量，默认 8）
- **返回**: `{ url, title, summary }[]`

### web_fetch

抓取指定 URL 的网页内容，默认简化为 Markdown 格式。

- **入参**: `url`、`max_char_size`（最大字符数，默认 50000）、`simplify`（是否简化，默认 true）
- **返回**: 纯文本字符串（Markdown 格式）
- 内置 10 秒超时

## 两种使用方式（二选一）

ORZ MCP 提供 **本地 stdio 版** 和 **远程 server 版** 两种模式，功能完全一致，根据你的需求选择其中一种即可。

| | 本地 stdio 版 | 远程 server 版 |
|---|---|---|
| 运行方式 | 通过 npx 本地启动 | 远程 HTTP 服务（Netlify Functions） |
| 适用场景 | 需要代理访问海外搜索引擎 | 开箱即用，无需本地环境 |
| 代理支持 | 支持 `--proxy` 参数 | 不支持（服务端已部署在海外） |
| 依赖 | Node.js >= 18 | 无 |

---

### 方式一：本地 stdio 版（通过 npx 运行）

无需安装，直接通过 `npx` 运行。适合需要配置代理的用户。

在你的 MCP 客户端配置中添加：

**不需要代理：**

```json
{
  "mcpServers": {
    "orz": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "orz-mcp"]
    }
  }
}
```

**需要代理（国内用户）：**

```json
{
  "mcpServers": {
    "orz": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "orz-mcp", "--proxy", "http://127.0.0.1:7890"]
    }
  }
}
```

将 `http://127.0.0.1:7890` 替换为你的代理地址。

---

### 方式二：远程 server 版（直接连接）

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
├── client/                             # 本地 stdio 版 (npm 包)
│   ├── client.mjs                      # 入口文件
│   └── package.json                    # npm 发布配置（依赖: mcp sdk, turndown, undici）
├── server/                             # 远程 server 版 (Netlify Functions)
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

### 本地 stdio 版

```bash
cd client
npm install

node client.mjs
node client.mjs --proxy http://127.0.0.1:7890
node client.mjs --help
```

### 远程 server 版（本地调试）

```bash
cd server
npm install

# 启动本地开发服务器（需要 Netlify CLI）
netlify dev

# 用 MCP Inspector 测试
npx @modelcontextprotocol/inspector npx mcp-remote@next http://localhost:8888/mcp
```

## 部署到 Netlify

```bash
cd server

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
