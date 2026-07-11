/**
 * RAF loop, accumulator, module wiring, letterbox resize (SPEC-3.1 §1.4,
 * SPEC-3.2 §2.1). main.ts contains no gameplay logic — if a change to game
 * behavior requires editing this file, the change is in the wrong place.
 */

import { AppFsm } from "./app/appFsm";
import { advanceAccumulator, createAccumulator, resetAccumulator } from "./app/loop";
import { loadConfig } from "./config/load";
import { resolveMatchConfig } from "./config/levels";
import type { ConfigRegistry, MatchConfig } from "./config/types";
import { NullController, type InputController } from "./input/controller";
import { DEFAULT_BINDINGS, HumanController, KeyState } from "./input/keyboard";
import { createMatch, stepMatch } from "./sim";
import type { MatchState } from "./sim/state";
import { Renderer, takeSnapshot, type InterpSnapshot } from "./render/renderer";
import { DebugOverlay } from "./debug/overlay";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const bootErrorEl = document.getElementById("boot-error") as HTMLPreElement;

const renderer = new Renderer();
renderer.init(canvas);
const overlay = import.meta.env.DEV ? new DebugOverlay() : null;

function resize(): void {
  renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
}
window.addEventListener("resize", resize);
resize();

let registry: ConfigRegistry | null = null;
let matchConfig: MatchConfig | null = null;
let curr: MatchState | null = null;
let prev: InterpSnapshot | null = null;
let leftCtrl: InputController = new NullController();
let rightCtrl: InputController = new NullController();

const keys = new KeyState();
keys.attach(window);

const accumulator = createAccumulator();
let last = performance.now();
let wasSimState = false;

let tickCount = 0;
let frameCount = 0;
let rateWindowStart = performance.now();
let simHz = 0;
let renderFps = 0;

let selectedLevelId = "dev-flat";

function startMatch(): void {
  if (!registry) return;
  const level = registry.levels[selectedLevelId] ?? Object.values(registry.levels)[0];
  if (!level) return;
  matchConfig = resolveMatchConfig(
    level,
    registry.tuning,
    registry.materials,
    registry.panels,
    "versus",
  );
  // Seed chosen OUTSIDE the sim (§2.4); levels may pin one for reproducibility.
  const seed = level.rules.fixed_seed ?? Date.now() & 0xffffffff;
  curr = createMatch(matchConfig, seed);
  prev = takeSnapshot(curr);
  leftCtrl = new HumanController(keys, DEFAULT_BINDINGS.left);
  rightCtrl = new HumanController(keys, DEFAULT_BINDINGS.right);
}

const fsm = new AppFsm([
  { from: "BOOT", event: "configLoaded", to: "TITLE" },
  { from: "BOOT", event: "configError", to: "BOOT" },
  { from: "TITLE", event: "anyKey", to: "MAIN_MENU" },
  // Phase 1 placeholder for the campaign/loadout chain (A4–A9):
  { from: "MAIN_MENU", event: "selectStory", to: "MATCH", effect: startMatch },
  { from: "MATCH", event: "matchOver", to: "RESULTS" },
  { from: "RESULTS", event: "retry", to: "MATCH", effect: startMatch },
]);

window.addEventListener("keydown", (e) => {
  if (overlay) {
    if (e.code === "Backquote") {
      overlay.visible = !overlay.visible;
      return;
    }
    if (e.code === "KeyP" && fsm.state === "MATCH") {
      overlay.paused = !overlay.paused;
      return;
    }
    if (e.code === "Period" && fsm.state === "MATCH") {
      overlay.stepOnce = true;
      return;
    }
  }
  if (fsm.state === "TITLE") fsm.dispatch("anyKey");
  else if (fsm.state === "MAIN_MENU") {
    const byDigit: Record<string, string> = {
      Digit1: "dev-flat",
      Digit2: "dev-asym",
      Digit3: "dev-slope",
      Digit4: "dev-angular",
      Digit5: "dev-narrowing",
      Digit6: "dev-zigzag",
    };
    if (byDigit[e.code]) selectedLevelId = byDigit[e.code]!;
    fsm.dispatch("selectStory");
  } else if (fsm.state === "RESULTS") fsm.dispatch("retry");
});

function runTick(): void {
  if (!curr) return;
  prev = takeSnapshot(curr);
  const inputs = {
    left: leftCtrl.sample(curr, "left"),
    right: rightCtrl.sample(curr, "right"),
  };
  const events = stepMatch(curr, inputs);
  for (const e of events) {
    renderer.onEvent(e, curr);
    overlay?.onEvent(e, curr);
    if (e.type === "MatchOver") fsm.dispatch("matchOver");
  }
  tickCount += 1;
}

function frame(now: number): void {
  const delta = now - last;
  last = now;

  // RESULTS keeps the final MatchState on screen; sim only runs in MATCH.
  const inSimState = fsm.state === "MATCH";
  if (inSimState && !wasSimState) resetAccumulator(accumulator);
  wasSimState = inSimState;

  let alpha = 0;
  if (inSimState && curr) {
    if (overlay?.paused) {
      if (overlay.stepOnce) {
        overlay.stepOnce = false;
        runTick();
      }
      resetAccumulator(accumulator);
    } else {
      alpha = advanceAccumulator(accumulator, delta, runTick);
    }
  }

  frameCount += 1;
  const windowMs = now - rateWindowStart;
  if (windowMs >= 1000) {
    simHz = (tickCount * 1000) / windowMs;
    renderFps = (frameCount * 1000) / windowMs;
    tickCount = 0;
    frameCount = 0;
    rateWindowStart = now;
  }

  const showMatch = fsm.state === "MATCH" || fsm.state === "RESULTS";
  renderer.renderFrame(prev, showMatch ? curr : null, alpha, showMatch ? "MATCH" : fsm.state, {
    simHz,
    renderFps,
  });
  if (overlay?.visible && showMatch) {
    const ctx = canvas.getContext("2d")!;
    overlay.draw(ctx, curr);
  }
  requestAnimationFrame(frame);
}

loadConfig(import.meta.env.BASE_URL)
  .then((cfg) => {
    registry = cfg;
    fsm.dispatch("configLoaded");
  })
  .catch((err: unknown) => {
    fsm.dispatch("configError");
    bootErrorEl.textContent =
      "BOOT FAILED — config validation report\n\n" +
      (err instanceof Error ? err.message : String(err));
    bootErrorEl.style.display = "block";
    console.error(err);
  });

requestAnimationFrame(frame);
