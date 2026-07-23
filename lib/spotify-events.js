const { subscribe: sseSubscribe, broadcast: sseBroadcast } = require("./sse-clients");

const clients = new Set();

function subscribe(res) {
  sseSubscribe(clients, res);
}

function broadcastPlayback(state) {
  sseBroadcast(clients, "playback", { state });
}

module.exports = {
  subscribe,
  broadcastPlayback,
};
