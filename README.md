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
| 运行方式 | 通过 npx 本地启动 | 远程 HTTP 服务 |
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

无需本地安装任何东西，直接连接远程服务。

```json
{
  "mcpServers": {
    "orz": {
      "type": "http",
      "url": "https://orz.xiaogenban.deno.net/mcp"
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
├── client.mjs       # 本地 stdio 版 (Node.js)
├── server.ts        # 远程 server 版 (Deno, Streamable HTTP)
├── server_test.ts   # 测试文件
├── package.json     # npm 包配置
└── deno.json        # Deno 配置
```

## 开发

```bash
# 启动远程 server 版（本地开发）
deno task start

# 运行测试
deno test --allow-read --allow-net --allow-env server_test.ts

# 启动本地 stdio 版
node client.mjs
node client.mjs --proxy http://127.0.0.1:7890
node client.mjs --help
```

## License

MIT
