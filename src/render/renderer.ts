/**
 * Renderer (SPEC-3.10) — Phase 1 "ugly rectangles with information":
 * bricks with damage states, breach-darkened lanes, paddles, interpolated
 * balls, serve telegraph, minimal HUD. The full layer stack, atlas, and
 * dirty rects land in Phase 7/8.
 */

import type { GameEvent } from "../sim/events";
import type { MatchState, Side } from "../sim/state";
import type { AppStateKind } from "../app/appFsm";
import type { TuningTable } from "../config/types";
import { cellAabb, laneHeight } from "../sim/wall";
import { ARENA_H, ARENA_W } from "../sim/geometry";

export const LOGICAL_W = ARENA_W;
export const LOGICAL_H = ARENA_H;

/** Shallow snapshot of interpolated quantities only (§2.6). */
export interface InterpSnapshot {
  balls: { id: number; x: number; y: number }[];
  paddleY: { left: number[]; right: number[] };
}

export function takeSnapshot(state: Readonly<MatchState>): InterpSnapshot {
  return {
    balls: state.balls.map((b) => ({ id: b.id, x: b.pos.x, y: b.pos.y })),
    paddleY: {
      left: state.sides.left.paddles.map((p) => p.yCenter),
      right: state.sides.right.paddles.map((p) => p.yCenter),
    },
  };
}

const MATERIAL_COLORS: Record<string, string> = {
  hay: "#c9a94e",
  brick: "#bf5b3f",
  metal: "#8d9aab",
  obsidian: "#5d4a78",
};

const PLAYER_ACCENT: Record<Side, string> = { left: "#39d3e6", right: "#e356c8" };

export interface DebugReadout {
  simHz: number;
  renderFps: number;
}

export class Renderer {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private scale = 1;
  private eventsSeen = 0;

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const fit = Math.min(cssWidth / LOGICAL_W, cssHeight / LOGICAL_H);
    const cssW = Math.floor(LOGICAL_W * fit);
    const cssH = Math.floor(LOGICAL_H * fit);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.scale = (cssW * dpr) / LOGICAL_W;
  }

  onEvent(_e: GameEvent, _state: Readonly<MatchState>): void {
    this.eventsSeen += 1;
  }

  renderFrame(
    prev: InterpSnapshot | null,
    curr: Readonly<MatchState> | null,
    alpha: number,
    appState: AppStateKind,
    debug: DebugReadout,
  ): void {
    const c = this.ctx;
    c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    c.fillStyle = "#101522";
    c.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    if (appState !== "MATCH" || !curr) {
      this.drawMenus(appState);
      return;
    }

    this.drawWalls(curr);
    this.drawCenterLine();
    this.drawPaddles(curr, prev, alpha);
    this.drawBalls(curr, prev, alpha);
    this.drawTelegraph(curr);
    this.drawHud(curr);
    if (import.meta.env.DEV) {
      c.textAlign = "left";
      c.font = "13px ui-monospace, monospace";
      c.fillStyle = "#5f7bbf";
      c.fillText(
        `sim ${debug.simHz.toFixed(1)} Hz | render ${debug.renderFps.toFixed(1)} fps | events ${this.eventsSeen}`,
        12,
        LOGICAL_H - 10,
      );
    }
  }

  private drawMenus(appState: AppStateKind): void {
    const c = this.ctx;
    c.fillStyle = "#8fa3d9";
    c.textAlign = "center";
    if (appState === "TITLE") {
      c.font = "48px ui-monospace, monospace";
      c.fillText("BRICK BREAKER PONG", LOGICAL_W / 2, 300);
      c.font = "20px ui-monospace, monospace";
      c.fillText("press any key", LOGICAL_W / 2, 360);
    } else if (appState === "MAIN_MENU") {
      c.font = "26px ui-monospace, monospace";
      c.fillText("1: Dev Court   2: Uneven Ground", LOGICAL_W / 2, 320);
      c.font = "20px ui-monospace, monospace";
      c.fillText("any key starts — 2P: left W/S, right ↑/↓", LOGICAL_W / 2, 366);
    }
  }

  private drawCenterLine(): void {
    const c = this.ctx;
    c.strokeStyle = "#2a3350";
    c.lineWidth = 2;
    c.setLineDash([12, 14]);
    c.beginPath();
    c.moveTo(LOGICAL_W / 2, 0);
    c.lineTo(LOGICAL_W / 2, LOGICAL_H);
    c.stroke();
    c.setLineDash([]);
  }

  private drawWalls(state: Readonly<MatchState>): void {
    const c = this.ctx;
    const tuning: TuningTable = state.config.tuning;
    const depth = tuning.wall.brick_depth;
    const [crackAt, crumbleAt] = tuning.juice.damage_state_thresholds as [number, number];
    for (const side of ["left", "right"] as const) {
      const wall = state.sides[side].wall;
      const lh = laneHeight(wall);
      // Breach-darkened lanes across the wall zone (readability, GDD §2).
      for (let lane = 0; lane < wall.laneCount; lane++) {
        if (wall.breachedLanes[lane]) {
          c.fillStyle = "rgba(0,0,0,0.45)";
          const zoneX = side === "left" ? 0 : ARENA_W - 4 * depth;
          c.fillRect(zoneX, lane * lh, 4 * depth, lh);
        } else if (wall.criticalLanes[lane]) {
          c.fillStyle = "rgba(255,80,80,0.15)";
          const zoneX = side === "left" ? 0 : ARENA_W - 4 * depth;
          c.fillRect(zoneX, lane * lh, 4 * depth, lh);
        }
      }
      wall.layerSlots.forEach((meta, layerIndex) => {
        const row = wall.layers[layerIndex]!;
        for (let lane = 0; lane < wall.laneCount; lane++) {
          const cell = row[lane];
          if (!cell) continue;
          const box = cellAabb(side, meta.slot, lane, wall, depth);
          const hpFrac = cell.hp / cell.maxHp;
          const base = MATERIAL_COLORS[cell.material] ?? "#999999";
          c.fillStyle = base;
          c.globalAlpha = hpFrac > crackAt ? 1 : hpFrac > crumbleAt ? 0.75 : 0.5;
          c.fillRect(box.min.x + 1, box.min.y + 1, box.max.x - box.min.x - 2, box.max.y - box.min.y - 2);
          c.globalAlpha = 1;
          if (hpFrac <= crackAt) {
            // crude crack marks
            c.strokeStyle = "rgba(0,0,0,0.55)";
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(box.min.x + 3, box.min.y + 4);
            c.lineTo(box.max.x - 4, box.max.y - 5);
            if (hpFrac <= crumbleAt) {
              c.moveTo(box.max.x - 4, box.min.y + 5);
              c.lineTo(box.min.x + 4, box.max.y - 4);
            }
            c.stroke();
          }
        }
      });
    }
  }

  private drawPaddles(
    state: Readonly<MatchState>,
    prev: InterpSnapshot | null,
    alpha: number,
  ): void {
    const c = this.ctx;
    const w = state.config.tuning.paddle.paddle_width;
    for (const side of ["left", "right"] as const) {
      c.fillStyle = PLAYER_ACCENT[side];
      state.sides[side].paddles.forEach((p, i) => {
        const prevY = prev?.paddleY[side][i] ?? p.yCenter;
        const y = prevY + (p.yCenter - prevY) * alpha;
        const minX = side === "left" ? p.x - w : p.x;
        c.fillRect(minX, y - p.halfHeight, w, p.halfHeight * 2);
      });
    }
  }

  private drawBalls(
    state: Readonly<MatchState>,
    prev: InterpSnapshot | null,
    alpha: number,
  ): void {
    const c = this.ctx;
    c.fillStyle = "#f4f6ff";
    for (const ball of state.balls) {
      const prevBall = ball.justTeleported
        ? null
        : prev?.balls.find((b) => b.id === ball.id);
      const x = prevBall ? prevBall.x + (ball.pos.x - prevBall.x) * alpha : ball.pos.x;
      const y = prevBall ? prevBall.y + (ball.pos.y - prevBall.y) * alpha : ball.pos.y;
      c.beginPath();
      c.arc(x, y, ball.radius, 0, Math.PI * 2);
      c.fill();
    }
  }

  private drawTelegraph(state: Readonly<MatchState>): void {
    if (state.phase.kind !== "serving") return;
    const c = this.ctx;
    const frac = state.phase.ticksLeft / state.config.tuning.rules.serve_delay;
    const cx = LOGICAL_W / 2;
    const cy = LOGICAL_H / 2;
    const r = state.config.tuning.physics.ball_radius;
    c.strokeStyle = "#f4f6ff";
    c.globalAlpha = 0.4 + 0.6 * (1 - frac);
    c.lineWidth = 2;
    c.beginPath();
    c.arc(cx, cy, r + 6 * frac, 0, Math.PI * 2);
    c.stroke();
    // Direction arrow toward the receiver.
    const dir = state.phase.receiver === "left" ? -1 : 1;
    c.beginPath();
    c.moveTo(cx + dir * 18, cy);
    c.lineTo(cx + dir * 40, cy);
    c.lineTo(cx + dir * 32, cy - 6);
    c.moveTo(cx + dir * 40, cy);
    c.lineTo(cx + dir * 32, cy + 6);
    c.stroke();
    c.globalAlpha = 1;
  }

  private drawHud(state: Readonly<MatchState>): void {
    const c = this.ctx;
    c.font = "22px ui-monospace, monospace";
    for (const side of ["left", "right"] as const) {
      c.fillStyle = PLAYER_ACCENT[side];
      c.textAlign = side === "left" ? "left" : "right";
      const x = side === "left" ? 110 : LOGICAL_W - 110;
      c.fillText("♥".repeat(Math.max(0, state.sides[side].lives)), x, 34);
    }
    c.textAlign = "center";
    c.fillStyle = "#8fa3d9";
    c.fillText(`${state.rally.hitCount}`, LOGICAL_W / 2, 34);
    if (state.phase.kind === "matchOver") {
      c.font = "44px ui-monospace, monospace";
      c.fillStyle = PLAYER_ACCENT[state.phase.winner];
      c.fillText(`${state.phase.winner.toUpperCase()} WINS`, LOGICAL_W / 2, 320);
      c.font = "18px ui-monospace, monospace";
      c.fillStyle = "#8fa3d9";
      c.fillText("press any key for a rematch", LOGICAL_W / 2, 360);
    }
  }
}
