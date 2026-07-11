/**
 * In-canvas debug overlay (SPEC-3.13 §13.5), dev builds only.
 * Keys (handled in main.ts): ` toggle, P pause-sim, . step one tick.
 * Draws: ball velocity vectors, per-lane breach/critical strips, brick HP
 * numbers, rally counter, phase, event log tail (ring buffer 200).
 */

import type { GameEvent } from "../sim/events";
import type { MatchState } from "../sim/state";
import { cellAabb, laneHeight } from "../sim/wall";
import { ARENA_W } from "../sim/geometry";

export class DebugOverlay {
  visible = false;
  paused = false;
  stepOnce = false;
  private readonly eventTail: string[] = [];

  onEvent(e: GameEvent, state: Readonly<MatchState>): void {
    this.eventTail.push(`${state.tick} ${e.type}`);
    if (this.eventTail.length > 200) this.eventTail.shift();
  }

  draw(c: CanvasRenderingContext2D, state: Readonly<MatchState> | null): void {
    if (!this.visible || !state) return;
    const depth = state.config.tuning.wall.brick_depth;

    // Ball velocity vectors (u/s scaled to ~0.15 s of travel).
    c.strokeStyle = "#7fff9e";
    c.lineWidth = 1.5;
    for (const ball of state.balls) {
      c.beginPath();
      c.moveTo(ball.pos.x, ball.pos.y);
      c.lineTo(ball.pos.x + ball.vel.x * 0.15, ball.pos.y + ball.vel.y * 0.15);
      c.stroke();
    }

    // Brick HP numbers + breach strips.
    c.font = "11px ui-monospace, monospace";
    c.textAlign = "center";
    for (const side of ["left", "right"] as const) {
      const wall = state.sides[side].wall;
      const lh = laneHeight(wall);
      wall.layerSlots.forEach((meta, layerIndex) => {
        const row = wall.layers[layerIndex]!;
        for (let lane = 0; lane < wall.laneCount; lane++) {
          const cell = row[lane];
          if (!cell) continue;
          const box = cellAabb(side, meta.slot, lane, wall, depth);
          c.fillStyle = "#ffffff";
          c.fillText(String(cell.hp), (box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2 + 4);
        }
      });
      const stripX = side === "left" ? 92 : ARENA_W - 96;
      for (let lane = 0; lane < wall.laneCount; lane++) {
        c.fillStyle = wall.breachedLanes[lane]
          ? "#ff4040"
          : wall.criticalLanes[lane]
            ? "#ffb020"
            : "#2a4a2a";
        c.fillRect(stripX, lane * lh + 2, 4, lh - 4);
      }
    }

    // Status block + event tail.
    c.textAlign = "left";
    c.fillStyle = "rgba(10,14,22,0.8)";
    c.fillRect(8, 44, 330, 190);
    c.fillStyle = "#9fe8ff";
    c.font = "12px ui-monospace, monospace";
    const lines = [
      `tick ${state.tick}  phase ${state.phase.kind}  freeze ${state.freezeTicks}`,
      `rally ${state.rally.hitCount}  balls ${state.balls.length}  ` +
        `lives L${state.sides.left.lives}/R${state.sides.right.lives}`,
      `breaches L${state.sides.left.wall.breachCount}/R${state.sides.right.wall.breachCount}` +
        `  paused ${this.paused}`,
      "--- events ---",
      ...this.eventTail.slice(-10),
    ];
    lines.forEach((line, i) => c.fillText(line, 14, 60 + i * 12));
  }
}
