const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  if (fs.existsSync(dirPath)) return;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    console.error("Failed to create log directory:", err);
  }
}

function formatLogContent(data) {
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      return JSON.stringify(parsed, null, 2);
    } catch (e) {
      return data;
    }
  }
  if (data !== undefined && data !== null) {
    try {
      return JSON.stringify(data, null, 2);
    } catch (e) {
      return String(data);
    }
  }
  return "";
}

function createLogger(options = {}) {
  const logDir = options.logDir || path.resolve(process.cwd(), "log");
  ensureDir(logDir);

  const now = new Date();
  const logFileName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(
    2,
    "0"
  )}-${String(now.getSeconds()).padStart(2, "0")}.log`;

  const logFile = path.join(logDir, logFileName);

  console.log(`[info] 📝 Logging requests to: ${logFile}`);

  const log = (title, data) => {
    const timestamp = new Date().toISOString();
    const separator = "-".repeat(50);
    const contentStr = formatLogContent(data);
    const logEntry = `[${timestamp}] ${title}\n${contentStr}\n${separator}\n`;

    console.log(`\n[${timestamp}] ${title}`);
    if (data !== undefined && data !== null) {
      console.log(contentStr);
    }

    fs.appendFile(logFile, logEntry, (err) => {
      if (err) console.error("Failed to write to log file:", err);
    });
  };

  return { log, logFile };
}

module.exports = {
  createLogger,
};

