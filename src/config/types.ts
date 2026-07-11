/**
 * Config TS types (SPEC-3.7). Keys are the canonical registry snake_case ids
 * verbatim (DEC-P2-6). Duration fields are authored in ms in the JSON and
 * converted to ticks at load (§0.6.1) — every field marked `ticks` below
 * holds the converted value in memory.
 */

export const SIM_HZ = 120;
export const DT_MS = 1000 / SIM_HZ;

export interface TuningTable {
  schema_version: number;
  physics: {
    ball_radius: number;
    ball_base_speed: number;
    ball_min_vx_frac: number;
    max_bounce_angle: number;
    sweet_spot_bonus_angle: number;
    steering_angle_cap: number;
    english_factor: number;
    ball_max_speed_mult: number;
    ball_min_speed_mult: number;
    max_balls: number;
    max_bounces_per_tick: number;
    skin_eps: number;
    backface_mode: "reflect" | "reflect+boost";
    backface_speed_scale_base: number;
    slope_accel: number;
  };
  rally: {
    rally_cap_hits: number;
    speed_curve: number[];
    powerup_threshold_minor: number;
    powerup_threshold_medium: number;
    powerup_threshold_major: number;
    overheat_period: number;
    rally_counter_scope: "global" | "per_ball";
  };
  wall: {
    brick_depth: number;
    default_lane_count: number;
    lane_critical_hp: number;
    placement_window: number; // ticks
    placement_timescale: number;
    placement_cooldown: number; // ticks
    placement_cancel_cooldown: number; // ticks
    pending_timeout: number; // ticks
  };
  rules: {
    intro_duration: number; // ticks
    serve_delay: number; // ticks
    serve_angle_max: number;
    life_lost_seq: number; // ticks
    lives_start: number;
    life_loss_per_exchange: 1 | "per_ball";
    overtime_enabled: boolean;
    overtime_start: number; // ticks
    overtime_tick_period: number; // ticks
    stall_soft_timeout: number; // ticks
    stall_nudge_accel: number;
    stall_hard_timeout: number; // ticks
  };
  paddle: {
    paddle_half_height: number;
    paddle_speed: number;
    paddle_width: number;
    paddle_plane_x_left: number;
    paddle_plane_x_right: number;
    slot_count: number;
    max_slots: number;
  };
  powerups: {
    pu_shield_cap: number;
    pu_sticky_hold_max: number; // ticks
  };
  loadout: {
    wall_budget: number;
    anchor_cost_coeff: number;
    reinforce_cost_coeff: number;
    formations: {
      formation_cost_even: number;
      formation_cost_bulwark: number;
      formation_cost_picket: number;
      formation_cost_gate: number;
    };
  };
  ai: {
    ai_predict_max_ticks: number;
    ai_spray_range: number;
    ai_focus_w_hp: number;
    ai_focus_w_adj: number;
    ai_focus_w_persist: number;
    ai_focus_w_infeas: number;
    ai_focus_switch_delta: number;
    ai_denial_candidates: number[];
    ai_place_plug_base: number;
    ai_place_plug_width_w: number;
    ai_place_inbound_bonus: number;
    ai_place_reinforce_base: number;
    ai_place_fortify_base: number;
    ai_place_extra_layer_base: number;
    ai_place_extra_layer_breach_w: number;
    ai_place_floor_defensive: number;
    ai_place_floor_fortify: number;
    ai_place_fallback_score: number;
    ai_spend_before_waste_frac: number;
    ai_panic_react_floor_ms: number;
    ai_panic_arrival_s: number;
    rubber_band_enabled: boolean;
    rubber_band_gain: number;
    rubber_band_clamp: number[];
  };
  audio: {
    music_layer_thresholds: number[];
    sfx_pitch_jitter: number;
    sfx_voice_cap: number;
    duck_hitstop_db: number;
    duck_release_ms: number;
  };
  juice: {
    hit_stop_brick_destroy: number; // ticks (authored as ticks, not ms)
    hit_stop_breach: number;
    hit_stop_life: number;
    damage_state_thresholds: number[];
  };
  render: {
    arena_logical_w: number;
    arena_logical_h: number;
    particle_cap: number;
    trail_len: number;
  };
  perf: {
    sim_budget_ms_frame: number;
    render_budget_ms_frame: number;
  };
}

/** Brick material definition (§7.2). */
export interface MaterialDef {
  hp: number;
  display_name: string;
  tier: number;
}

/**
 * Boot-time registry (SPEC-3.1 §1.3). Grows as config file families land:
 * levels (Phase 2), opponents (Phase 4), powerups (Phase 5), …
 */
export interface ConfigRegistry {
  tuning: TuningTable;
  materials: Record<string, MaterialDef>;
}

/** Per-side wall definition, resolved (layers[0] = frontmost, entries = material ids). */
export interface ResolvedWallDef {
  layers: string[][];
}

/**
 * Resolved in-memory product of level + loadout + archetype (§7.7).
 * Phase 1: walls/rules are assembled in code (level JSON lands in Phase 2).
 */
export interface MatchConfig {
  tuning: TuningTable;
  materials: Record<string, MaterialDef>;
  laneCount: number;
  walls: { left: ResolvedWallDef; right: ResolvedWallDef };
  rules: {
    lives: { left: number; right: number };
    rebuild_on_life_lost: "none" | "full" | "breach_fill";
    rebuild_material: string;
    life_loss_per_exchange: 1 | "per_ball";
    overtime_enabled: boolean;
    overtime_start: number | null; // ticks; null = tuning default
    /** R-2.1 first-serve target (serve_first_target_story/_versus, GR2-16). */
    first_receiver: "left" | "right" | "random";
  };
}
