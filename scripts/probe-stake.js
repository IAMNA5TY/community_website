require("dotenv").config();

const token = process.env.STAKE_ACCESS_TOKEN;

async function gql(query, variables = {}, operationName) {
  const response = await fetch("https://stake.us/_api/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-access-token": token,
      origin: "https://stake.us",
      referer: "https://stake.us/",
    },
    body: JSON.stringify({ query, variables, operationName }),
  });
  return response.json();
}

async function probe(name, query, variables = {}) {
  const result = await gql(query, variables, name);
  const error = result.errors?.[0]?.message;
  if (error) {
    console.log(`${name}: ERR ${error.slice(0, 220)}`);
    return null;
  }
  console.log(`${name}: OK`);
  console.log(JSON.stringify(result.data, null, 2).slice(0, 2500));
  return result.data;
}

async function main() {
  const active = await probe(
    "ActiveRaces",
    `query ActiveRaces {
      activeRaces {
        id
        name
        status
        startTime
        endTime
        currency
        type
      }
    }`
  );

  const raceId = active?.activeRaces?.[0]?.id;
  if (!raceId) return;

  await probe(
    "RaceLeaderboard",
    `query RaceLeaderboard($raceId: String!, $limit: Int) {
      race(raceId: $raceId) {
        id
        name
        status
        currency
        startTime
        endTime
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
    { raceId, limit: 25 }
  );

  await probe(
    "RaceList",
    `query RaceList {
      raceList {
        id
        name
        status
        currency
        startTime
        endTime
        type
      }
    }`
  );

  await probe(
    "UserRace",
    `query UserRace {
      user {
        id
        name
        lastRacePosition
        racePositionList {
          position
          wageredAmount
          finalAmount
          payoutAmount
          race { id name status currency }
        }
      }
    }`
  );

  await probe(
    "UserProfile",
    `query UserProfile {
      user {
        id
        name
        createdAt
        flagProgress { flag progress }
        balances {
          available { amount currency }
        }
      }
    }`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
