const fs = require("fs");
const path = require("path");

const stake = require("./stake");

const SNAPSHOT_FILE = path.join(__dirname, "..", "data", "stake-affiliate-snapshots.json");
const DEFAULT_CODE = process.env.STAKE_AFFILIATE_CODE || "na5ty";
const PAGE_SIZE = 50;

function getMonthKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getMonthStart(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getDaysAgoStart(days, date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days);
  return start;
}

function getDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadSnapshots() {
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) {
      return { months: {}, daily: {}, history: [] };
    }
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch {
    return { months: {}, daily: {}, history: [] };
  }
}

function saveSnapshots(data) {
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
}

async function graphql(query, variables = {}) {
  const token = process.env.STAKE_ACCESS_TOKEN;
  if (!token) throw new Error("Stake.us access token not configured");

  const response = await fetch("https://stake.us/_api/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-access-token": token,
      origin: "https://stake.us",
      referer: "https://stake.us/",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.[0]?.message || `Stake.us API error (${response.status})`);
  }
  return payload.data;
}

async function getCampaign(code = DEFAULT_CODE) {
  const data = await graphql(
    `query StakeCampaign {
      user {
        campaignList {
          id
          name
          code
          referCount
          comission
          depositCount
        }
      }
    }`
  );

  const campaign = data.user.campaignList.find(
    (entry) => entry.code.toLowerCase() === code.toLowerCase()
  );
  if (!campaign) {
    throw new Error(`Affiliate campaign code "${code}" not found on this account`);
  }
  return campaign;
}

async function fetchReferredUsers(code = DEFAULT_CODE, sort = "commissionDesc") {
  const campaign = await getCampaign(code);
  let offset = 0;
  const users = [];

  while (true) {
    const data = await graphql(
      `query StakeReferredUsers($limit: Int!, $offset: Int!, $sort: CampaignReferredUsersSortOptionsEnum) {
        user {
          campaignList {
            code
            referredUserList(limit: $limit, offset: $offset, sort: $sort) {
              name
              userId
              depositCount
              lastDepositAt
              createdAt
            }
          }
        }
      }`,
      { limit: PAGE_SIZE, offset, sort }
    );

    const entry = data.user.campaignList.find(
      (item) => item.code.toLowerCase() === code.toLowerCase()
    );
    const page = entry?.referredUserList || [];
    users.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset >= campaign.referCount) break;
  }

  const monthStart = getMonthStart();
  const days30Start = getDaysAgoStart(30);

  return users.map((user, index) => ({
    rank: index + 1,
    name: user.name,
    userId: user.userId,
    depositCount: user.depositCount || 0,
    lastDepositAt: user.lastDepositAt,
    createdAt: user.createdAt,
    activeThisMonth: isActiveSince(user, monthStart),
    activeLast30Days: isActiveSince(user, days30Start),
  }));
}

function recordSnapshot(users, code = DEFAULT_CODE) {
  const store = loadSnapshots();
  const monthKey = getMonthKey();
  const capturedAt = new Date().toISOString();

  if (!store.months[monthKey]) {
    store.months[monthKey] = { baselineAt: capturedAt, users: {} };
  }

  const monthStore = store.months[monthKey];
  if (!monthStore.baselineAt) monthStore.baselineAt = capturedAt;

  for (const user of users) {
    if (!monthStore.users[user.userId]) {
      monthStore.users[user.userId] = {
        name: user.name,
        baselineDepositCount: user.depositCount,
        baselineRank: user.rank,
        baselineAt: capturedAt,
      };
    }

    monthStore.users[user.userId].name = user.name;
    monthStore.users[user.userId].latestDepositCount = user.depositCount;
    monthStore.users[user.userId].latestRank = user.rank;
    monthStore.users[user.userId].latestAt = capturedAt;
    monthStore.users[user.userId].depositDelta =
      user.depositCount - (monthStore.users[user.userId].baselineDepositCount || 0);
    monthStore.users[user.userId].rankDelta =
      (monthStore.users[user.userId].baselineRank || user.rank) - user.rank;
  }

  store.history.push({
    capturedAt,
    code,
    monthKey,
    userCount: users.length,
  });
  store.history = store.history.slice(-200);

  if (!store.daily) store.daily = {};
  const dayKey = getDayKey();
  store.daily[dayKey] = {
    capturedAt,
    users: Object.fromEntries(
      users.map((user) => [
        user.userId,
        {
          name: user.name,
          depositCount: user.depositCount,
          rank: user.rank,
        },
      ])
    ),
  };

  const dayKeys = Object.keys(store.daily).sort();
  while (dayKeys.length > 40) {
    const oldest = dayKeys.shift();
    delete store.daily[oldest];
  }

  saveSnapshots(store);
  return store;
}

function findBaselineSnapshot(store, days = 30) {
  if (!store.daily) return null;

  const target = getDaysAgoStart(days);
  const dayKeys = Object.keys(store.daily).sort();
  if (!dayKeys.length) return null;

  const oldestDate = new Date(`${dayKeys[0]}T00:00:00`);
  if (oldestDate > target) return null;

  const eligibleKeys = dayKeys.filter((dayKey) => new Date(`${dayKey}T00:00:00`) <= target);
  if (!eligibleKeys.length) return null;

  let bestKey = eligibleKeys[0];
  let bestDiff = Math.abs(new Date(`${bestKey}T00:00:00`) - target);

  for (const dayKey of eligibleKeys) {
    const diff = Math.abs(new Date(`${dayKey}T00:00:00`) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestKey = dayKey;
    }
  }

  return {
    dayKey: bestKey,
    snapshot: store.daily[bestKey],
  };
}

function isActiveSince(user, since) {
  const lastDeposit = user.lastDepositAt ? new Date(user.lastDepositAt) : null;
  const created = user.createdAt ? new Date(user.createdAt) : null;
  return (lastDeposit && lastDeposit >= since) || (created && created >= since);
}

function buildDeltaLeaderboard(users, baselineUsers, options) {
  const {
    period,
    code,
    metricSuffix,
    trackingSince,
    deltaNote,
    fallbackNote,
    activeSince,
  } = options;

  if (baselineUsers && Object.keys(baselineUsers).length) {
    const entries = users
      .map((user) => {
        const baseline = baselineUsers[user.userId];
        const depositDelta = baseline
          ? user.depositCount - (baseline.depositCount || 0)
          : 0;
        return {
          rank: 0,
          name: user.name,
          userId: user.userId,
          depositCount: user.depositCount,
          depositDelta,
          commissionRank: user.rank,
          lastDepositAt: user.lastDepositAt,
          metricLabel: `${depositDelta} deposits ${metricSuffix}`,
          metricValue: depositDelta,
        };
      })
      .filter((entry) => entry.depositDelta > 0)
      .sort((a, b) => {
        if (b.depositDelta !== a.depositDelta) return b.depositDelta - a.depositDelta;
        return a.commissionRank - b.commissionRank;
      });

    if (entries.length) {
      return {
        period,
        code,
        trackingSince,
        note: deltaNote,
        entries: entries.slice(0, 25).map((entry, index) => ({ ...entry, rank: index + 1 })),
      };
    }
  }

  const entries = users
    .filter((user) => isActiveSince(user, activeSince))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 50)
    .map((user, index) => ({
      rank: index + 1,
      name: user.name,
      userId: user.userId,
      depositCount: user.depositCount,
      depositDelta: null,
      commissionRank: user.rank,
      lastDepositAt: user.lastDepositAt,
      metricLabel: `Commission rank #${user.rank}`,
      metricValue: user.rank,
    }));

  return {
    period,
    code,
    trackingSince,
    note: fallbackNote,
    entries,
  };
}

function buildMonthlyLeaderboard(users, code = DEFAULT_CODE) {
  const store = loadSnapshots();
  const monthKey = getMonthKey();
  const monthStore = store.months[monthKey];
  const baselineUsers = monthStore?.users
    ? Object.fromEntries(
        Object.entries(monthStore.users).map(([userId, entry]) => [
          userId,
          { depositCount: entry.baselineDepositCount || 0, rank: entry.baselineRank || 0 },
        ])
      )
    : null;

  return {
    monthKey,
    ...buildDeltaLeaderboard(users, baselineUsers, {
      period: "month",
      code,
      metricSuffix: "this month",
      trackingSince: monthStore?.baselineAt || null,
      activeSince: getMonthStart(),
      deltaNote:
        "Monthly board ranks referrals by deposit activity gained since the start of this month. Stake.us does not expose exact wager amounts via API.",
      fallbackNote:
        "No new deposit activity recorded yet this month. Showing active referrals ranked by lifetime commission order until monthly deltas build up.",
    }),
  };
}

function buildLast30DaysLeaderboard(users, code = DEFAULT_CODE) {
  const store = loadSnapshots();
  const baseline = findBaselineSnapshot(store, 30);
  const activeSince = getDaysAgoStart(30);
  const activeUsers = users.filter((user) => isActiveSince(user, activeSince));

  const leaderboard = buildDeltaLeaderboard(users, baseline?.snapshot?.users, {
    period: "30days",
    code,
    metricSuffix: "last 30 days",
    trackingSince: baseline?.snapshot?.capturedAt || null,
    activeSince,
    deltaNote:
      "Last 30 days ranks referrals by deposit activity gained over the last 30 days. Stake.us does not expose exact wager amounts via API.",
    fallbackNote: `Showing ${activeUsers.length} referrals active in the last 30 days, ranked by lifetime commission order (wagering proxy).`,
  });

  return {
    windowDays: 30,
    baselineDay: baseline?.dayKey || null,
    activeCount: activeUsers.length,
    ...leaderboard,
  };
}

function buildLifetimeLeaderboard(users, code = DEFAULT_CODE) {
  return {
    period: "lifetime",
    code,
    note:
      "Ranked by Stake commission order — the closest available proxy for total referred wagering. Exact wager amounts are hidden by Stake.us.",
    entries: users.slice(0, 25).map((user) => ({
      rank: user.rank,
      name: user.name,
      userId: user.userId,
      depositCount: user.depositCount,
      depositDelta: null,
      commissionRank: user.rank,
      lastDepositAt: user.lastDepositAt,
      metricLabel: `${user.depositCount} total deposits`,
      metricValue: user.depositCount,
    })),
  };
}

async function getAffiliateLeaderboard(options = {}) {
  const code = options.code || DEFAULT_CODE;
  const period = options.period || "month";
  const limit = Math.min(Number(options.limit) || 25, 50);

  const [campaign, users] = await Promise.all([
    getCampaign(code),
    fetchReferredUsers(code, "commissionDesc"),
  ]);

  recordSnapshot(users, code);

  const leaderboard =
    period === "lifetime"
      ? buildLifetimeLeaderboard(users, code)
      : period === "30days"
        ? buildLast30DaysLeaderboard(users, code)
        : buildMonthlyLeaderboard(users, code);

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      code: campaign.code,
      referCount: campaign.referCount,
      commissionRate: campaign.comission,
      totalDeposits: campaign.depositCount,
    },
    ...leaderboard,
    entries: leaderboard.entries.slice(0, limit),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  DEFAULT_CODE,
  getCampaign,
  fetchReferredUsers,
  getAffiliateLeaderboard,
  recordSnapshot,
  loadSnapshots,
};
