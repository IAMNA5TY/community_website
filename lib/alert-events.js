const { subscribe: sseSubscribe, broadcast: sseBroadcast } = require("./sse-clients");

const clients = new Set();

function subscribe(res) {
  sseSubscribe(clients, res);
}

function broadcastAlert(alert) {
  sseBroadcast(clients, "alert", alert);
}

module.exports = {
  subscribe,
  broadcastAlert,
};
