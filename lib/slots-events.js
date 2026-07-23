const { subscribe: sseSubscribe, broadcast: sseBroadcast } = require("./sse-clients");

const clients = new Set();

function subscribe(res) {
  sseSubscribe(clients, res);
}

function broadcastPick(state) {
  if (!state?.lastPick) return;
  sseBroadcast(clients, "pick", {
    pickNonce: state.pickNonce,
    lastPick: state.lastPick,
  });
}

module.exports = {
  subscribe,
  broadcastPick,
};
