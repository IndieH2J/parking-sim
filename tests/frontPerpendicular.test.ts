import { describe, expect, it } from 'vitest';
import { buildFootprint } from '../src/sim/footprint';
import type { Pose } from '../src/sim/geometry';
import { evaluateGoal, rectFromAabb, wrapPi, type ORect } from '../src/sim/goal';
import { motionCtx, poseClear, type MotionCtx } from '../src/sim/motion';
import { MODEL_Y_2025 } from '../src/sim/specs';
import { isConvex } from '../src/scenarios/common';
import { buildFrontPerpendicular } from '../src/scenarios/frontPerpendicular';
import { AISLE, buildGarage, buildRearPerpendicular } from '../src/scenarios/rearPerpendicular';
import { PERP_SLOT_PRESETS, type Scenario, type TargetKind } from '../src/scenarios/types';
import { allSpecs, dirChanges, inRect, move, moveUntilBlocked, setSteer, startDrive, type Drive } from './helpers/drive';

// 전면 직각 주차 (계약서 §1.8.2)와 해결 가능성 (§8.2).
// 해결 가능성: 목표 자세 G에서 후진으로 빠져나와 통로에 출발 방향(동쪽)으로 선다.
// 이 경로를 거꾸로 돌리면 통로에서 앞으로 넣는 경로다 (tests/helpers/drive.ts 머리말).

const TARGETS: readonly TargetKind[] = ['between', 'pillar'];
/** 기대하는 휠스톱 거리. 빌더 상수를 그대로 가져오지 않아 값이 바뀌면 테스트가 잡는다. */
const STOP_FROM_BACK = 0.6;

/** 증명하지 못해 건너뛰는 경우 (§8.2 실패 정책: 사유를 제목에 넣어 it.skip, 결정 로그에 기록). 지금은 없다. */
const KNOWN_TIGHT: { vehicle: string; option: string; reason: string }[] = [];

/** 목표 칸 휠스톱의 통로 쪽 면 (y) */
function stopFace(sc: Scenario): number {
  const r = sc.goal.rect;
  const stops = sc.elements.filter((e) => e.kind === 'wheelStop' && e.bc!.y > 0 && Math.abs(e.bc!.x - r.cx) < r.halfW);
  return Math.min(...stops.flatMap((e) => e.poly.map((p) => p.y)));
}

/**
 * 후진 다점 탈출 한 번 (§8.2 frontPerp 행). heading이 corridor.angle 쪽으로만 돈다.
 * 1) s0 m 곧게 후진  2) 조향 st1로 후진  3) 통로에 들 때까지 끝 조향 전진 ↔ 끝 조향 후진.
 * 다리마다 목표 heading에 닿거나 막힐 때까지 간다 (막히면 0.10 m 덜 간 자리에 선다).
 */
function tryExit(ctx: MotionCtx, G: Pose, corridor: ORect, s0: number, st1: number): Drive | null {
  const d = startDrive(ctx, G);
  if (move(d, -s0) > -s0 + 1e-9) return null;
  for (let leg = 0; leg < 12; leg++) {
    if (inRect(ctx.fp, d.pose, corridor, 20)) return d;
    const rem = wrapPi(corridor.angle - d.pose.heading); // 남은 회전 (+ = 반시계)
    if (Math.abs(rem) < 1e-6) return null; // 방향은 맞췄는데 통로 밖
    const dir = leg % 2 === 0 ? -1 : 1; // 후진부터 번갈아
    const steer = (leg === 0 ? st1 : 1) * Math.sign(rem) * dir; // heading 변화 = 이동 거리 × 곡률
    if (!setSteer(d, steer)) return null;
    const curvature = Math.tan(Math.abs(steer) * ctx.maxSteer) / ctx.spec.wheelbase;
    if (moveUntilBlocked(d, dir, Math.abs(rem) / curvature) === 0) return null;
  }
  return inRect(ctx.fp, d.pose, corridor, 20) ? d : null;
}

/** 처음 통하는 탈출: s0 0..4 m (0.1 m 간격) × 첫 후진 조향 1, 0.8, 0.6, 0.4 */
function driveOut(ctx: MotionCtx, G: Pose, corridor: ORect): Drive | null {
  for (let i = 0; i <= 40; i++) {
    for (const st1 of [1, 0.8, 0.6, 0.4]) {
      const d = tryExit(ctx, G, corridor, i / 10, st1);
      if (d) return d;
    }
  }
  return null;
}

describe('전면 직각 배치 (§1.8.2)', () => {
  for (const slotWidth of PERP_SLOT_PRESETS) {
    for (const target of TARGETS) {
      it(`${slotWidth} m, ${target}: 휠스톱 0.60 m 차고, 후면 직각과 같은 칸에 앞으로`, () => {
        const opt = { slotWidth, target };
        const sc = buildFrontPerpendicular(opt);
        const rear = buildRearPerpendicular(opt);
        const g = buildGarage(opt, { stopFromBack: STOP_FROM_BACK });
        expect(sc.kind).toBe('frontPerp');
        expect(sc.elements).toEqual(g.elements);
        expect([sc.bounds, sc.ceilingHeight, sc.floor, sc.lamps]).toEqual([g.bounds, g.ceilingHeight, g.floor, g.lamps]);
        expect(stopFace(sc)).toBeCloseTo((slotWidth >= 2.6 ? 5.2 : 5.0) - STOP_FROM_BACK, 9);
        // 목표: 후면 직각과 같은 칸 (slot, 15°), 요구 방향만 +π/2
        expect(sc.goal).toEqual({ ...rear.goal, rect: { ...rear.goal.rect, angle: Math.PI / 2 } });
        // 출발: 계약서 표의 기본값 (칸 중심 − 9, 통로 중앙, 동쪽)
        expect(sc.start.x).toBeCloseTo(sc.goal.rect.cx - 9, 9);
        expect(sc.start.y).toBe(-AISLE / 2);
        expect(sc.start.heading).toBe(0);
      });
    }
  }

  it('뒤로 넣은 자세는 칸 안이어도 성공이 아니다 (angleErr ≈ 180°)', () => {
    const sc = buildFrontPerpendicular({ slotWidth: 2.5, target: 'between' });
    const ev = evaluateGoal(sc.goal, buildFootprint(MODEL_Y_2025), { x: sc.goal.rect.cx, y: 3.8, heading: -Math.PI / 2 });
    expect(ev.inside).toBe(true);
    expect(ev.angleErrDeg).toBeCloseTo(180, 9);
    expect(ev.success).toBe(false);
  });
});

describe('휠스톱 0.60 m: 5.0 m 칸에 앞으로 넣을 자리가 모든 차종에 남는다 (§1.8.2)', () => {
  const sc = buildFrontPerpendicular({ slotWidth: 2.5, target: 'between' });
  const r = sc.goal.rect;
  const face = stopFace(sc);
  const at = (y: number): Pose => ({ x: r.cx, y, heading: Math.PI / 2 });

  for (const spec of allSpecs()) {
    it(`${spec.id}: 뒤축 위치 허용 폭 ≥ 10 cm`, () => {
      const ctx = motionCtx(spec, sc.elements);
      // 앞바퀴 앞끝이 휠스톱 면에 닿는 뒤축 y: 조금 덜 가면 통과, 조금 더 가면 바퀴가 걸린다
      const touch = face - spec.wheelbase - spec.tireDiameter / 2;
      expect(poseClear(ctx, at(touch - 0.002), 0).kind).toBe('ok');
      expect(poseClear(ctx, at(touch + 0.002), 0).kind).toBe('wheel');
      expect(evaluateGoal(sc.goal, ctx.fp, at(touch - 0.002)).success).toBe(true); // 앞범퍼는 칸 안쪽 경계 안
      // 뒤범퍼가 칸 입구(y 0)에 닿는 뒤축 y
      const mouth = spec.rearOverhang;
      expect(evaluateGoal(sc.goal, ctx.fp, at(mouth + 0.002)).success).toBe(true);
      expect(evaluateGoal(sc.goal, ctx.fp, at(mouth - 0.002)).inside).toBe(false);
      expect(touch - mouth).toBeGreaterThanOrEqual(0.1); // 가장 좁은 K5가 약 10.35 cm
      if (spec.id === MODEL_Y_2025.id) {
        expect(touch - mouth).toBeCloseTo(0.143, 3);
        expect(touch + spec.wheelbase + spec.frontOverhang).toBeCloseTo(4.933, 3); // 닿았을 때 앞범퍼
      }
    });
  }
});

for (const slotWidth of PERP_SLOT_PRESETS) {
  for (const target of TARGETS) {
    const option = `${slotWidth} ${target}`;

    describe(`전면 직각 ${option}: 목표 자세에서 후진으로 통로에 나올 수 있다 (§8.2)`, () => {
      const sc = buildFrontPerpendicular({ slotWidth, target });
      const r = sc.goal.rect;
      // 통로: 양 끝벽 안쪽, y −6..0. rect 각도 = 출발 방향
      const corridor = rectFromAabb(sc.bounds.x0 + 0.3, -AISLE, sc.bounds.x1 - 0.3, 0, sc.start.heading);
      const face = stopFace(sc);

      it('요소: 모두 볼록, id가 겹치지 않음', () => {
        expect(sc.elements.every((e) => isConvex(e.poly))).toBe(true);
        expect(new Set(sc.elements.map((e) => e.id)).size).toBe(sc.elements.length);
        expect(sc.floor.every((f) => isConvex(f.poly))).toBe(true);
      });

      for (const spec of allSpecs()) {
        const tight = KNOWN_TIGHT.find((k) => k.vehicle === spec.id && k.option === option);
        (tight ? it.skip : it)(tight ? `${spec.id}: KNOWN_TIGHT, ${tight.reason}` : spec.id, () => {
          const ctx = motionCtx(spec, sc.elements);
          // 출발: 막히지 않고, 아직 성공이 아니고, 통로 안
          expect(poseClear(ctx, sc.start, 0).kind).toBe('ok');
          expect(evaluateGoal(sc.goal, ctx.fp, sc.start).success).toBe(false);
          expect(inRect(ctx.fp, sc.start, corridor, 20)).toBe(true);

          // G: 칸 가운데, 앞으로 넣은 방향, 앞바퀴 앞끝이 휠스톱 면 0.03 m 앞
          const G: Pose = { x: r.cx, y: face - 0.03 - spec.wheelbase - spec.tireDiameter / 2, heading: Math.PI / 2 };
          expect(evaluateGoal(sc.goal, ctx.fp, G).success).toBe(true);
          expect(poseClear(ctx, G, 0).kind).toBe('ok');

          const d = driveOut(ctx, G, corridor);
          expect(d, 'no reverse multi-point exit reaches the aisle').not.toBeNull();
          expect(inRect(ctx.fp, d!.pose, corridor, 20)).toBe(true);
          expect(dirChanges(d!)).toBeLessThanOrEqual(12);
        });
      }
    });
  }
}
