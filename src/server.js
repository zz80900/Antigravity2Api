// Proxy must be initialized before any fetch
require("./utils/proxy");

const http = require("http");
const path = require("path");

const { getConfig } = require("./utils/config");
const { createLogger } = require("./utils/logger");

const { AuthManager, OAuthFlow } = require("./auth");
const { ClaudeApi, GeminiApi, UpstreamClient } = require("./api");

const config = getConfig();
const { log, logFile } = createLogger();
const debugRequestResponse = !!config.debug;

const authManager = new AuthManager({
  authDir: path.resolve(process.cwd(), "auths"),
  logger: log,
});

const upstreamClient = new UpstreamClient(authManager, { logger: log });
const claudeApi = new ClaudeApi({ authManager, upstreamClient, logger: log, debug: debugRequestResponse });
const geminiApi = new GeminiApi({ authManager, upstreamClient, logger: log, debug: debugRequestResponse });

const isAddFlow = process.argv.includes("--add");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-api-key, x-goog-api-key, anthropic-version",
};

function extractApiKey(headers) {
  const authHeader = headers["authorization"];
  let apiKey = null;
  if (authHeader) {
    const parts = String(authHeader).trim().split(/\s+/);
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      apiKey = parts[1];
    } else {
      apiKey = String(authHeader).trim();
    }
  } else {
    const xApiKey = headers["x-api-key"] || headers["anthropic-api-key"] || headers["x-goog-api-key"];
    if (xApiKey) apiKey = String(xApiKey).trim();
  }
  return apiKey;
}

async function parseJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error("INVALID_JSON");
    err.cause = e;
    throw err;
  }
}

async function writeResponse(res, apiResponse) {
  const headers = { ...CORS_HEADERS, ...(apiResponse.headers || {}) };
  res.writeHead(apiResponse.status || 200, headers);

  const body = apiResponse.body;
  if (body == null) return res.end();

  // WHATWG ReadableStream (fetch Response.body)
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      res.end();
    }
    return;
  }

  // Node.js Readable
  if (body && typeof body.pipe === "function") {
    return body.pipe(res);
  }

  if (typeof body === "string" || Buffer.isBuffer(body)) {
    return res.end(body);
  }

  return res.end(JSON.stringify(body));
}

const PORT = config.server?.port || 3000;
const HOST = config.server?.host || "0.0.0.0";

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  // API Key Auth
  if (config.api_keys && config.api_keys.length > 0) {
    const apiKey = extractApiKey(req.headers);
    if (!apiKey || !config.api_keys.includes(apiKey)) {
      log("warn", `⛔ Unauthorized access attempt from ${req.socket.remoteAddress}`);
      log("warn", `Received headers: ${JSON.stringify(req.headers)}`);
      res.writeHead(401, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API Key" } }));
      return;
    }
  }

  log("info", `Received request: ${req.method} ${req.url}`);

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  try {
    // Claude models list
    if (parsedUrl.pathname === "/v1/models" && req.method === "GET") {
      return await writeResponse(res, await claudeApi.handleListModels());
    }

    // Gemini models list
    if (parsedUrl.pathname === "/v1beta/models" && req.method === "GET") {
      return await writeResponse(res, await geminiApi.handleListModels());
    }

    // Gemini model detail
    const geminiModelDetailMatch = parsedUrl.pathname.match(/^\/v1beta\/models\/([^:]+)$/);
    if (geminiModelDetailMatch && req.method === "GET") {
      const targetName = decodeURIComponent(geminiModelDetailMatch[1]);
      return await writeResponse(res, await geminiApi.handleGetModel(targetName));
    }

    // Gemini generate/streamGenerate
    const geminiGenerateMatch = parsedUrl.pathname.match(
      /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/
    );
    if (geminiGenerateMatch && req.method === "POST") {
      const body = await parseJsonBody(req);
      return await writeResponse(
        res,
        await geminiApi.handleGenerate(geminiGenerateMatch[1], geminiGenerateMatch[2], body, parsedUrl.search || "")
      );
    }

    // Gemini countTokens (new, optional)
    const geminiCountMatch = parsedUrl.pathname.match(/^\/v1beta\/models\/([^:]+):countTokens$/);
    if (geminiCountMatch && req.method === "POST") {
      const body = await parseJsonBody(req);
      return await writeResponse(res, await geminiApi.handleCountTokens(geminiCountMatch[1], body));
    }

    // Claude count tokens
    if (parsedUrl.pathname === "/v1/messages/count_tokens" && req.method === "POST") {
      const body = await parseJsonBody(req);
      return await writeResponse(res, await claudeApi.handleCountTokens(body));
    }

    // Claude messages
    if (parsedUrl.pathname === "/v1/messages" && req.method === "POST") {
      const body = await parseJsonBody(req);
      return await writeResponse(res, await claudeApi.handleMessages(body));
    }

    res.writeHead(404, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Not Found: ${req.method} ${req.url}` } }));
  } catch (err) {
    if (err && err.message === "INVALID_JSON") {
      res.writeHead(400, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
      return;
    }
    log("error", err.message || err);
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Internal Server Error" } }));
  }
});

(async () => {
  await authManager.loadAccounts();

  const shouldAutoOAuth = !isAddFlow && (!authManager.accounts || authManager.accounts.length === 0);

  if (isAddFlow || shouldAutoOAuth) {
    if (isAddFlow) {
      log("info", "🚀 Starting flow to add a new account...");
    } else {
      log("warn", "No accounts found. Starting OAuth flow to add the first account...");
    }
    const oauthFlow = new OAuthFlow({ authManager, logger: log, rateLimiter: authManager.apiLimiter });
    oauthFlow.startInteractiveFlow();
    if (isAddFlow) return;
  }

  server.listen(PORT, HOST, () => {
    log("info", `==================================================`);
    log("info", `🚀 Local API Server running!`);
    log("info", `📍 Address: http://${HOST}:${PORT}`);
    log("info", `🔗 Gemini Endpoint: http://${HOST}:${PORT}/v1beta`);
    log("info", `🔗 Claude Endpoint: http://${HOST}:${PORT}/v1/messages`);
    log("info", `📝 Log file: ${logFile}`);
    log("info", `==================================================`);

    if (authManager.accounts && authManager.accounts.length === 0) {
      log("warn", "⚠️ No accounts loaded yet. OAuth flow should be running to add the first account.");
      log("warn", "ℹ️  If the browser didn't open, run: node src/server.js --add");
    } else {
      log("info", `ℹ️  To add more accounts, run: node src/server.js --add`);
    }
  });
})();
