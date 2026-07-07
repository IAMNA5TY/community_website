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

function broadcastShotgun(state) {
  broadcast("shotgun", {
    shotgunNonce: state.shotgunNonce,
    sessionCount: state.sessionCount,
    lifetimeCount: state.lifetimeCount,
    sessionGoal: state.sessionGoal,
    lastShotgunBy: state.lastShotgunBy,
    lastShotgunAt: state.lastShotgunAt,
  });
}

function broadcastCheers(state) {
  broadcast("cheers", {
    cheersNonce: state.cheersNonce,
    cheersSessionCount: state.cheersSessionCount,
    cheersLifetimeCount: state.cheersLifetimeCount,
    lastCheersBy: state.lastCheersBy,
    lastCheersAt: state.lastCheersAt,
    sessionCount: state.sessionCount,
    sessionGoal: state.sessionGoal,
  });
}

module.exports = {
  subscribe,
  broadcastShotgun,
  broadcastCheers,
};
