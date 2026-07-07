require("dotenv").config();

const token = process.env.STAKE_ACCESS_TOKEN;

async function gql(query, variables = {}) {
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
  return response.json();
}

async function main() {
  const fields = [
    "commission",
    "commissionAmount",
    "commissionTotal",
    "commissionValue",
    "monthlyCommission",
    "totalCommission",
    "edge",
    "edgeAmount",
    "wagered",
    "wageredAmount",
    "totalWagered",
    "monthlyWagered",
    "play",
    "volume",
    "amount",
    "value",
    "profit",
    "rake",
    "houseEdge",
    "referralCommission",
    "affiliateCommission",
  ];

  for (const field of fields) {
    const result = await gql(
      `query {
        user {
          campaignList {
            code
            referredUserList(limit: 3, sort: commissionDesc) {
              name
              ${field}
            }
          }
        }
      }`
    );
    const error = result.errors?.[0]?.message;
    if (!error) {
      console.log(`FIELD ${field}: OK`, JSON.stringify(result.data.user.campaignList[0].referredUserList));
    } else {
      console.log(`FIELD ${field}: ERR ${error.slice(0, 100)}`);
    }
  }

  const full = await gql(
    `query {
      user {
        campaignList {
          code
          referCount
          comission
          depositCount
          referredUserList(limit: 10, sort: commissionDesc) {
            name
            userId
            depositCount
            commission
            lastDepositAt
            createdAt
          }
        }
      }
    }`
  );
  console.log("\nFull commission query:");
  console.log(JSON.stringify(full, null, 2).slice(0, 3000));
}

main().catch(console.error);
