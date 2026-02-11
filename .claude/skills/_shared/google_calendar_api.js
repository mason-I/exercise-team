const https = require("https");
const {
  DEFAULT_CALENDAR_ID,
  refreshOrGetAccessToken,
  loadCredentialState,
} = require("./google_calendar_auth_flow");

function encodeCalendarId(calendarId) {
  return encodeURIComponent(calendarId || DEFAULT_CALENDAR_ID);
}

function ensureTrainingSummary(summary) {
  const value = String(summary || "").trim();
  if (!value.startsWith("Training:")) {
    const err = new Error('Calendar writes are restricted to summaries that start with "Training:"');
    err.code = "INVALID_TRAINING_SUMMARY";
    throw err;
  }
  return value;
}

function requestJson(method, url, body = null, accessToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      method,
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        const isJson = String(res.headers["content-type"] || "").includes("application/json");
        const parsedBody = (() => {
          if (!data) return {};
          if (!isJson) return { raw: data };
          try {
            return JSON.parse(data);
          } catch {
            return { raw: data };
          }
        })();

        if (res.statusCode && res.statusCode >= 400) {
          const error = new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsedBody)}`);
          error.statusCode = res.statusCode;
          error.response = parsedBody;
          reject(error);
          return;
        }
        resolve(parsedBody);
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getCalendarAccessToken() {
  const result = await refreshOrGetAccessToken(null, {
    allowInteractiveOAuth: false,
    autoOpenBrowser: false,
  });
  if (!result?.accessToken) {
    const err = new Error("No valid Google Calendar token available. Run /setup to connect Google Calendar.");
    err.code = "AUTH_REQUIRED";
    throw err;
  }
  return result.accessToken;
}

function buildEventsUrl(calendarId, queryParams = {}) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeCalendarId(calendarId)}/events`;
  const url = new URL(base);
  for (const [key, value] of Object.entries(queryParams)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function normalizeDateTime(startOrEnd, fieldName) {
  if (!startOrEnd) {
    throw new Error(`Missing ${fieldName} datetime.`);
  }
  const value = String(startOrEnd).trim();
  if (!value) throw new Error(`Missing ${fieldName} datetime.`);
  return value;
}

function ensureTrainingEvent(event) {
  const summary = String(event?.summary || "").trim();
  if (!summary.startsWith("Training:")) {
    const err = new Error("Attempted to modify a non-Training event. Operation blocked.");
    err.code = "NON_TRAINING_EVENT";
    throw err;
  }
}

function resolveDefaultCalendarId(calendarIdInput = null) {
  if (calendarIdInput) return calendarIdInput;
  const state = loadCredentialState();
  return state.calendarId || DEFAULT_CALENDAR_ID;
}

async function listEvents({ start, end, calendarId = null }) {
  const resolvedCalendarId = resolveDefaultCalendarId(calendarId);
  const accessToken = await getCalendarAccessToken();
  const url = buildEventsUrl(resolvedCalendarId, {
    timeMin: normalizeDateTime(start, "start"),
    timeMax: normalizeDateTime(end, "end"),
    singleEvents: true,
    orderBy: "startTime",
    showDeleted: false,
  });

  const response = await requestJson("GET", url, null, accessToken);
  return {
    calendarId: resolvedCalendarId,
    items: Array.isArray(response?.items) ? response.items : [],
  };
}

async function getEvent({ eventId, calendarId = null }) {
  const resolvedCalendarId = resolveDefaultCalendarId(calendarId);
  const accessToken = await getCalendarAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeCalendarId(
    resolvedCalendarId
  )}/events/${encodeURIComponent(eventId)}`;
  const event = await requestJson("GET", url, null, accessToken);
  return { calendarId: resolvedCalendarId, event };
}

async function createTrainingEvent({
  start,
  end,
  summary,
  description,
  calendarId = null,
  timeZone,
}) {
  const resolvedCalendarId = resolveDefaultCalendarId(calendarId);
  const accessToken = await getCalendarAccessToken();
  const safeSummary = ensureTrainingSummary(summary);

  const body = {
    summary: safeSummary,
    description: String(description || "").trim(),
    start: {
      dateTime: normalizeDateTime(start, "start"),
      ...(timeZone ? { timeZone: String(timeZone) } : {}),
    },
    end: {
      dateTime: normalizeDateTime(end, "end"),
      ...(timeZone ? { timeZone: String(timeZone) } : {}),
    },
  };

  const url = buildEventsUrl(resolvedCalendarId);
  const event = await requestJson("POST", url, body, accessToken);
  return { calendarId: resolvedCalendarId, event };
}

async function updateTrainingEvent({
  eventId,
  start,
  end,
  summary,
  description,
  calendarId = null,
  timeZone,
}) {
  const resolvedCalendarId = resolveDefaultCalendarId(calendarId);
  const accessToken = await getCalendarAccessToken();
  const safeSummary = ensureTrainingSummary(summary);

  const { event: existing } = await getEvent({ eventId, calendarId: resolvedCalendarId });
  ensureTrainingEvent(existing);

  const body = {
    summary: safeSummary,
    description: String(description || "").trim(),
    start: {
      dateTime: normalizeDateTime(start, "start"),
      ...(timeZone ? { timeZone: String(timeZone) } : {}),
    },
    end: {
      dateTime: normalizeDateTime(end, "end"),
      ...(timeZone ? { timeZone: String(timeZone) } : {}),
    },
  };

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeCalendarId(
    resolvedCalendarId
  )}/events/${encodeURIComponent(eventId)}`;
  const event = await requestJson("PATCH", url, body, accessToken);
  return { calendarId: resolvedCalendarId, event };
}

async function cancelTrainingEvent({ eventId, reason, calendarId = null }) {
  const resolvedCalendarId = resolveDefaultCalendarId(calendarId);
  const accessToken = await getCalendarAccessToken();
  const { event: existing } = await getEvent({ eventId, calendarId: resolvedCalendarId });
  ensureTrainingEvent(existing);

  const oldSummary = String(existing.summary || "Training: Session").trim();
  const canceledSummary = oldSummary.startsWith("Training: [Canceled]")
    ? oldSummary
    : oldSummary.replace(/^Training:\s*/i, "Training: [Canceled] ");

  const stamp = new Date().toISOString();
  const reasonLine = reason ? `Cancellation reason: ${String(reason).trim()}` : "Cancellation reason: plan update";
  const description = [String(existing.description || "").trim(), "", `Canceled at: ${stamp}`, reasonLine]
    .filter(Boolean)
    .join("\n");

  const body = {
    summary: canceledSummary,
    description,
  };

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeCalendarId(
    resolvedCalendarId
  )}/events/${encodeURIComponent(eventId)}`;
  const event = await requestJson("PATCH", url, body, accessToken);
  return { calendarId: resolvedCalendarId, event };
}

async function deleteTrainingEvent({ eventId, calendarId = null }) {
  const resolvedCalendarId = resolveDefaultCalendarId(calendarId);
  const accessToken = await getCalendarAccessToken();
  const { event: existing } = await getEvent({ eventId, calendarId: resolvedCalendarId });
  ensureTrainingEvent(existing);

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeCalendarId(
    resolvedCalendarId
  )}/events/${encodeURIComponent(eventId)}`;
  await requestJson("DELETE", url, null, accessToken);
  return { calendarId: resolvedCalendarId, eventId: String(eventId) };
}

module.exports = {
  ensureTrainingSummary,
  ensureTrainingEvent,
  listEvents,
  getEvent,
  createTrainingEvent,
  updateTrainingEvent,
  cancelTrainingEvent,
  deleteTrainingEvent,
};
