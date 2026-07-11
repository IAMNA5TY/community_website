const path = require("path");
const fs = require("fs");

/**
 * Shared data directory. On Railway, mount a volume and set DATA_DIR=/data
 * so deploys do not wipe workout minutes, partners, or tokens.
 */
function getDataDir() {
  const fromEnv = String(process.env.DATA_DIR || "").trim();
  if (fromEnv) return fromEnv;
  return path.join(__dirname, "..", "data");
}

function ensureDataDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

module.exports = {
  getDataDir,
  ensureDataDir,
};
