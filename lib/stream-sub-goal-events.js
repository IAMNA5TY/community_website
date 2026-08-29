const { subscribe: sseSubscribe, broadcast: sseBroadcast } = require("./sse-clients");

const clients = new Set();

function subscribe(res) {
  sseSubscribe(clients, res);
}

function broadcast(state) {
  sseBroadcast(clients, "sub-goal", state);
}

module.exports = {
  subscribe,
  broadcast,
};
