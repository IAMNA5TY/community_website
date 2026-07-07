const clients = new Set();

function subscribe(res, initialState = null) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  if (initialState) {
    res.write(`data: ${JSON.stringify({ event: "timer", state: initialState })}\n\n`);
  }

  clients.add(res);
  res.on("close", () => clients.delete(res));
}

function broadcast(event, payload) {
  const data = JSON.stringify({ event, ...payload });
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
  }
}

function broadcastTimer(state) {
  if (!state) return;
  broadcast("timer", { state });
}

module.exports = {
  subscribe,
  broadcastTimer,
};
