const { subscribe: sseSubscribe, broadcast: sseBroadcast } = require("./sse-clients");

const clients = new Set();

function subscribe(res, initialState = null) {
  sseSubscribe(clients, res, {
    initialPayload: initialState
      ? { event: "timer", state: initialState }
      : null,
  });
}

function broadcastTimer(state) {
  if (!state) return;
  sseBroadcast(clients, "timer", { state });
}

module.exports = {
  subscribe,
  broadcastTimer,
};
