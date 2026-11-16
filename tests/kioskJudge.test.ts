import { describe, expect, it } from 'vitest';
import { buildFootprint } from '../src/sim/footprint';
import type { Pose } from '../src/sim/geometry';
import { evaluateGoal, rectFromAabb, type Goal } from '../src/sim/goal';
import { KIOSK_ALONG_MAX, KIOSK_ANGLE_MAX, KIOSK_REACH_MAX, kioskEval } from '../src/sim/kioskJudge';
import { MODEL_Y_2025, type VehicleSpec } from '../src/sim/specs';
import { OVERSIZED, UNDERSIZED } from './helpers/specs';

// 발권기 앞 정차 판정 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C0·C4): 운전석 창문(눈의 x)에서 잰다.

/** 발권기: 중심 x 10, 차로 쪽 앞면 y 0.10 (차로는 +x, 발권기는 차 왼쪽) */
const k = { x: 10, faceY: 0.1 };

/** 설계 C4의 목표 사각형 (화면 표시와 각도용) */
const goalFor = (spec: VehicleSpec): Goal => ({
  kind: 'slot',
  rect: rectFromAabb(k.x - (spec.length - spec.eye.fromFront) - 0.4, k.faceY - 0.3 - spec.width, k.x + spec.eye.fromFront + 0.4, k.faceY, 0),
  maxAngleDeg: 10,
});

/** 창문 높이의 왼쪽 옆면이 앞면에서 reach, 눈이 발권기 중심에서 along(+ = 지남), 차로와 deg°(+ = 왼쪽으로 돎)인 뒤축 자세 */
function poseFor(spec: VehicleSpec, reach: number, along: number, deg = 0): Pose {
  const th = (deg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const xe = spec.wheelbase + spec.frontOverhang - spec.eye.fromFront;
  return { x: k.x + along - (xe * c - spec.eye.lateral * s), y: k.faceY - reach - (xe * s + (spec.width / 2) * c), heading: th };
}

const judge = (spec: VehicleSpec, p: Pose) => kioskEval(goalFor(spec), buildFootprint(spec), spec, p, k);

describe('kioskEval', () => {
  it('허용치는 설계값: 앞뒤 0.40 m, 앞면까지 0.30 m, 10°', () => {
    expect([KIOSK_ALONG_MAX, KIOSK_REACH_MAX, KIOSK_ANGLE_MAX]).toEqual([0.4, 0.3, 10]);
  });

  it.each([
    ['model-y-2025', MODEL_Y_2025],
    ['OVERSIZED', OVERSIZED],
    ['UNDERSIZED', UNDERSIZED],
  ] as const)('%s: 창 안(앞면 0.15 m, 눈이 정면)이면 성공하고 reach·along을 돌려준다', (_, spec) => {
    const r = judge(spec, poseFor(spec, 0.15, 0));
    expect(r.success).toBe(true);
    expect(r.inside).toBe(true);
    expect(r.headingOk).toBe(true);
    expect(r.reach).toBeCloseTo(0.15, 9);
    expect(r.along).toBeCloseTo(0, 9);
  });

  it('앞면에서 0.31 m면 실패, 0.29 m면 성공', () => {
    const far = judge(MODEL_Y_2025, poseFor(MODEL_Y_2025, 0.31, 0));
    expect(far.reach).toBeCloseTo(0.31, 9);
    expect(far.inside).toBe(false);
    expect(far.success).toBe(false);
    expect(judge(MODEL_Y_2025, poseFor(MODEL_Y_2025, 0.29, 0)).success).toBe(true);
  });

  it('눈이 발권기 중심에서 앞뒤로 0.41 m면 실패, 0.39 m면 성공 (along 부호 = 지남 +)', () => {
    for (const a of [0.41, -0.41]) {
      const r = judge(MODEL_Y_2025, poseFor(MODEL_Y_2025, 0.15, a));
      expect(r.along).toBeCloseTo(a, 9);
      expect(r.inside).toBe(false);
      expect(r.success).toBe(false);
    }
    for (const a of [0.39, -0.39]) expect(judge(MODEL_Y_2025, poseFor(MODEL_Y_2025, 0.15, a)).success).toBe(true);
  });

  it('각도 11°면 실패, 9°면 성공 (양쪽)', () => {
    for (const deg of [11, -11]) {
      const r = judge(MODEL_Y_2025, poseFor(MODEL_Y_2025, 0.15, 0, deg));
      expect(r.inside).toBe(true);
      expect(r.angleErrDeg).toBeCloseTo(11, 9);
      expect(r.headingOk).toBe(false);
      expect(r.success).toBe(false);
    }
    for (const deg of [9, -9]) expect(judge(MODEL_Y_2025, poseFor(MODEL_Y_2025, 0.15, 0, deg)).success).toBe(true);
  });

  it('각도 기준은 goal.maxAngleDeg가 아니라 10° 고정: 목표가 5°·30°여도 9°는 성공, 11°는 실패', () => {
    const spec = MODEL_Y_2025;
    const fp = buildFootprint(spec);
    for (const maxAngleDeg of [5, 30]) {
      const goal: Goal = { ...goalFor(spec), maxAngleDeg };
      const at = (deg: number) => poseFor(spec, 0.15, 0, deg);
      // goal.maxAngleDeg를 쓰는 evaluateGoal과는 결과가 갈린다 (5°면 9°도 각도 초과, 30°면 11°도 각도 안)
      expect(evaluateGoal(goal, fp, at(9)).headingOk).toBe(maxAngleDeg > 9);
      expect(evaluateGoal(goal, fp, at(11)).headingOk).toBe(maxAngleDeg > 11);
      expect(kioskEval(goal, fp, spec, at(9), k).success).toBe(true);
      const r = kioskEval(goal, fp, spec, at(11), k);
      expect(r.headingOk).toBe(false);
      expect(r.success).toBe(false);
    }
  });

  it('차 전체가 아니라 창문에서 잰다: 9° 기울면 차체가 목표 사각형을 벗어나도 성공', () => {
    const spec = MODEL_Y_2025;
    const p = poseFor(spec, 0.15, 0, 9);
    expect(evaluateGoal(goalFor(spec), buildFootprint(spec), p).inside).toBe(false);
    expect(judge(spec, p).success).toBe(true);
  });

  it('margin·offset·angleErrDeg는 evaluateGoal 값 그대로', () => {
    const spec = MODEL_Y_2025;
    const p = poseFor(spec, 0.2, -0.1, 3);
    const ev = evaluateGoal(goalFor(spec), buildFootprint(spec), p);
    const r = judge(spec, p);
    expect(r.margin).toEqual(ev.margin);
    expect(r.mirrorMargin).toEqual(ev.mirrorMargin);
    expect(r.offset).toEqual(ev.offset);
    expect(r.angleErrDeg).toBe(ev.angleErrDeg);
  });
});
