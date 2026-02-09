---
paths:
  - "data/coach/**"
---

# Coach Artifacts (Canonical)

All coaching decisions are model-driven. The `data/coach/` directory is the source of truth.

## Required files
- `data/coach/strava_snapshot.json`
- `data/coach/profile.json`
- `data/coach/goals.json`
- `data/coach/baseline_raw.json` (deterministic aggregates)
- `data/coach/baseline.json` (model-interpreted baseline)
- `data/coach/strategy.json`
- `data/coach/progression_state.json`
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

## Strategy schema (minimum required fields)
```json
{
  "primary_goal": { "name": "", "date": "YYYY-MM-DD", "disciplines": [] },
  "phase_intent": "",
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
