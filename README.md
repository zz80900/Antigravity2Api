# Antigravity2Api

本服务是一个兼容 Claude 接口、并提供 Gemini 原生接口透传的本地代理服务，支持多账号轮询、API Key 认证以及自定义代理配置。

> **推荐启动方式**：在项目根目录运行 `node src/server.js`。本项目会以当前工作目录（`process.cwd()`）定位 `config.json`、`auths/`、`log/`；如果你在 `src/` 目录运行，则对应路径会变成 `src/config.json`、`src/auths/`、`src/log/`。

## 1. 环境准备

确保已安装 [Node.js](https://nodejs.org/) (建议版本 v18 或更高)。

## 2. 安装依赖

如果你不启用代理（`config.json` 里 `proxy.enabled=false`），无需安装任何额外依赖。

如果你启用代理，为了确保代理对 `fetch` 生效，建议安装以下依赖（按需选择）：

在项目根目录下打开终端（CMD 或 PowerShell）运行：

```bash
npm install undici
```

可选：如果你不装 `undici`，会自动降级到 `node-fetch`，此时需要安装：

```bash
npm install node-fetch https-proxy-agent
```

可选：如果你使用 SOCKS5 代理，需要安装：

```bash
npm install node-fetch socks-proxy-agent
```

> **注意**：如果在 PowerShell 中遇到“无法加载文件...npm.ps1”的错误，请尝试使用 CMD 运行，或者使用以下命令绕过策略：
> ```bash
> cmd /c npm install undici
> ```

## 3. 配置文件 (config.json)

在项目根目录下创建或编辑 `config.json` 文件。

**示例配置：**

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 3000
  },
  "api_keys": [
    "sk-your-secret-key-1"
  ],
  "proxy": {
    "enabled": true,
    "url": "http://127.0.0.1:7890"
  },
  "debug": false
}
```

**配置项说明：**

*   **server**:
    *   `host`: 监听地址。`0.0.0.0` 表示允许局域网访问，`127.0.0.1` 仅限本机。
    *   `port`: 服务监听端口（默认 3000）。
*   **api_keys**:
    *   允许访问 API 的密钥列表。客户端必须携带其中任意一个 Key 才能访问。
*   **proxy**:
    *   `enabled`: 是否启用代理（`true`/`false`）。
    *   `url`: 代理服务器地址。支持 `http://`, `https://`, `socks5://`。例如 `socks5://127.0.0.1:1080`。
*   **debug**:
    *   `true` 时会额外打印并写入日志文件：**请求/响应 payload**（非常详细，日志量很大）。
    *   `false` 时只保留必要的运行/错误日志；不影响其他日志。

## 4. 启动服务

运行以下命令启动服务器：

```bash
node src/server.js
```

首次运行如果 `auths/` 下没有任何有效账号，会自动启动 OAuth 流程引导你添加第一个账号；你也可以手动运行：

```bash
node src/server.js --add
```

## 5. 客户端连接 (如 CherryStudio)

在客户端中添加自定义提供商（Claude）：

*   **API 地址 (Endpoint)**: `http://localhost:3000` (或 `http://<本机IP>:3000`)
    *   Claude 兼容路径: `http://localhost:3000/v1/messages`
    *   Gemini 原生路径: `http://localhost:3000/v1beta`
*   **API 密钥 (API Key)**: 填写你在 `config.json` -> `api_keys` 中配置的任意一个 Key。
    *   支持的传递方式：`Authorization: Bearer <key>` / `x-api-key` / `anthropic-api-key` / `x-goog-api-key`

## 6. 常见问题

*   **401 Unauthorized**: 检查客户端填写的 API Key 是否与 `config.json` 中的一致。
*   **Proxy 错误 / 超时**:
    *   确保已运行 `npm install` 安装依赖。
    *   检查 `config.json` 中的代理 URL 是否正确且代理软件已开启。
    *   如果是 SOCKS5 代理，确保 `socks-proxy-agent` 已安装。
