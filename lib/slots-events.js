const clients = new Set();

function subscribe(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  clients.add(res);
  res.on("close", () => clients.delete(res));
}

function broadcast(event, payload) {
  const data = JSON.stringify({ event, ...payload });
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
  }
}

function broadcastPick(state) {
  if (!state?.lastPick) return;
  broadcast("pick", {
    pickNonce: state.pickNonce,
    lastPick: state.lastPick,
  });
}

module.exports = {
  subscribe,
  broadcastPick,
};
