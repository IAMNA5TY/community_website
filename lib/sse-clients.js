'use strict';

/**
 * Safe Server-Sent Events helpers.
 * Writing to a closed OBS/browser connection must never crash the process.
 */

function subscribe(clients, res, { initialPayload = null } = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  try {
    res.write(": connected\n\n");
    if (initialPayload != null) {
      res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);
    }
  } catch {
    return;
  }

  clients.add(res);
  const cleanup = () => clients.delete(res);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function broadcast(clients, event, payload) {
  const data = JSON.stringify({ event, ...payload });
  const line = `data: ${data}\n\n`;
  for (const client of [...clients]) {
    try {
      if (client.writableEnded || client.destroyed) {
        clients.delete(client);
        continue;
      }
      client.write(line);
    } catch {
      clients.delete(client);
    }
  }
}

module.exports = {
  subscribe,
  broadcast,
};
