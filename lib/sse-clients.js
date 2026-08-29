"use strict";

/**
 * Safe Server-Sent Events helpers.
 * Writing to a closed OBS/browser connection must never crash the process.
 * Do not send Connection / Keep-Alive — HTTP/2 forbids those hop-by-hop
 * headers and Chrome reports net::ERR_HTTP2_PROTOCOL_ERROR.
 */

const HEARTBEAT_MS = 20000;

function subscribe(clients, res, { initialPayload = null } = {}) {
  const socket = res.socket;
  if (socket) {
    socket.setTimeout(0);
    if (typeof socket.setNoDelay === "function") socket.setNoDelay(true);
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  // HTTP/2 rejects Connection / Keep-Alive. Node's HTTP/1.1 layer may still
  // add Connection for the proxy hop; never set it ourselves.
  res.removeHeader("Connection");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  try {
    res.write(": connected\n\n");
    if (initialPayload != null) {
      res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);
    }
  } catch {
    return;
  }

  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      if (res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }
      res.write(": ping\n\n");
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };
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
