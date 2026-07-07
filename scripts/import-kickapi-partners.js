#!/usr/bin/env node
/**
 * One-time helper: import enabled partners from old KickApi config.json into na5ty.com.
 *
 * Usage:
 *   node scripts/import-kickapi-partners.js path/to/KickApi/config.json
 *   API_BASE=https://na5ty.com/api API_KEY=xxx node scripts/import-kickapi-partners.js ...
 */

const fs = require("fs");
const path = require("path");

const configPath =
  process.argv[2] ||
  path.join(__dirname, "..", "..", "KickApi", "config.json");
const apiBase = String(process.env.API_BASE || "https://na5ty.com/api").replace(/\/+$/, "");
const apiKey = process.env.API_KEY || process.env.KICK_REWARDS_API_KEY || "";

function enabledSlugs(config) {
  const slugs = new Set();
  for (const row of config?.monitoring?.streams || []) {
    if (row?.enabled !== false && row?.username) {
      slugs.add(String(row.username).toLowerCase());
    }
  }
  for (const [username, row] of Object.entries(config?.streamers || {})) {
    if (row?.enabled !== false && username) {
      slugs.add(String(username).toLowerCase());
    }
  }
  return [...slugs].sort();
}

async function main() {
  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  const streamers = enabledSlugs(config);
  console.log(`Found ${streamers.length} enabled streamers in ${configPath}`);

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const response = await fetch(`${apiBase}/monitored-streamers/bulk`, {
    method: "POST",
    headers,
    body: JSON.stringify({ streamers }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Import failed:", body.error || response.statusText);
    process.exit(1);
  }

  console.log(`Imported ${body.count} streamers to ${apiBase}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
