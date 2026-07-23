const { subscribe: sseSubscribe, broadcast: sseBroadcast } = require("./sse-clients");

const clients = new Set();

function subscribe(res) {
  sseSubscribe(clients, res);
}

function broadcastShotgun(state) {
  sseBroadcast(clients, "shotgun", {
    shotgunNonce: state.shotgunNonce,
    sessionCount: state.sessionCount,
    lifetimeCount: state.lifetimeCount,
    sessionGoal: state.sessionGoal,
    lastShotgunBy: state.lastShotgunBy,
    lastShotgunAt: state.lastShotgunAt,
  });
}

function broadcastCheers(state) {
  sseBroadcast(clients, "cheers", {
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
