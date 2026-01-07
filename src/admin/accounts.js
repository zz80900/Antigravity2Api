const path = require("path");
const httpClient = require("../auth/httpClient");

function getAccountsPayload(authManager) {
  const accounts = authManager.getAccountsSummary();
  return {
    count: accounts.length,
    current: {
      claude: authManager.getCurrentAccountIndex("claude"),
      gemini: authManager.getCurrentAccountIndex("gemini"),
    },
    accounts,
  };
}

async function deleteAccount(authManager, fileName) {
  const ok = await authManager.deleteAccountByFile(fileName);
  return ok;
}

async function reloadAccounts(authManager) {
  const accounts = await authManager.reloadAccounts();
  return {
    count: accounts.length,
    current: {
      claude: authManager.getCurrentAccountIndex("claude"),
      gemini: authManager.getCurrentAccountIndex("gemini"),
    },
    accounts,
  };
}

async function getAccountQuota(authManager, fileName, upstreamClient) {
  const safeName = String(fileName || "").trim();
  const account = authManager.accounts.find((acc) => path.basename(acc.filePath) === safeName);
  
  if (!account) {
    throw new Error("Account not found");
  }

  const accountIndex = authManager.accounts.indexOf(account);
  const originalClaudeIdx = authManager.getCurrentAccountIndex("claude");
  const originalGeminiIdx = authManager.getCurrentAccountIndex("gemini");

  let models;
  try {
    authManager.setCurrentAccountIndex("claude", accountIndex);
    authManager.setCurrentAccountIndex("gemini", accountIndex);
    models = await upstreamClient.fetchAvailableModels();
  } finally {
    authManager.setCurrentAccountIndex("claude", originalClaudeIdx);
    authManager.setCurrentAccountIndex("gemini", originalGeminiIdx);
  }
  
  const result = [];
  if (models && typeof models === "object") {
    for (const modelId in models) {
      if (modelId.includes("gemini") || modelId.includes("claude")) {
        const m = models[modelId];
        const quota = m.quotaInfo || {};
        const limit = quota.remainingFraction !== undefined 
          ? `${Math.round(quota.remainingFraction * 100)}%` 
          : "-";
        
        let reset = "-";
        if (quota.resetTime) {
            try {
                const d = new Date(quota.resetTime);
                // Format: yyyy-MM-dd HH:mm:ss (server local time)
                const yyyy = d.getFullYear();
                const MM = String(d.getMonth() + 1).padStart(2, "0");
                const dd = String(d.getDate()).padStart(2, "0");
                const HH = String(d.getHours()).padStart(2, "0");
                const mm = String(d.getMinutes()).padStart(2, "0");
                const ss = String(d.getSeconds()).padStart(2, "0");
                reset = `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
            } catch(e) {}
        }

        result.push({
          model: modelId,
          limit,
          reset,
        });
      }
    }
  }
  
  result.sort((a, b) => a.model.localeCompare(b.model));

  return result;
}

module.exports = {
  getAccountsPayload,
  deleteAccount,
  reloadAccounts,
  getAccountQuota,
};