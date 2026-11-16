import { describe, expect, it } from 'vitest';
import { polygonDistance, type Pose } from '../src/sim/geometry';
import { evaluateGoal } from '../src/sim/goal';
import { motionCtx, poseClear } from '../src/sim/motion';
import type { WorldElement } from '../src/sim/world';
import { isConvex } from '../src/scenarios/common';
import { CROOK_GAP, withCrooked } from '../src/scenarios/crooked';
import { buildFrontPerpendicular } from '../src/scenarios/frontPerpendicular';
import { buildRearPerpendicular } from '../src/scenarios/rearPerpendicular';
import { PERP_SLOT_PRESETS, PERP_SLOT_RANGE, type PerpOptions, type Scenario, type TargetKind } from '../src/scenarios/types';
import { allSpecs, inRect } from './helpers/drive';
import { changedIds, frontPerpExit, neighbourIds, perpCorridor, rearPerpExit, stopFace } from './helpers/exits';
import { driveLog } from './helpers/pursuit';
import { allCars } from './helpers/specs';

// 옆 차가 비뚤게 선 칸 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C1·D). 빌더를 직접 import한다 (§A.5).
// 증명 범위 (override 2): 프리셋 8종 × 칸 폭 프리셋 × 목표, 후면·전면 직각 주차 모두. 기존 §8.2 탈출 스크립트를 그대로 다시 돈다.
// 기대값은 crooked.ts 상수를 쓰지 않고 설계 값으로 다시 구한다.

const TARGETS: readonly TargetKind[] = ['between', 'pillar'];
/** 설계 C1: 가장 좁은 폭을 최대 0.40 m 좁히되, 미러 바깥 여유를 양쪽 0.20 m 아래로는 줄이지 않는다 */
const CROOK_MAX = 0.4;
const CROOK_ROOM = 0.2;

/** §8.2 예외 목록. 비뚤게 켠 직각 주차도 프리셋 8종을 모두 증명하므로 비어 있어야 한다 (항목을 넣지 않는다). */
const KNOWN_TIGHT: string[] = [];

const minX = (e: WorldElement) => Math.min(...e.poly.map((p) => p.x));
const maxX = (e: WorldElement) => Math.max(...e.poly.map((p) => p.x));
const byId = (sc: Scenario, id: string) => sc.elements.find((e) => e.id === id)!;

/** 서쪽 장애물: between이면 서쪽 이웃 차, pillar면 목표 칸 서쪽 선 위의 북쪽 기둥 (움직이지 않음) */
function westOf(sc: Scenario, opt: PerpOptions): WorldElement {
  const cx = sc.goal.rect.cx;
  if (opt.target === 'between') return byId(sc, neighbourIds(sc.elements, cx, 'between')[0]);
  return sc.elements.find((e) => e.tag === 'pillar' && e.bc!.y > 0 && Math.abs(maxX(e) - (cx - opt.slotWidth / 2)) < 1e-6)!;
}

describe('옆 차 비뚤게: 배치 (프리셋 8종 × 칸 폭 프리셋 × 목표)', () => {
  it('KNOWN_TIGHT는 비어 있다', () => expect(KNOWN_TIGHT).toEqual([]));

  it('꺼져 있으면 주차 빌더 결과를 그대로 돌려준다', () => {
    for (const target of TARGETS) {
      const plain = buildRearPerpendicular({ slotWidth: 2.5, target });
      expect(withCrooked(plain, { slotWidth: 2.5, target }, allSpecs()[0])).toBe(plain);
    }
  });

  for (const slotWidth of PERP_SLOT_PRESETS) {
    for (const target of TARGETS) {
      const opt: PerpOptions = { slotWidth, target, crooked: true };
      for (const spec of allSpecs()) {
        it(`${slotWidth} ${target} ${spec.id}: 가장 좁은 폭 = F_t, 바뀐 요소는 목표 칸 이웃뿐`, () => {
          for (const plain of [buildRearPerpendicular(opt), buildFrontPerpendicular(opt)]) {
            const sc = withCrooked(plain, opt, spec);
            const cx = plain.goal.rect.cx;
            const ids = neighbourIds(plain.elements, cx, target);
            expect(changedIds(plain.elements, sc.elements)).toEqual(ids);
            expect(sc.elements.every((e) => isConvex(e.poly))).toBe(true);
            expect(new Set(sc.elements.map((e) => e.id)).size).toBe(sc.elements.length);
            // 요소 말고는 그대로: 출발·목표(slot 15°)·범위·바닥·조명
            const { elements: _a, ...rest } = sc;
            const { elements: _b, ...plainRest } = plain;
            expect(rest).toEqual(plainRest);
            const ctx = motionCtx(spec, sc.elements);
            expect(poseClear(ctx, sc.start, 0).kind).toBe('ok');
            expect(evaluateGoal(sc.goal, ctx.fp, sc.start).success).toBe(false);

            // F0 = 지금 가장 좁은 폭 (동쪽 이웃의 가장 서쪽 꼭짓점 − 서쪽 장애물의 가장 동쪽 꼭짓점)
            const east = ids[ids.length - 1];
            const F0 = minX(byId(plain, east)) - maxX(westOf(plain, opt));
            const Ft = Math.min(F0, Math.max(spec.widthMirrors + 2 * CROOK_ROOM, F0 - CROOK_MAX));
            const gap = minX(byId(sc, east)) - maxX(westOf(sc, opt));
            expect(gap, `F0 ${F0.toFixed(3)}`).toBeCloseTo(Ft, 9);
          }
        });
      }
    }
  }
});

describe('옆 차 비뚤게: 기존 §8.2 탈출이 그대로 통한다 (프리셋 8종 × 칸 폭 프리셋 × 목표)', () => {
  for (const slotWidth of PERP_SLOT_PRESETS) {
    for (const target of TARGETS) {
      const opt: PerpOptions = { slotWidth, target, crooked: true };
      for (const kind of ['rearPerp', 'frontPerp'] as const) {
        const plain = kind === 'rearPerp' ? buildRearPerpendicular(opt) : buildFrontPerpendicular(opt);
        for (const spec of allSpecs()) {
          it(`${kind} ${slotWidth} ${target} ${spec.id}`, () => {
            const sc = withCrooked(plain, opt, spec);
            const r = sc.goal.rect;
            const face = stopFace(sc.elements, r.cx, r.halfW);
            const ctx = motionCtx(spec, sc.elements);
            const corridor = perpCorridor(sc);
            // G: tests/rearPerpendicular.test.ts·frontPerpendicular.test.ts와 같다 (바퀴가 휠스톱 면 0.03 m 앞)
            const G: Pose =
              kind === 'rearPerp'
                ? { x: r.cx, y: face - 0.03 - spec.tireDiameter / 2, heading: -Math.PI / 2 }
                : { x: r.cx, y: face - 0.03 - spec.wheelbase - spec.tireDiameter / 2, heading: Math.PI / 2 };
            expect(evaluateGoal(sc.goal, ctx.fp, G).success).toBe(true);
            expect(poseClear(ctx, G, 0).kind).toBe('ok');
            const d = kind === 'rearPerp' ? rearPerpExit(ctx, G, corridor) : frontPerpExit(ctx, G, corridor);
            expect(d, 'exit script does not reach the aisle').not.toBeNull();
            expect(inRect(ctx.fp, d!.pose, corridor, 20)).toBe(true);
            expect(driveLog(d!).dirChanges).toBeLessThanOrEqual(12);
          });
        }
      }
    }
  }
});

describe('옆 차 비뚤게: 기운 차가 다른 solid에 새로 닿지 않는다', () => {
  const widths: number[] = [];
  for (let w = PERP_SLOT_RANGE.min; w <= PERP_SLOT_RANGE.max + 1e-9; w += PERP_SLOT_RANGE.step) widths.push(+w.toFixed(2));

  // 좁은 칸에서는 기울기를 줄여 CROOK_GAP을 남긴다. 원래 배치부터 그보다 가까운 쌍(칸 폭 2.10 m between의 차-기둥)은 원래 거리까지
  it(`칸 폭 ${PERP_SLOT_RANGE.min}~${PERP_SLOT_RANGE.max} m 전체 × 목표 × 11대: 거리 ≥ min(CROOK_GAP, 원래 거리)`, () => {
    expect(CROOK_GAP).toBe(0.05);
    for (const slotWidth of widths) {
      for (const target of TARGETS) {
        const opt: PerpOptions = { slotWidth, target, crooked: true };
        const plain = buildRearPerpendicular(opt);
        for (const { name, spec } of allCars()) {
          const sc = withCrooked(plain, opt, spec);
          const moved = changedIds(plain.elements, sc.elements);
          for (const id of moved) {
            for (const o of sc.elements) {
              if (o.kind !== 'solid' || moved.includes(o.id)) continue;
              const before = polygonDistance(byId(plain, id).poly, o.poly);
              const after = polygonDistance(byId(sc, id).poly, o.poly);
              expect(after, `${name} ${slotWidth} ${target}: ${id} ↔ ${o.id}`).toBeGreaterThanOrEqual(Math.min(CROOK_GAP, before) - 1e-9);
            }
          }
        }
      }
    }
  });
});
