const { getConfig } = require("./config");

const config = getConfig();

// Proxy Setup (best-effort, zero-dependency first)
if (config.proxy && config.proxy.enabled && config.proxy.url) {
  const proxyUrl = config.proxy.url;
  console.log(`[info] 🔌 Proxy enabled: ${proxyUrl}`);

  // Set Environment Variables (works for many libs)
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.ALL_PROXY = proxyUrl;

  try {
    if (proxyUrl.startsWith("http")) {
      try {
        // Try undici first (best for Node 18+ native fetch)
        const { setGlobalDispatcher, ProxyAgent } = require("undici");
        const dispatcher = new ProxyAgent(proxyUrl);
        setGlobalDispatcher(dispatcher);
        console.log("[info] ✅ Global proxy configured via undici");
      } catch (e) {
        // Fallback: patch global.fetch with node-fetch + https-proxy-agent
        try {
          const nodeFetch = require("node-fetch");
          const { HttpsProxyAgent } = require("https-proxy-agent");
          const agent = new HttpsProxyAgent(proxyUrl);
          global.fetch = async function (url, options = {}) {
            const res = await nodeFetch(url, { ...options, agent });
            // Fix for Web Streams compatibility
            if (res.body && !res.body.getReader && require("stream").Readable.toWeb) {
              try {
                res.body = require("stream").Readable.toWeb(res.body);
              } catch (err) {}
            }
            return res;
          };
          console.log("[info] ✅ Global proxy configured via https-proxy-agent + node-fetch");
        } catch (err2) {
          console.warn(
            '⚠️ Could not load "undici" or "node-fetch". Proxy might not work for native fetch unless Environment Variables are sufficient.'
          );
          console.warn('ℹ️  To ensure proxy works, please install: npm install undici');
        }
      }
    } else if (proxyUrl.startsWith("socks5")) {
      try {
        const { SocksProxyAgent } = require("socks-proxy-agent");
        const nodeFetch = require("node-fetch");
        const agent = new SocksProxyAgent(proxyUrl);
        global.fetch = async function (url, options = {}) {
          const res = await nodeFetch(url, { ...options, agent });
          if (res.body && !res.body.getReader && require("stream").Readable.toWeb) {
            try {
              res.body = require("stream").Readable.toWeb(res.body);
            } catch (err) {}
          }
          return res;
        };
        console.log("[info] ✅ Global proxy configured via socks-proxy-agent + node-fetch");
      } catch (err) {
        console.error('⚠️ Failed to configure SOCKS5 proxy. "socks-proxy-agent" and "node-fetch" are required.');
        console.warn('ℹ️  Please install: npm install socks-proxy-agent node-fetch');
      }
    }
  } catch (e) {
    console.error("⚠️ Unexpected error configuring proxy:", e.message);
  }
}

