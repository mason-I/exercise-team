const fs = require("fs");
const https = require("https");
const { dumpJson } = require("../../_shared/lib");
const { getAccessToken } = require("./strava_auth");

function requestJson(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      method: "GET",
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data || "{}");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
            return;
          }
          resolve(json);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const token = await getAccessToken();
  if (!token) throw new Error("Missing Strava access token.");
  const zones = await requestJson("https://www.strava.com/api/v3/athlete/zones", token);
  fs.mkdirSync("data/system/strava", { recursive: true });
  dumpJson("data/system/strava/zones.json", zones);
}

if (require.main === module) {
  main();
}
