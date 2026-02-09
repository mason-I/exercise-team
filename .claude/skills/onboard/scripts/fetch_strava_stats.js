const fs = require("fs");
const https = require("https");
const { dumpJson, loadJson } = require("../../_shared/lib");
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

function resolveAthleteId() {
  if (fs.existsSync("data/system/strava/athlete.json")) {
    const athlete = loadJson("data/system/strava/athlete.json");
    if (athlete?.id) return athlete.id;
  }
  return null;
}

async function main() {
  const token = await getAccessToken();
  if (!token) throw new Error("Missing Strava access token.");
  const athleteId = resolveAthleteId();
  if (!athleteId) throw new Error("Missing athlete id; run fetch_strava_athlete.js first.");
  const stats = await requestJson(`https://www.strava.com/api/v3/athletes/${athleteId}/stats`, token);
  fs.mkdirSync("data/system/strava", { recursive: true });
  dumpJson("data/system/strava/stats.json", stats);
}

if (require.main === module) {
  main();
}
