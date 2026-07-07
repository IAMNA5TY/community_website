const subscriptionUtils = require("./subscription-utils");

function pickUsername(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if (value?.username) return value.username;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return payload.username || "Someone";
}

function buildAlertDetail(type, quantity = 1) {
  if (type === "follow") return "FOR THE FOLLOW";
  if (type === "sub") return "FOR THE SUB";
  if (type === "gift") {
    return quantity > 1 ? `FOR ${quantity} GIFTED SUBS` : "FOR THE GIFTED SUB";
  }
  if (type === "kicks") {
    return quantity > 1 ? `FOR ${quantity} KICKS` : "FOR THE KICKS";
  }
  return "FOR THE SUPPORT";
}

function buildTreadmillExtra(type, quantity = 1) {
  if (type !== "sub" && type !== "gift") return "";
  const mins = Math.max(1, quantity);
  const label = mins === 1 ? "1 MIN" : `${mins} MINS`;
  return `YOU ADDED ${label} TO THE TREADMILL`;
}

function buildAlert(eventType, payload = {}) {
  if (eventType === "channel.followed") {
    const username = pickUsername(payload, ["follower", "user"]);
    return {
      type: "follow",
      username,
      quantity: 1,
      detail: buildAlertDetail("follow"),
    };
  }

  if (eventType === "channel.subscription.gifts") {
    const quantity = subscriptionUtils.parseSubscriptionQuantity(eventType, payload);
    const username = pickUsername(payload, ["gifter", "user"]);
    return {
      type: "gift",
      username,
      quantity,
      detail: buildAlertDetail("gift", quantity),
      extra: buildTreadmillExtra("gift", quantity),
    };
  }

  if (eventType === "channel.subscription.new") {
    const username = pickUsername(payload, ["subscriber", "user"]);
    return {
      type: "sub",
      username,
      quantity: 1,
      detail: buildAlertDetail("sub"),
      extra: buildTreadmillExtra("sub", 1),
    };
  }

  if (eventType === "kicks.gifted") {
    const username = pickUsername(payload, ["gifter", "sender", "user"]);
    const quantity = Math.max(
      1,
      parseInt(
        payload.gifted_amount ||
          payload.amount ||
          payload.kicks ||
          payload.quantity ||
          1,
        10
      ) || 1
    );
    return {
      type: "kicks",
      username,
      quantity,
      detail: buildAlertDetail("kicks", quantity),
    };
  }

  return null;
}

function buildTestAlert(type, options = {}) {
  const username = options.username || "TestViewer";
  const quantity = Math.max(1, parseInt(options.quantity, 10) || 1);

  if (type === "follow") {
    return buildAlert("channel.followed", { follower: { username } });
  }
  if (type === "gift") {
    return buildAlert("channel.subscription.gifts", {
      gifter: { username },
      giftees: Array.from({ length: quantity }, (_, i) => ({
        username: `Recipient${i + 1}`,
      })),
    });
  }
  if (type === "sub") {
    return buildAlert("channel.subscription.new", {
      subscriber: { username },
    });
  }
  if (type === "kicks") {
    return buildAlert("kicks.gifted", {
      gifter: { username },
      gifted_amount: quantity,
    });
  }

  return null;
}

module.exports = {
  buildAlert,
  buildTestAlert,
};
