/**
 * Resolve how many subs a Kick webhook represents (gift batches, etc.).
 */
function countGiftRecipients(payload = {}) {
  const lists = [
    payload.giftees,
    payload.gifted_users,
    payload.gifted_usernames,
    payload.recipients,
    payload.giftee_usernames,
  ];

  for (const list of lists) {
    if (!Array.isArray(list) || list.length === 0) continue;
    return list.length;
  }

  return 0;
}

function parseSubscriptionQuantity(eventType, payload = {}) {
  const giftCount = countGiftRecipients(payload);
  if (giftCount > 0) {
    return giftCount;
  }

  const candidates = [
    payload.quantity,
    payload.gift_count,
    payload.gifted_amount,
    payload.gifts_count,
    payload.gift_sub_count,
    payload.count,
    payload.amount,
    payload.gift?.amount,
    payload.gift?.quantity,
    payload.gift?.count,
    payload.subscription?.quantity,
    payload.subscriptions?.length,
  ];

  for (const value of candidates) {
    if (value == null || value === "") continue;
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 1;
}

function shouldCreditWorkout(eventType) {
  if (!eventType || !String(eventType).startsWith("channel.subscription")) {
    return false;
  }
  // Renewals don't add treadmill time in the sub=minute model.
  return !String(eventType).includes("renewal");
}

module.exports = {
  countGiftRecipients,
  parseSubscriptionQuantity,
  shouldCreditWorkout,
};
