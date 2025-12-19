const path = require("path");

const httpClient = require("../auth/httpClient");

class UpstreamClient {
  constructor(authManager, options = {}) {
    this.auth = authManager;
    this.logger = options.logger || null;
  }

  log(title, data) {
    if (this.logger) return this.logger(title, data);
    if (data !== undefined && data !== null) {
      console.log(`[${title}]`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    } else {
      console.log(`[${title}]`);
    }
  }

  getMaxAttempts() {
    const n = this.auth && typeof this.auth.getAccountCount === "function" ? this.auth.getAccountCount() : 0;
    return Math.max(1, n || 0);
  }

  getQuotaGroupFromModel(model) {
    const m = String(model || "").toLowerCase();
    if (m.includes("claude")) return "claude";
    if (m.includes("gemini")) return "gemini";
    return "gemini";
  }

  parseDurationMs(durationStr) {
    if (!durationStr) return null;
    const str = String(durationStr).trim();
    if (!str) return null;

    let totalMs = 0;
    let matched = false;
    const re = /([\d.]+)\s*(ms|s|m|h)/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      matched = true;
      const value = parseFloat(m[1]);
      if (!Number.isFinite(value)) continue;
      const unit = m[2];
      if (unit === "ms") totalMs += value;
      else if (unit === "s") totalMs += value * 1000;
      else if (unit === "m") totalMs += value * 60 * 1000;
      else if (unit === "h") totalMs += value * 60 * 60 * 1000;
    }
    if (!matched) return null;
    return Math.round(totalMs);
  }

  parseRetryDelayMs(errText) {
    try {
      const errObj = JSON.parse(errText);
      const details = errObj.error?.details || [];

      // RetryInfo.retryDelay like "1.203608125s"
      const retryInfo = details.find((d) => d["@type"]?.includes("RetryInfo"));
      if (retryInfo?.retryDelay) {
        const ms = this.parseDurationMs(retryInfo.retryDelay);
        if (ms != null) return ms;
      }

      // quotaResetDelay like "331.167174ms" or "1h16m0.667923083s"
      const metaDelay = details.find((d) => d.metadata?.quotaResetDelay)?.metadata?.quotaResetDelay;
      if (metaDelay) {
        const ms = this.parseDurationMs(metaDelay);
        if (ms != null) return ms;
      }
    } catch (_) {}
    return null;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * v1internal call with 429 retry + per-model quota group rotation.
   * @param {string} method - v1internal method (e.g. "generateContent")
   * @param {object} options
   * @param {string} [options.group] - "claude" | "gemini" (defaults to inferred from model)
   * @param {string} [options.model] - Used to infer group when group is not provided
   * @param {string} [options.queryString]
   * @param {(projectId: string) => object} options.buildBody
   * @param {object} [options.headers]
   * @returns {Promise<Response>}
   */
  async callV1Internal(method, options = {}) {
    const buildBody = options.buildBody;
    if (typeof buildBody !== "function") {
      throw new Error("UpstreamClient.callV1Internal requires options.buildBody(projectId)");
    }

    const quotaGroup = this.getQuotaGroupFromModel(options.group || options.model);
    const queryString = options.queryString || "";
    const headers = options.headers && typeof options.headers === "object" ? options.headers : {};

    let lastResponse = null;
    const maxAttempts = this.getMaxAttempts();

    for (let attempts = 0; attempts < maxAttempts; attempts++) {
      let creds;
      try {
        creds = await this.auth.getCredentials(quotaGroup);
      } catch (e) {
        throw e;
      }

      const accountName = creds?.account?.filePath ? path.basename(creds.account.filePath) : "unknown-account";
      const requestBody = buildBody(creds.projectId);

      let response;
      try {
        response = await httpClient.callV1Internal(method, creds.accessToken, requestBody, {
          queryString,
          headers,
          limiter: this.auth.apiLimiter,
        });
      } catch (netErr) {
        // Network/transport error: rotate and try next account.
        lastResponse = null;
        this.log("warn", `Network error calling v1internal:${method} on [${quotaGroup}] ${accountName}: ${netErr.message || netErr}`);
        if (this.auth && typeof this.auth.rotateAccount === "function") {
          this.auth.rotateAccount(quotaGroup);
        }
        continue;
      }

      if (response.ok) return response;

      // Non-429 4xx: do not retry/rotate, pass through as-is.
      if (response.status !== 429) {
        return response;
      }

      lastResponse = response;

      // 429: decide short-wait retry vs rotate.
      let errorText = "";
      try {
        errorText = await response.clone().text();
      } catch (_) {}

      const retryMs = this.parseRetryDelayMs(errorText);
      this.log(`Google API Error (429) - [${quotaGroup}] ${accountName}`, errorText || "(empty 429 body)");

      if (retryMs != null && retryMs <= 5000) {
        const delay = Math.max(0, retryMs + 200);
        this.log("info", `⏳ 429 retry after ${delay}ms on same account (${accountName})`);
        await this.sleep(delay);

        // Retry once on the same account with the same request body.
        let retryResp;
        try {
          retryResp = await httpClient.callV1Internal(method, creds.accessToken, requestBody, {
            queryString,
            headers,
            limiter: this.auth.apiLimiter,
          });
        } catch (netErr2) {
          this.log(
            "warn",
            `Network error retrying v1internal:${method} on [${quotaGroup}] ${accountName}: ${netErr2.message || netErr2}`
          );
          if (this.auth && typeof this.auth.rotateAccount === "function") {
            this.auth.rotateAccount(quotaGroup);
          }
          continue;
        }

        if (retryResp.ok) return retryResp;
        if (retryResp.status !== 429) return retryResp;

        lastResponse = retryResp;
      }

      // Rotate to next account (either delay>5s, no delay, or retry still 429).
      this.log("warn", `⚠️ 429 encountered. Rotating to next account for [${quotaGroup}]...`);
      if (this.auth && typeof this.auth.rotateAccount === "function") {
        this.auth.rotateAccount(quotaGroup);
      }
    }

    // Exhausted: return the last upstream 429 response as-is (status/headers/body passthrough).
    if (lastResponse) return lastResponse;

    const error = new Error(`Upstream call exhausted without a response (v1internal:${method})`);
    error.status = 500;
    throw error;
  }

  async fetchAvailableModels() {
    const accessToken = await this.auth.getCurrentAccessToken();
    return httpClient.fetchAvailableModels(accessToken, this.auth.apiLimiter);
  }

  /**
   * v1internal:countTokens with 429 rotation policy (final 429 passthrough).
   * @param {object} body - Raw countTokens request body (typically { request: { model, contents } })
   * @param {object} [options]
   * @param {string} [options.group]
   * @param {string} [options.model]
   * @returns {Promise<Response>}
   */
  async countTokens(body, options = {}) {
    const inferredModel = options.model || body?.request?.model || body?.model;
    return this.callV1Internal("countTokens", {
      group: options.group,
      model: inferredModel,
      buildBody: () => body || {},
    });
  }
}

module.exports = UpstreamClient;
