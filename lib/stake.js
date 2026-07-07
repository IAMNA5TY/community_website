const STAKE_GRAPHQL = "https://stake.us/_api/graphql";

const AVAILABLE_STATS = [
  "Daily race leaderboard (position, wagered amount, prize payout)",
  "Active and recent races (name, status, schedule, currency)",
  "Your profile basics (username, account age, VIP flag progress)",
  "Gold Coin / balance lookup (filtered from account balances)",
  "Affiliate referral list under your campaign code (na5ty)",
  "Referral leaderboard by commission order (wagering proxy)",
  "Monthly and last-30-days referral activity tracking (deposit deltas from snapshots)",
];

const BLOCKED_STATS = [
  "Exact referred-user wager amounts from Stake.us",
  "Affiliate dashboard totals via alternate API routes",
  "Personal race history and positions",
  "Per-game wagering statistics",
  "Bet history and archives",
];

function getToken() {
  return process.env.STAKE_ACCESS_TOKEN || "";
}

function isConfigured() {
  return Boolean(getToken());
}

async function graphql(query, variables = {}, operationName) {
  const token = getToken();
  if (!token) {
    throw new Error("Stake.us access token not configured. Add STAKE_ACCESS_TOKEN to .env");
  }

  const response = await fetch(STAKE_GRAPHQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-access-token": token,
      origin: "https://stake.us",
      referer: "https://stake.us/",
    },
    body: JSON.stringify({ query, variables, operationName }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.errors?.[0]?.message || `Stake.us API error (${response.status})`);
  }
  if (payload.errors?.length) {
    throw new Error(payload.errors[0].message);
  }
  return payload.data;
}

function abbreviateNumber(value) {
  const amount = Number(value) || 0;
  const abs = Math.abs(amount);
  if (abs >= 1e12) return `${(amount / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(amount / 1e3).toFixed(1)}K`;
  return amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function currencyLabel(currency) {
  if (currency === "gold") return "GC";
  if (currency === "sweeps") return "SC";
  return String(currency || "").toUpperCase();
}

function formatAmount(value, currency) {
  return `${abbreviateNumber(value)} ${currencyLabel(currency)}`;
}

function normalizeRace(race) {
  if (!race) return null;
  return {
    id: race.id,
    name: race.name,
    status: race.status,
    currency: race.currency,
    currencyLabel: currencyLabel(race.currency),
    type: race.type,
    startTime: race.startTime,
    endTime: race.endTime,
  };
}

function normalizeLeaderboardEntry(entry, currency) {
  return {
    position: entry.position,
    username: entry.user?.name || "Hidden",
    userId: entry.user?.id || null,
    hidden: !entry.user?.name,
    wageredAmount: entry.wageredAmount,
    wageredLabel: formatAmount(entry.wageredAmount, currency),
    payoutAmount: entry.payoutAmount,
    payoutLabel: formatAmount(entry.payoutAmount, currency),
  };
}

async function getProfile() {
  const data = await graphql(
    `query StakeProfile {
      user {
        id
        name
        createdAt
        flagProgress { flag progress }
      }
    }`,
    {},
    "StakeProfile"
  );

  return {
    id: data.user.id,
    name: data.user.name,
    createdAt: data.user.createdAt,
    flagProgress: data.user.flagProgress,
  };
}

async function getBalances() {
  const data = await graphql(
    `query StakeBalances {
      user {
        balances {
          available { amount currency }
        }
      }
    }`,
    {},
    "StakeBalances"
  );

  return (data.user.balances || [])
    .map((entry) => ({
      currency: entry.available.currency,
      amount: entry.available.amount,
      label: currencyLabel(entry.available.currency),
    }))
    .filter((entry) => entry.amount > 0);
}

async function getRaces() {
  const data = await graphql(
    `query StakeRaces {
      activeRaces {
        id
        name
        status
        startTime
        endTime
        currency
        type
      }
      raceList {
        id
        name
        status
        startTime
        endTime
        currency
        type
      }
    }`,
    {},
    "StakeRaces"
  );

  return {
    active: (data.activeRaces || []).map(normalizeRace),
    all: (data.raceList || []).map(normalizeRace),
  };
}

async function getRaceLeaderboard(raceId, limit = 25) {
  const data = await graphql(
    `query StakeRaceLeaderboard($raceId: String!, $limit: Int) {
      race(raceId: $raceId) {
        id
        name
        status
        startTime
        endTime
        currency
        type
        leaderboard(limit: $limit) {
          position
          wageredAmount
          finalAmount
          payoutAmount
          user { id name }
        }
      }
    }`,
    { raceId, limit },
    "StakeRaceLeaderboard"
  );

  const race = normalizeRace(data.race);
  return {
    race,
    entries: (data.race?.leaderboard || []).map((entry) =>
      normalizeLeaderboardEntry(entry, race.currency)
    ),
  };
}

async function getActiveLeaderboard(limit = 25) {
  const races = await getRaces();
  const activeRace = races.active[0] || races.all.find((race) => race.status === "started");
  if (!activeRace) {
    return { race: null, entries: [] };
  }
  return getRaceLeaderboard(activeRace.id, limit);
}

async function getStatus() {
  if (!isConfigured()) {
    return {
      connected: false,
      configured: false,
      message: "Add STAKE_ACCESS_TOKEN to .env (from browser DevTools → Network → graphql → x-access-token)",
      availableStats: AVAILABLE_STATS,
      blockedStats: BLOCKED_STATS,
    };
  }

  try {
    const [profile, races, balances] = await Promise.all([
      getProfile(),
      getRaces(),
      getBalances().catch(() => []),
    ]);

    return {
      connected: true,
      configured: true,
      profile,
      balances,
      activeRace: races.active[0] || null,
      raceCount: races.all.length,
      availableStats: AVAILABLE_STATS,
      blockedStats: BLOCKED_STATS,
      note:
        "Stake.us has no official public API. This uses your session token and can read race leaderboards. Affiliate stats and personal bet history are blocked on this account.",
    };
  } catch (error) {
    return {
      connected: false,
      configured: true,
      message: error.message,
      availableStats: AVAILABLE_STATS,
      blockedStats: BLOCKED_STATS,
    };
  }
}

module.exports = {
  AVAILABLE_STATS,
  BLOCKED_STATS,
  isConfigured,
  getStatus,
  getProfile,
  getBalances,
  getRaces,
  getRaceLeaderboard,
  getActiveLeaderboard,
  formatAmount,
  abbreviateNumber,
  currencyLabel,
};
