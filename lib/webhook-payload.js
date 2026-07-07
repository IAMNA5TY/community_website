/**
 * Kick webhooks sometimes wrap fields under `data` while also sending
 * gifter/giftees at the root — prefer a merged view so gift qty is not lost.
 */
function extractWebhookPayload(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  const merged = { ...body };

  for (const key of ["data", "payload"]) {
    const nested = body[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      Object.assign(merged, nested);
    }
  }

  return merged;
}

module.exports = {
  extractWebhookPayload,
};
