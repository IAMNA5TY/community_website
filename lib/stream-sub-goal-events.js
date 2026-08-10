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

function broadcast(state) {
  const data = JSON.stringify({ event: "sub-goal", ...state });
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
  }
}

module.exports = {
  subscribe,
  broadcast,
};
