const { dumpJson, parseDate, saveText, toIsoDate, weekStart } = require("../../_shared/lib");

const PHASE_TEMPLATES = {
  sprint: [
    ["base", 6],
    ["build", 4],
    ["peak", 2],
    ["taper", 1],
  ],
  olympic: [
    ["base", 8],
    ["build", 6],
    ["peak", 2],
    ["taper", 2],
  ],
  half: [
    ["base", 10],
    ["build", 8],
    ["peak", 2],
    ["taper", 2],
  ],
  full: [
    ["base", 12],
    ["build", 8],
    ["peak", 3],
    ["taper", 3],
  ],
};

const RACE_LABELS = {
  sprint: "Sprint",
  olympic: "Olympic",
  half: "Half Ironman",
  full: "Full Ironman",
};

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    throw new Error("Usage: node set_goal.js <event_date> <race_type>");
  }
  const options = {
    eventDate: args[0],
    raceType: args[1],
    output: "calendar.json",
    outputMd: null,
  };
  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--output") options.output = args[i + 1];
    if (arg === "--output-md") options.outputMd = args[i + 1];
  }
  return options;
}

function main() {
  const options = parseArgs();
  const eventDate = parseDate(options.eventDate);
  if (!eventDate) throw new Error("Invalid event_date. Use YYYY-MM-DD.");

  const raceType = options.raceType.toLowerCase();
  if (!PHASE_TEMPLATES[raceType]) {
    throw new Error("race_type must be one of: sprint, olympic, half, full.");
  }

  const phasesTemplate = PHASE_TEMPLATES[raceType];
  const totalWeeks = phasesTemplate.reduce((sum, [, weeks]) => sum + weeks, 0);
  const eventWeekStart = weekStart(eventDate);
  const startDate = new Date(eventWeekStart.getTime());
  startDate.setUTCDate(startDate.getUTCDate() - totalWeeks * 7);

  const phases = [];
  let currentStart = new Date(startDate.getTime());
  for (const [name, weeks] of phasesTemplate) {
    const phaseStart = new Date(currentStart.getTime());
    const phaseEnd = new Date(phaseStart.getTime());
    phaseEnd.setUTCDate(phaseEnd.getUTCDate() + weeks * 7 - 1);
    phases.push({
      name,
      start: toIsoDate(phaseStart),
      end: toIsoDate(phaseEnd),
      weeks,
    });
    currentStart = new Date(phaseEnd.getTime());
    currentStart.setUTCDate(currentStart.getUTCDate() + 1);
  }

  const today = parseDate(toIsoDate(new Date()));
  const warnings = [];
  if (eventDate < today) warnings.push("Event date is in the past.");
  if (startDate > today) warnings.push("Training start date is in the future. Consider a later start if desired.");
  if (startDate < today && eventDate > today) {
    const weeksRemaining = Math.floor(
      (weekStart(eventWeekStart).getTime() - weekStart(today).getTime()) / (7 * 24 * 60 * 60 * 1000)
    );
    if (weeksRemaining < totalWeeks) {
      warnings.push(`Calendar spans ${totalWeeks} weeks but only ${weeksRemaining} weeks remain.`);
    }
  }

  const calendar = {
    generated_at: toIsoDate(today),
    event: {
      date: toIsoDate(eventDate),
      race_type: raceType,
      race_label: RACE_LABELS[raceType],
    },
    planning: {
      start_date: toIsoDate(startDate),
      end_date: toIsoDate(eventDate),
      week_start: "monday",
      total_weeks: totalWeeks,
    },
    phases,
    warnings,
  };

  dumpJson(options.output, calendar);
  if (options.outputMd) {
    const mdLines = [
      "# Race Calendar",
      "",
      `Race: ${calendar.event.race_label} (${calendar.event.race_type})`,
      `Event date: ${calendar.event.date}`,
      `Plan start: ${calendar.planning.start_date}`,
      "",
      "## Phases",
      ...phases.map((phase) => `- ${phase.name[0].toUpperCase() + phase.name.slice(1)}: ${phase.start} to ${phase.end} (${phase.weeks} weeks)`),
    ];
    if (warnings.length) {
      mdLines.push("", "## Warnings", ...warnings.map((warning) => `- ${warning}`));
    }
    saveText(options.outputMd, mdLines.join("\n").trim() + "\n");
  }
}

if (require.main === module) {
  main();
}
