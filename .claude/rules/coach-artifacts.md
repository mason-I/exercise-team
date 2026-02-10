---
paths:
  - "data/coach/**"
---

# Coach Artifacts (Canonical)

All coaching decisions are model-driven. The `data/coach/` directory is the source of truth.

## Required files
- `data/coach/strava_snapshot.json`
- `data/coach/week_context.json` (week-to-date grounding: expected-by-now, ahead/behind)
- `data/coach/profile.json`
- `data/coach/goals.json`
- `data/coach/baseline_raw.json` (deterministic aggregates)
- `data/coach/baseline.json` (model-interpreted baseline)
- `data/coach/strategy.json`
- `data/coach/progression_state.json`
- `data/coach/training_load.json` (physiological model: TSS, CTL/ATL/TSB, thresholds, injury risk)
- `data/coach/macrocycle.json` (periodization phases and targets)
- `data/coach/outcomes.json` (adherence, adaptation signals, recovery patterns)
- `data/coach/plans/YYYY-MM-DD.json`
- `data/coach/checkins/YYYY-MM-DD.json` (optional)
- `data/coach/reports/*`

## Baseline Raw schema (`baseline_raw.json` -- deterministic output)
```json
{
  "as_of_date": "YYYY-MM-DD",
  "confidence_by_discipline": { "run": "low|medium|high", "bike": "...", "swim": "..." },
  "current_load_tolerance": { "weekly_hours_range": [0, 0], "notes": "" },
  "risk_flags": [],
  "discipline_baselines": {},
  "recent_weekly_totals": [],
  "derived_time_budget": { "min": 0, "typical": 0, "max": 0, "source": "baseline_auto", "notes": "" },
  "evidence": []
}
```

## Baseline schema (`baseline.json` -- model-interpreted, includes all raw fields plus)
```json
{
  "risk_assessment": "Contextual risk narrative grounded in raw risk_flags + recent activity",
  "confidence_rationale": { "run": "explanation...", "bike": "explanation...", "swim": "explanation..." },
  "load_narrative": "Human-readable training load trajectory description",
  "time_budget_rationale": "What the derived time budget means in context"
}
```

## Profile schema (minimum required fields)
```json
{
  "athlete": {},
  "preferences": {
    "time_budget_hours": {},
    "rest_day": "",
    "fixed_sessions": [],
    "session_type_preferences": {
      "run": { "prefer": [], "avoid": [], "notes": "" },
      "bike": { "prefer": [], "avoid": [], "notes": "" },
      "swim": { "prefer": [], "avoid": [], "notes": "" },
      "strength": { "prefer": [], "avoid": [], "notes": "" },
      "notes": ""
    },
    "strength": {
      "enabled": true,
      "sessions_per_week": 2,
      "session_duration_min": 35,
      "focus": "",
      "equipment": [],
      "notes": ""
    },
    "bike_capabilities": {
      "power_meter_available": true,
      "heart_rate_sensor_available": true,
      "resolved": {
        "no_power_mode": false,
        "hr_available": true,
        "source": {},
        "evaluated_at": "YYYY-MM-DD"
      }
    }
  },
  "health": {}
}
```

## Goals schema (minimum required fields)
```json
{
  "primary_goal": {},
  "goals": []
}
```

## Training Load schema (`training_load.json` -- deterministic output)
```json
{
  "as_of_date": "YYYY-MM-DD",
  "thresholds": {
    "bike_ftp_watts": 280,
    "bike_ftp_source": "strava_athlete_profile|athlete_confirmed|unavailable",
    "run_threshold_pace_sec_per_km": 310,
    "run_threshold_source": "estimated_from_best_recent_effort|athlete_confirmed|unavailable",
    "swim_css_sec_per_100m": 105,
    "swim_css_source": "estimated_from_recent_swims|athlete_confirmed|unavailable"
  },
  "daily_tss": [
    { "date": "YYYY-MM-DD", "tss": 65, "discipline": "bike", "activity_id": "123" }
  ],
  "ctl": 62.5,
  "atl": 78.3,
  "tsb": -15.8,
  "ctl_history": [
    { "date": "YYYY-MM-DD", "ctl": 61.2, "atl": 72.1, "tsb": -10.9 }
  ],
  "ramp_rate": 4.2,
  "acute_chronic_ratio": 1.25,
  "injury_risk": "low|moderate|high|critical",
  "zone_update_signals": []
}
```

### Key metrics
- **CTL** (Chronic Training Load): 42-day EMA of daily TSS. Represents fitness.
- **ATL** (Acute Training Load): 7-day EMA of daily TSS. Represents fatigue.
- **TSB** (Training Stress Balance): CTL - ATL. Negative = fatigued, positive = fresh.
- **Ramp rate**: CTL change over 7 days. Safe range 3-7 TSS/week during build.
- **Acute:chronic ratio**: ATL/CTL. >1.3 = caution, >1.5 = danger.
- **Injury risk**: Derived from acute:chronic ratio. `low` (<1.2), `moderate` (1.2-1.3), `high` (1.3-1.5), `critical` (>1.5).

## Macrocycle schema (`macrocycle.json` -- model-generated)
```json
{
  "goal_event": { "name": "", "date": "YYYY-MM-DD", "disciplines": [] },
  "created_at": "YYYY-MM-DD",
  "total_weeks": 0,
  "phases": [
    {
      "id": "base-1",
      "name": "Base Building",
      "type": "base|build|peak|taper",
      "start_week": "YYYY-MM-DD",
      "end_week": "YYYY-MM-DD",
      "weeks": 6,
      "volume_target_pct": 80,
      "intensity_distribution": { "z1_z2": 80, "z3": 15, "z4_plus": 5 },
      "ctl_entry": 55,
      "ctl_exit_target": 68,
      "ramp_rate_target": 4,
      "discipline_emphasis": { "bike": "volume", "run": "consistency", "swim": "technique" },
      "transition_criteria": [],
      "deload_pattern": "3:1"
    }
  ],
  "current_phase_id": "",
  "phase_history": []
}
```

### Phase types
- **base**: Aerobic foundation, volume emphasis, z1/z2 heavy, conservative ramp rate.
- **build**: Race-specific fitness, increased intensity, moderate ramp rate.
- **peak**: Race-specific sharpening, volume drops 10-20%, key sessions at race intensity.
- **taper**: Volume drops 40-60%, intensity maintained, no new stimuli.

### Transition criteria
Phase advancement requires all `transition_criteria` to be met. Check CTL from `training_load.json`, adherence from `outcomes.json`, and injury flags. Transitions are evaluated at the start of `/plan-week`.

## Outcomes schema (`outcomes.json` -- deterministic output)
```json
{
  "as_of_date": "YYYY-MM-DD",
  "session_outcomes": [
    {
      "plan_week": "YYYY-MM-DD",
      "session_id": "",
      "discipline": "run",
      "prescribed": { "type": "", "duration_min": 45, "canonical_type": "", "load_class": "" },
      "actual": { "activity_id": "", "duration_min": 42, "avg_hr": 158, "avg_pace_sec_per_km": 315 },
      "fidelity": { "duration_pct": 93, "intensity_match": "as_prescribed|harder_than_prescribed|easier_than_prescribed|missed", "overall": "completed_as_prescribed|completed_modified|missed" },
      "date": "YYYY-MM-DD"
    }
  ],
  "adherence_summary": {
    "last_4_weeks": {
      "completion_rate": 0.85,
      "by_discipline": { "run": 0.9, "bike": 0.8 },
      "most_skipped_day": "wednesday",
      "most_skipped_type": "swim_technique",
      "most_modified_type": "long_run"
    }
  },
  "adaptation_signals": [
    {
      "discipline": "run",
      "metric": "pace_trend",
      "window_weeks": 6,
      "trend": "improving|declining|stable",
      "magnitude_pct": 3.2,
      "detail": "",
      "implication": ""
    }
  ],
  "recovery_patterns": {
    "run_session_gap": { "typical_days": 2, "sample_size": 8 }
  }
}
```

## Strategy schema (minimum required fields)
```json
{
  "primary_goal": { "name": "", "date": "YYYY-MM-DD", "disciplines": [] },
  "phase_intent": "",
  "macrocycle_id": "current_phase_id from macrocycle.json",
  "discipline_focus": { "run": "", "bike": "", "swim": "" },
  "weekly_priorities": [],
  "phase_notes": ""
}
```

## Progression state schema (required)
```json
{
  "as_of_date": "YYYY-MM-DD",
  "primary_goal_id": "string",
  "phase_mode": "build|maintain|taper|deload",
  "mesocycle": {
    "cycle_pattern": "4:1",
    "training_weeks_completed": 0,
    "last_deload_week": null,
    "next_deload_due": "YYYY-MM-DD"
  },
  "discipline_state": {
    "run": {
      "current": {},
      "target": {},
      "gap": "string",
      "confidence": "low|medium|high"
    }
  },
  "weekly_change_log": [],
  "next_checkpoint": {
    "date": "YYYY-MM-DD",
    "target_markers": []
  },
  "risk_adjustments_pending_user_confirmation": []
}
```

### Mesocycle fields
- `cycle_pattern`: Training-to-deload week ratio (default `"4:1"` = 4 training weeks then 1 deload week).
- `training_weeks_completed`: Count of consecutive training weeks since last deload (0-4). When this reaches the training count from `cycle_pattern`, the next planned week must be a deload.
- `last_deload_week`: ISO date (`YYYY-MM-DD`) of the most recent deload week's `week_start`, or `null` if no deload has occurred yet.
- `next_deload_due`: ISO date of the week_start when the next deload is due, computed from `last_deload_week` + cycle length (or from first plan if no deload yet).

## Plan schema (minimum required fields)
```json
{
  "week_start": "YYYY-MM-DD",
  "time_budget_hours": { "min": 0, "typical": 0, "max": 0 },
  "scheduling_context": {
    "timezone": "",
    "generated_at": "YYYY-MM-DDTHH:MM:SSZ",
    "scheduling_policy": {
      "same_day_shift_first": true,
      "is_race_taper_week": false,
      "weekday_change_budget_ratio": 0.2,
      "time_deviation_caps_min": { "key": 90, "support": 150, "optional": 240 },
      "race_taper_multiplier": 1.5,
      "race_taper_weekday_change_budget_ratio": 0.35,
      "off_habit_weekday_budget": 0,
      "schedulable_session_count": 0
    }
  },
  "scheduling_decisions": {
    "placements": [],
    "adjustments": [],
    "habit_adherence_summary": {
      "matched_weekday_count": 0,
      "matched_time_within_cap_count": 0,
      "off_habit_weekday_count": 0,
      "off_habit_weekday_budget": 0,
      "overall_habit_adherence_score": 0
    }
  },
  "scheduling_risk_flags": [],
  "sessions": [
    {
      "id": "",
      "date": "YYYY-MM-DD",
      "discipline": "run|bike|swim|strength|nutrition|other",
      "type": "easy|tempo|interval|long|short|technique|strength|mobility",
      "canonical_type": "recovery|easy|moderate|tempo|interval|vo2|long|technique|durability|strength|other",
      "duration_min": 0,
      "scheduled_start_local": "YYYY-MM-DDTHH:MM:SS",
      "scheduled_end_local": "YYYY-MM-DDTHH:MM:SS",
      "priority": "key|support|optional",
      "load_class": "recovery|easy|moderate|hard|very_hard",
      "habit_anchor": {
        "level_used": "discipline_weekday_type|discipline_weekday|discipline",
        "target_start_local": "YYYY-MM-DDTHH:MM:SS",
        "confidence": "low|medium|high",
        "weekday_match": true
      },
      "habit_match_score": 0,
      "deviation_minutes": 0,
      "deviation_reason": "",
      "exception_code": null,
      "scheduling_notes": "",
      "progression_trace": {
        "phase_mode": "build|maintain|taper|deload",
        "progression_comparison": "prior_week_reference|none",
        "prior_week_session_id": null,
        "progression_decision": "",
        "progressed_fields": [],
        "load_delta_summary": "",
        "regression_rule": "",
        "goal_link": ""
      },
      "intent": "",
      "success_criteria": [],
      "bike_prescription": {
        "session_objective": "",
        "target_system": "aerobic_endurance|threshold|vo2|neuromuscular|race_specific",
        "blocks": []
      },
      "run_prescription": {
        "session_objective": "",
        "target_system": "aerobic_endurance|threshold|vo2|neuromuscular|race_specific",
        "blocks": [],
        "impact_management": {
          "surface": "",
          "cadence_cue": "",
          "stride_cue": ""
        }
      },
      "swim_prescription": {
        "session_objective": "",
        "target_system": "aerobic_endurance|threshold|vo2|neuromuscular|race_specific",
        "blocks": [],
        "technique_focus": []
      },
      "strength_prescription": {
        "phase_mode": "build|maintain|taper|deload",
        "progression_decision": "",
        "progression_comparison": "prior_week_reference|none",
        "exercises": [
          {
            "exercise_name": "",
            "category": "injury_prevention|overuse_buffer|performance_transfer",
            "injury_target": "none",
            "sport_transfer_target": "",
            "sets": 0,
            "reps": "6-8",
            "tempo": "3-1-1",
            "rest_sec": 90,
            "load": {
              "method": "rpe_rir",
              "target_rpe": 7,
              "target_rir": 3,
              "progression_axis": "load|reps|sets|tempo|density",
              "regression_rule": ""
            }
          }
        ]
      },
      "nutrition_prescription": {
        "pre_session": "",
        "during_session": "",
        "post_session": "",
        "daily_recovery_target": "",
        "session_specific_adjustment": "",
        "compliance_markers": []
      },
      "intensity_prescription": {
        "primary_metric": "power|hr|rpe",
        "power_w_range": [0, 0],
        "if_range": [0, 0],
        "hr_zone_range": ["z2", "z3"],
        "hr_bpm_range": [120, 140],
        "rpe_range": [2, 4],
        "effort_hint": ""
      }
    }
  ]
}
```

For trainable sessions (`run|bike|swim|strength`), `progression_trace` is required and must explicitly state progression intent vs prior week.

Discipline prescription requirements:
- `sessions[].discipline === "bike"` -> `bike_prescription` required.
- `sessions[].discipline === "run"` -> `run_prescription` required.
- `sessions[].discipline === "swim"` -> `swim_prescription` required.
- `sessions[].discipline === "strength"` -> `strength_prescription` required.
- `sessions[].discipline !== "rest"` and `duration_min > 0` -> `nutrition_prescription` required.

`main_set` remains a human-readable summary and is derived from structured prescription fields.

## Legacy fields invalid after cutover
- Inferred artifact keys: `schedule_preferences`, `time_preferences`, `pairing_preferences`.
- Plan/session fallback scheduling without explicit `scheduled_start_local` and `scheduled_end_local`.
- Plans missing `canonical_type`, `habit_anchor`, `habit_match_score`, `deviation_minutes`, `deviation_reason`, or `exception_code`.

## Grounding rule
All numeric claims should be grounded in `data/coach/strava_snapshot.json`. If data is missing, state it explicitly and reduce confidence.
