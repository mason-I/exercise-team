# PRD.md

## Individual AI-Powered Triathlon Coaching System (Claude Code)

---

## 1. Purpose

This product is an **AI-powered, single-athlete triathlon coaching system** built on **Claude Code**.

It generates, updates, and manages personalized triathlon training plans for **one individual**, using:

* deterministic analysis of historical training data (via Strava MCP)
* explicit baseline computation
* backward planning from a target race date
* specialist coaching agents (run, bike, swim, nutrition)

The system prioritizes **correctness, auditability, and training realism** over convenience or abstraction.

This is **not a platform**, **not multi-user**, and **not a generic fitness app**.

---

## 2. Scope

### In Scope

* One athlete
* One active training timeline
* One target race at a time
* Weekly swim, bike, run, nutrition planning
* Strava-based baseline computation
* Plan adjustment based on adherence
* File-based, versioned training artifacts

### Explicitly Out of Scope

* Multiple users or athletes
* Authentication or identity management
* Coach dashboards
* Social or sharing features
* Strength training (for now)

---

## 3. Design Principles

1. **Evidence before prescription**
   No training load is assigned without computing a baseline from historical data.

2. **Deterministic where it matters**
   Baseline metrics and safety checks are algorithmic, not LLM intuition.

3. **Inspectability over abstraction**
   All important outputs exist as readable files under version control.

4. **Recency beats history**
   The system optimizes for current sustainable load, not past peaks.

5. **Fail safe, not aggressive**
   When data is missing or ambiguous, the system defaults to conservative recommendations.

---

## 4. Target User

A single self-coached triathlete who:

* uses Strava
* wants structured, periodized training
* values realism over hype
* is willing to inspect plans and rationale

The user interacts directly with Claude Code as the interface.

---

## 5. High-Level Architecture

### Core Components

* **Head Coach Agent**
  Orchestrates all planning and analysis.

* **Specialist Subagents**

  * Run Coach
  * Bike Coach
  * Swim Coach
  * Nutrition Coach

* **Strava MCP Server**
  Provides historical and ongoing training data.

* **Deterministic Baseline Computation Script**
  Computes numeric baselines from Strava data.

* **File-Based Artifacts**

  * `baseline.json`
  * `calendar.json`
  * weekly plan files
  * adherence reports

Claude Code provides:

* subagent orchestration
* skills (invocable via `/skill-name`)
* hooks for validation
* file access and git integration

---

## 6. Core Concepts

### 6.1 Baseline

A **baseline** is a numeric summary of what the athlete can currently sustain, computed from recent training history.

Baseline answers:

> “What training load is repeatable right now without breaking?”

Baseline is **not**:

* a goal
* a peak
* a lifetime average

---

### 6.2 Planning Phases

* Baseline discovery
* Backward planning from race date
* Weekly plan generation
* Adherence analysis
* Incremental adjustment

Each phase is explicit and inspectable.

---

## 7. Functional Requirements

### 7.1 Baseline Discovery

#### FR-B1: Baseline computation skill

The system shall provide a skill:

```
/compute-baseline --window <days>
```

Default window: **56 days (8 weeks)**.

#### FR-B2: Baseline windows

The system computes:

* Short-term context: 14 days
* Primary baseline: 56 days
* Optional long context: 112 days

Only the 56-day window defines baseline values.

#### FR-B3: Deterministic computation

Baseline metrics must be computed via deterministic algorithms.

Claude:

* fetches Strava data via MCP
* runs the computation
* writes output files

Claude does **not invent** baseline values.

---

### 7.2 Baseline Metrics

Computed separately for **run**, **bike**, and **swim**.

#### Weekly aggregates

* median sessions per week
* median weekly volume

  * run/swim: distance
  * bike: duration
* weekly volume IQR
* weeks with zero sessions

#### Typical session

* median session distance
* median session duration

#### Long session tolerance

* per week: max session
* baseline long session = median of weekly max

---

### 7.3 Swim-Specific Metrics

#### Pace per 100m

For each qualifying swim:

```
pace_sec_per_100m = duration_sec / (distance_m / 100)
```

Filters:

* distance ≥ 200m
* sanity-checked duration

Stored metrics:

* distance-weighted average pace
* median per-swim pace

---

### 7.4 Baseline Confidence

Each discipline includes:

* `confidence: high | medium | low`

Confidence decreases when:

* < 6 sessions in 8 weeks
* > 2 zero-activity weeks
* extreme week-to-week variability

Low confidence triggers conservative planning.

---

### 7.5 Baseline Artifacts

#### Files

* `baseline.json` (canonical)
* `baseline.md` (explanatory)

Baseline is only updated via `/compute-baseline`.

---

## 8. Goal and Calendar Management

### FR-G1: Set race goal

Skill:

```
/set-goal <event_date> <race_type>
```

Writes:

* `calendar.json`

Calendar includes:

* event date
* race distance
* derived phases (base, build, peak, taper)

---

## 9. Weekly Planning

### FR-P1: Build weekly plan

Skill:

```
/build-week <week_start>
```

Inputs:

* `baseline.json`
* `calendar.json`
* `profile.json`

Outputs:

* `plans/YYYY-MM-DD.json`
* `plans/YYYY-MM-DD.md`

Week 1 volume must fall within baseline bounds unless explicitly overridden.

---

### FR-P2: Plan structure

Weekly plans include:

* swim sessions
* bike sessions
* run sessions
* nutrition targets
* notes and flags

---

## 10. Adherence and Adjustment

### FR-A1: Analyze completed training

Skill:

```
/analyze-strava <week_start>
```

Process:

* pull Strava activities for the week
* match planned vs completed sessions
* classify: completed / partial / missed / substituted

Outputs:

* `reports/YYYY-MM-DD-week.md`

---

### FR-A2: Adjustment logic

Missed or overloaded weeks influence **future plans**, not baseline unless recomputed.

Baseline remains stable unless explicitly refreshed.

---

## 11. Skills Summary

| Skill               | Purpose                     |
| ------------------- | --------------------------- |
| `/set-goal`         | Define race date and type   |
| `/compute-baseline` | Compute numeric baseline    |
| `/build-week`       | Generate weekly plan        |
| `/adjust-week`      | Modify plan for constraints |
| `/analyze-strava`   | Planned vs actual analysis  |

---

## 12. Data Model

### Directory Layout

```
/profile.json
/calendar.json
/baseline.json
/plans/
  YYYY-MM-DD.json
  YYYY-MM-DD.md
/reports/
  YYYY-MM-DD-week.md
/templates/
```

Single-user, no IDs.

---

## 13. Validation and Safety

Claude Code hooks enforce:

* schema correctness
* safe progression
* plan coherence

Hard rules include:

* no large week-to-week volume spikes
* long sessions only grow within tolerance
* low-confidence baselines restrict ramp rates

---

## 14. Non-Functional Requirements

### Transparency

All decisions must be explainable via files.

### Reversibility

All edits are diffable and revertible.

### Performance

Strava queries are bounded by date windows.

---

## 15. Risks

* Noisy or missing Strava data
* Baseline skew from irregular training
* Overconfidence in sparse swim data

Mitigations:

* confidence scoring
* conservative defaults
* explicit recomputation triggers

---

## 16. Success Criteria

* Plans feel realistic to the athlete
* Volume ramps are justified and explainable
* Baseline changes only when training reality changes
* System behavior matches how a competent human coach would reason

---

## 17. Summary

This system treats **baseline discovery as a first-class problem**.

Claude Code is used for:

* orchestration
* delegation
* file management
* explanation

But **numbers come from data**, not language.

If this PRD is implemented faithfully, the result is not “AI coaching” in the buzzword sense, but a **credible, disciplined, evidence-driven training partner**.
