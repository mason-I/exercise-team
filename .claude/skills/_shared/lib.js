const fs = require("fs");

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      return new Date(Date.UTC(year, month - 1, day));
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
    }
  }
  return null;
}

function weekStart(date) {
  const utcDay = date.getUTCDay();
  const diff = (utcDay + 6) % 7; // Monday = 0
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  result.setUTCDate(result.getUTCDate() - diff);
  return result;
}

function daterangeWeeks(startDate, endDate) {
  const weeks = [];
  let current = weekStart(startDate);
  const endWeek = weekStart(endDate);
  while (current <= endWeek) {
    weeks.push(new Date(current.getTime()));
    current = new Date(current.getTime());
    current.setUTCDate(current.getUTCDate() + 7);
  }
  return weeks;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function iqr(values) {
  if (!values.length) return [0, 0];
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 4) {
    return [sorted[0], sorted[sorted.length - 1]];
  }
  const q1Index = Math.floor((sorted.length - 1) * 0.25);
  const q3Index = Math.floor((sorted.length - 1) * 0.75);
  return [sorted[q1Index], sorted[q3Index]];
}

function coefficientOfVariation(values) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function loadJson(path) {
  const raw = fs.readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

function dumpJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function saveText(path, content) {
  fs.writeFileSync(path, content);
}

module.exports = {
  toIsoDate,
  parseDate,
  weekStart,
  daterangeWeeks,
  median,
  iqr,
  coefficientOfVariation,
  loadJson,
  dumpJson,
  saveText,
};
