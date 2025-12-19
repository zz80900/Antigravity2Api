const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  server: { host: "0.0.0.0", port: 3000 },
  api_keys: [],
  proxy: { enabled: false, url: "" },
  // Debug switch: only affects request/response payload logs.
  debug: false,
};

let cachedConfig = null;

function normalizeDebug(rawDebug) {
  if (typeof rawDebug === "boolean") return rawDebug;
  if (rawDebug && typeof rawDebug === "object") {
    if (typeof rawDebug.enabled === "boolean") return rawDebug.enabled;
    if (typeof rawDebug.requestResponse === "boolean") return rawDebug.requestResponse;
    if (typeof rawDebug.request_response === "boolean") return rawDebug.request_response;
  }
  return DEFAULT_CONFIG.debug;
}

function normalizeConfig(raw) {
  const serverRaw = raw && typeof raw.server === "object" ? raw.server : {};
  const proxyRaw = raw && typeof raw.proxy === "object" ? raw.proxy : {};

  return {
    ...DEFAULT_CONFIG,
    ...(raw && typeof raw === "object" ? raw : {}),
    server: { ...DEFAULT_CONFIG.server, ...serverRaw },
    proxy: { ...DEFAULT_CONFIG.proxy, ...proxyRaw },
    api_keys: Array.isArray(raw?.api_keys) ? raw.api_keys : DEFAULT_CONFIG.api_keys,
    debug: normalizeDebug(raw?.debug),
  };
}

function loadConfig() {
  const configFile = path.resolve(process.cwd(), "config.json");
  let raw = null;

  try {
    if (fs.existsSync(configFile)) {
      const configContent = fs.readFileSync(configFile, "utf8");
      raw = JSON.parse(configContent);
    }
  } catch (e) {
    // Swallow parsing errors; caller can decide how to log.
    raw = null;
  }

  return normalizeConfig(raw);
}

function getConfig() {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  loadConfig,
};
