const https = require("https");
const { loadStravaConfig, saveStravaConfig, resolveStravaConfigPath } = require("../../_shared/strava_config");
const {
  DEFAULT_AUTH_PORT,
  refreshOrGetAccessToken,
  loadCredentialState,
} = require("../../_shared/strava_auth_flow");

function loadConfigFile() {
  return loadStravaConfig();
}

async function saveConfigFile(config) {
  saveStravaConfig(config);
}

function loadConfigFromSources() {
  const fileConfig = loadConfigFile();
  return {
    clientId: process.env.STRAVA_CLIENT_ID || fileConfig.clientId,
    clientSecret: process.env.STRAVA_CLIENT_SECRET || fileConfig.clientSecret,
    accessToken: process.env.STRAVA_ACCESS_TOKEN || fileConfig.accessToken,
    refreshToken: process.env.STRAVA_REFRESH_TOKEN || fileConfig.refreshToken,
    expiresAt: fileConfig.expiresAt,
  };
}

function requestJson(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      method,
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
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
    if (payload) req.write(payload);
    req.end();
  });
}

async function refreshAccessToken(config) {
  if (!config.clientId || !config.clientSecret || !config.refreshToken) return null;
  const params = new URLSearchParams({
    client_id: String(config.clientId),
    client_secret: String(config.clientSecret),
    refresh_token: String(config.refreshToken),
    grant_type: "refresh_token",
  });
  const response = await requestJson("POST", "https://www.strava.com/oauth/token", Object.fromEntries(params));
  if (!response || !response.access_token) return null;
  const updated = {
    ...config,
    accessToken: response.access_token,
    refreshToken: response.refresh_token || config.refreshToken,
    expiresAt: response.expires_at,
  };
  await saveConfigFile(updated);
  return updated;
}

async function getAccessToken() {
  let config = loadConfigFromSources();
  const now = Math.floor(Date.now() / 1000);
  if (config.accessToken && config.expiresAt && config.expiresAt > now + 60) {
    return config.accessToken;
  }
  const refreshed = await refreshAccessToken(config);
  if (refreshed?.accessToken) return refreshed.accessToken;
  return config.accessToken || null;
}

module.exports = {
  getAccessToken,
};

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    autoOpenBrowser: false,
    port: DEFAULT_AUTH_PORT,
    timeoutMs: 5 * 60 * 1000,
    json: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--auto-open-browser") options.autoOpenBrowser = true;
    if (arg === "--no-auto-open-browser") options.autoOpenBrowser = false;
    if (arg === "--port") options.port = Number(argv[i + 1] || DEFAULT_AUTH_PORT);
    if (arg === "--timeout-ms") options.timeoutMs = Number(argv[i + 1] || options.timeoutMs);
    if (arg === "--json") options.json = true;
    if (arg === "--no-json") options.json = false;
  }

  return options;
}

async function main() {
  const options = parseArgs();
  const result = await refreshOrGetAccessToken(null, {
    allowInteractiveOAuth: true,
    port: options.port,
    timeoutMs: options.timeoutMs,
    autoOpenBrowser: options.autoOpenBrowser,
    logger: (line) => {
      if (line) process.stderr.write(`${line}\n`);
    },
  });

  const latest = loadCredentialState();
  const output = {
    ok: Boolean(result?.accessToken),
    method: result?.method || "unknown",
    has_access_token: Boolean(latest?.accessToken),
    has_refresh_token: Boolean(latest?.refreshToken),
    expires_at: latest?.expiresAt || null,
    config_path: resolveStravaConfigPath(),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `Strava auth complete (method=${output.method}, refresh_token=${output.has_refresh_token ? "yes" : "no"}).\n`
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}
