import { describe, expect, it } from 'vitest';
import { clearance } from '../src/sim/clearance';
import { buildFootprint } from '../src/sim/footprint';
import type { Pose } from '../src/sim/geometry';
import { evaluateGoal, rectFromAabb } from '../src/sim/goal';
import { motionCtx, poseClear } from '../src/sim/motion';
import { SCORE_PAR } from '../src/sim/score';
import { MODEL_Y_2025, type VehicleSpec } from '../src/sim/specs';
import { findCollision, type WorldElement } from '../src/sim/world';
import { isConvex, LINE_WIDTH } from '../src/scenarios/common';
import { buildParallel } from '../src/scenarios/parallel';
import { buildParallelOut, C_TRIG } from '../src/scenarios/pullOut';
import { PARALLEL_LENGTH_PRESETS, PARALLEL_LENGTH_RANGE, type Scenario } from '../src/scenarios/types';
import { allSpecs } from './helpers/drive';
import { provePullOut, tyreGap } from './helpers/exits';
import { driveLog, proofTime } from './helpers/pursuit';
import { EXTREMES } from './helpers/specs';

// 평행 출차 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C1·D). 빌더를 직접 import한다 (§A.5).
// 증명 범위 (override 2): 프리셋 8종 × 칸 길이 프리셋. 극단 치수 3종은 출발 자세가 유효한지와 벌린 폭(≤ 1.0 m)만 본다.
// 기대값은 출차 빌더 상수를 쓰지 않고 설계 문구와 주차 빌더(parallel.ts) 결과에서 다시 구한다.

/** 기본 칸 길이 (settings.ts DEFAULT_SETTINGS.parallel): 모델 Y는 여기서 전환 기준(SCORE_PAR.moves) 이하 */
const DEFAULT_L = 6.0;

/** §8.2 예외 목록. 출차는 프리셋 8종을 모두 증명하므로 비어 있어야 한다 (항목을 넣지 않는다). */
const KNOWN_TIGHT: string[] = [];

const xs = (e: WorldElement) => e.poly.map((p) => p.x);

/** 주차 테스트(tests/parallel.test.ts)의 G: 칸 앞뒤 가운데, 방향 0, 차체 왼쪽 면이 차로 쪽 선 바깥 가장자리 0.02 m 안 */
function goalPose(park: Scenario, spec: VehicleSpec): Pose {
  const r = park.goal.rect;
  const mid = (spec.wheelbase + spec.frontOverhang - spec.rearOverhang) / 2;
  return { x: r.cx - mid, y: r.cy + r.halfW - 0.02 - spec.width / 2, heading: 0 };
}

describe('평행 출차: 프리셋 8종, 칸 길이 프리셋 (주차와 같은 배치, 칸에서 출구 구역까지)', () => {
  it('KNOWN_TIGHT는 비어 있다', () => expect(KNOWN_TIGHT).toEqual([]));

  for (const L of PARALLEL_LENGTH_PRESETS) {
    describe(`${L.toFixed(1)} m`, () => {
      const park = buildParallel({ slotLength: L });
      const r = park.goal.rect;
      // 앞차 = 목표 칸 동쪽에서 가장 가까운 주차 차량, 앞범퍼 = 가장 동쪽 꼭짓점
      const front = park.elements
        .filter((e) => e.tag === 'car' && e.bc!.x > r.cx)
        .reduce((a, b) => (a.bc!.x < b.bc!.x ? a : b));
      const frontBumper = Math.max(...xs(front));

      for (const spec of allSpecs()) {
        it(spec.id, () => {
          const sc = buildParallelOut({ slotLength: L }, spec);
          expect(sc.kind).toBe('parallelOut');
          expect(sc.elements.every((e) => isConvex(e.poly))).toBe(true);
          expect(new Set(sc.elements.map((e) => e.id)).size).toBe(sc.elements.length);
          expect(sc.floor.every((f) => isConvex(f.poly))).toBe(true);

          // 배치: 주차 빌더 결과 그대로 (ensureRoom이 아무것도 바꾸지 않음)
          expect(sc.elements).toEqual(park.elements);
          expect([sc.bounds, sc.ceilingHeight, sc.floor, sc.lamps]).toEqual([park.bounds, park.ceilingHeight, park.floor, park.lamps]);

          // 출발 = 주차 해결 가능성 테스트의 G, 주차 목표를 만족
          const G = goalPose(park, spec);
          for (const k of ['x', 'y', 'heading'] as const) expect(sc.start[k]).toBeCloseTo(G[k], 9);
          const ctx = motionCtx(spec, sc.elements);
          expect(evaluateGoal(park.goal, ctx.fp, sc.start).success).toBe(true);
          expect(poseClear(ctx, sc.start, 0).kind).toBe('ok');
          expect(tyreGap(spec, sc.start, sc.elements)).toBeGreaterThanOrEqual(0.03 - 1e-9);
          expect(evaluateGoal(sc.goal, ctx.fp, sc.start).success).toBe(false);

          // 목표: zone 30°, max(다음 칸 시작 4L, 앞차 앞범퍼 + 1 m)부터 max(5, 전장 + 1) m, 차로 전체 폭(차로 쪽 선 바깥 가장자리 ~ 맞은편 벽면)
          const zx = Math.max(4 * L, frontBumper + 1);
          const zone = rectFromAabb(zx, 2.0 + LINE_WIDTH / 2, zx + Math.max(5, spec.length + 1), 7.0, 0);
          expect([sc.goal.kind, sc.goal.maxAngleDeg]).toEqual(['zone', 30]);
          for (const k of ['cx', 'cy', 'angle', 'halfL', 'halfW'] as const) expect(sc.goal.rect[k]).toBeCloseTo(zone[k], 9);

          // 증명: §8.2 평행 탈출(계획 세계, 뒤로 붙인 뒤 왼쪽 전진·오른쪽 후진) → 통로 가운데 선을 따라 출구 구역까지 추종
          const { d, r: end } = provePullOut(sc, spec);
          expect(d, 'parallel exit does not reach the aisle').not.toBeNull();
          expect(end!.end, end!.error).toBe('goal');
          // 계획 세계가 더 보수적이므로 당연하지만, 실제 요소로도 충돌이 없는지 확인한다
          expect(d!.path.every((p) => findCollision(ctx.fp, p, sc.elements) === null)).toBe(true);
          const log = driveLog(d!);
          expect(log.dirChanges).toBeLessThanOrEqual(12);
          if (spec.id === MODEL_Y_2025.id && L === DEFAULT_L) {
            expect(log.dirChanges).toBeLessThanOrEqual(SCORE_PAR.parallelOut.moves);
          }
          // 시간 기준: tGood ≥ 1.5 × 상한 속도로 이 주행에 걸리는 최소 시간 (출구 구역은 움직이는 채로 성공)
          const T = proofTime(log, sc.goal.kind);
          expect(SCORE_PAR.parallelOut.tGood, `T ${T.toFixed(2)} s`).toBeGreaterThanOrEqual(1.5 * T);
        });
      }
    });
  }
});

describe('평행 출차: ensureRoom은 프리셋에서 아무것도 바꾸지 않는다', () => {
  const lengths: number[] = [];
  for (let l = PARALLEL_LENGTH_RANGE.min; l <= PARALLEL_LENGTH_RANGE.max + 1e-9; l += PARALLEL_LENGTH_RANGE.step) lengths.push(+l.toFixed(1));

  it(`칸 길이 ${PARALLEL_LENGTH_RANGE.min}~${PARALLEL_LENGTH_RANGE.max} m 전체 (${PARALLEL_LENGTH_RANGE.step} m 간격): 배치 = 주차, 앞뒤 여유 ≥ C_TRIG + 0.005`, () => {
    expect(C_TRIG).toBe(0.033); // 직각 출차에서 정한 값 (프리셋 최솟값 0.0381 − 0.005, 설계 C1)
    let min = Infinity;
    let where = '';
    for (const L of lengths) {
      const park = buildParallel({ slotLength: L });
      const cx = park.goal.rect.cx;
      for (const spec of allSpecs()) {
        const sc = buildParallelOut({ slotLength: L }, spec);
        expect(sc.elements, `${spec.id} ${L}`).toEqual(park.elements);
        // 쪽마다: 출발 차체·미러 → 칸 가운데 서쪽(뒤)·동쪽(앞)에 통째로 있는 solid
        const fp = buildFootprint(spec);
        for (const side of [park.elements.filter((e) => Math.max(...xs(e)) <= cx), park.elements.filter((e) => Math.min(...xs(e)) >= cx)]) {
          const c = clearance(fp, sc.start, side);
          if (c < min) {
            min = c;
            where = `${spec.id} ${L}`;
          }
        }
      }
    }
    expect(min, `min ${min.toFixed(4)} m (${where})`).toBeGreaterThanOrEqual(C_TRIG + 0.005);
  });
});

describe('평행 출차: 극단 치수 3종은 출발 자세만 (override 2)', () => {
  for (const { name, spec } of EXTREMES) {
    for (const L of PARALLEL_LENGTH_PRESETS) {
      it(`${name} ${L.toFixed(1)} m: 출발이 유효하고 앞뒤로 벌린 폭 ≤ 1.0 m`, () => {
        const sc = buildParallelOut({ slotLength: L }, spec);
        const ctx = motionCtx(spec, sc.elements);
        expect(poseClear(ctx, sc.start, 0).kind).toBe('ok');
        expect(tyreGap(spec, sc.start, sc.elements)).toBeGreaterThanOrEqual(0.03 - 1e-9);
        expect(evaluateGoal(sc.goal, ctx.fp, sc.start).success).toBe(false);
        // 벌린 폭 = 주차 배치와 범위(양 끝벽 바깥면) 차이
        const park = buildParallel({ slotLength: L });
        const back = park.bounds.x0 - sc.bounds.x0;
        const ahead = sc.bounds.x1 - park.bounds.x1;
        expect(Math.min(back, ahead)).toBeGreaterThanOrEqual(0);
        expect(Math.max(back, ahead), `spread back ${back.toFixed(2)} ahead ${ahead.toFixed(2)} m`).toBeLessThanOrEqual(1.0);
      });
    }
  }
});
