const { subscribe: sseSubscribe, broadcast: sseBroadcast } = require("./sse-clients");

const clients = new Set();

function subscribe(res) {
  sseSubscribe(clients, res);
}

function broadcastMessage(message) {
  if (!message) return;
  sseBroadcast(clients, "message", { message });
}

module.exports = {
  subscribe,
  broadcastMessage,
};
