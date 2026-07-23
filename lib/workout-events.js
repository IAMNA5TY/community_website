const { subscribe: sseSubscribe, broadcast: sseBroadcast } = require("./sse-clients");

const clients = new Set();

function subscribe(res) {
  sseSubscribe(clients, res);
}

function broadcastState(state) {
  sseBroadcast(clients, "workout", {
    stateNonce: state.stateNonce || 0,
    isRunning: Boolean(state.isRunning),
  });
}

module.exports = {
  subscribe,
  broadcastState,
};
