/**
 * Top-level app FSM (SPEC-3.6 §6.1) — table-driven so tests can assert
 * transition coverage. Sim runs only in MATCH. Undeclared (state, event)
 * pairs are ignored (logged in dev).
 *
 * Phase 0 wires the boot path (A1/A2/A3) plus a placeholder MAIN_MENU →
 * MATCH shortcut standing in for the campaign/loadout chain (A4–A9, Phase 6).
 */

export type AppStateKind =
  | "BOOT"
  | "TITLE"
  | "MAIN_MENU"
  | "CAMPAIGN_MAP"
  | "LOADOUT"
  | "VERSUS_SETUP"
  | "MATCH"
  | "PAUSED"
  | "RESULTS"
  | "SETTINGS";

export type AppEventKind =
  | "configLoaded"
  | "configError"
  | "anyKey"
  | "selectStory"
  | "pauseKey"
  | "resume"
  | "matchOver"
  | "retry"
  | "continue";

export interface Transition {
  from: AppStateKind;
  event: AppEventKind;
  to: AppStateKind;
  /** Side effects run after the state changes. */
  effect?: () => void;
}

export class AppFsm {
  private current: AppStateKind = "BOOT";
  private readonly transitions: Transition[];

  constructor(transitions: Transition[]) {
    this.transitions = transitions;
  }

  get state(): AppStateKind {
    return this.current;
  }

  /** Returns true if a transition fired. */
  dispatch(event: AppEventKind): boolean {
    const row = this.transitions.find((t) => t.from === this.current && t.event === event);
    if (!row) {
      if (import.meta.env.DEV) {
        console.debug(`[appFsm] ignored event "${event}" in state "${this.current}"`);
      }
      return false;
    }
    this.current = row.to;
    row.effect?.();
    return true;
  }
}
