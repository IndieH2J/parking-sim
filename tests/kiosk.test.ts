import { describe, expect, it } from 'vitest';
import { buildKiosk, kioskTargetPose } from '../src/scenarios/kiosk';
import { isConvex } from '../src/scenarios/common';
import type { Scenario } from '../src/scenarios/types';
import { buildFootprint } from '../src/sim/footprint';
import { polyToWorld, type Pose, type Vec2 } from '../src/sim/geometry';
import { evaluateGoal, rectFromAabb } from '../src/sim/goal';
import { kioskEval } from '../src/sim/kioskJudge';
import { motionCtx, poseClear } from '../src/sim/motion';
import { SCORE_PAR } from '../src/sim/score';
import { MODEL_Y_2025, type VehicleSpec } from '../src/sim/specs';
import { maxSteerAngle } from '../src/sim/vehicle';
import type { WorldElement } from '../src/sim/world';
import { startDrive } from './helpers/drive';
import { driveLog, proofTime, pursue } from './helpers/pursuit';
import { allCars } from './helpers/specs';

// 발권기 앞 정차 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C4·D). 빌더를 직접 import한다 (§A.5).
// 증명 범위: 11대 (프리셋 8 + 극단 치수 3). 출발에서 앞으로만 순수 추종해 G에 서고, kioskEval로 판정한다.

/** 증명하지 못한 차 (설계 D). 비워 둔다: 항목을 넣지 않는다 */
const KNOWN_TIGHT: string[] = [];

const CARS = allCars();
const FACE_Y = 0.1;
/** 증명 경로: 출발에서 곧게 2 m, S자, 마지막 직선 8 m (추종 끝 오차를 cm 아래로) */
const LEAD = 2;
const RUN = 8;

/** 설계 문구에서 다시 구한 값 (빌더 내부 값을 쓰지 않는다). xk = 발권기 중심 x는 sc에서 읽는다 */
function layout(spec: VehicleSpec, sc: Scenario) {
  const wl = spec.widthMirrors + 1.8; // 차로 너비 W_l
  const R = spec.wheelbase / Math.tan(maxSteerAngle(spec)); // 뒤축 최소 회전 반경
  const mo = (spec.widthMirrors - spec.width) / 2; // 미러가 차체 옆면 밖으로 나온 길이
  const e = spec.width / 2 - Math.max(spec.trackFront, spec.trackRear) / 2 - spec.tireWidth / 2; // 차체 옆면 → 타이어 바깥면
  const reachG = Math.max(mo, FACE_Y - e) + 0.06;
  const xk = sc.kiosk!.x;
  const xb = xk + spec.eye.fromFront + 1.2; // 차단기 막대 중심
  return { wl, R, reachG, xk, xb, xEnd: xb + 3 };
}

/** 축 정렬 외접 사각형 */
function box(poly: Vec2[]) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function expectBox(el: WorldElement | undefined, x0: number, y0: number, x1: number, y1: number, hMin: number, hMax: number) {
  expect(el).toBeDefined();
  expect(el!.poly).toHaveLength(4);
  const b = box(el!.poly);
  [b.x0, b.y0, b.x1, b.y1, el!.hMin, el!.hMax].forEach((v, i) => expect(v).toBeCloseTo([x0, y0, x1, y1, hMin, hMax][i], 9));
}

/** 차체·미러 월드 꼭짓점 */
function carVerts(spec: VehicleSpec, pose: Pose): Vec2[] {
  const fp = buildFootprint(spec);
  return [fp.body, fp.mirrorLeft, fp.mirrorRight].flatMap((p) => polyToWorld(p.poly, pose));
}

/**
 * 증명 경로 (뒤축): 출발에서 LEAD 곧게, 같은 반경 r의 두 원호(왼쪽 → 오른쪽)로 G의 y까지, RUN 곧게 G까지.
 * S자 길이 L = G.x − 출발 x − LEAD − RUN, 옆 이동 Δy이면 r = (L² + Δy²)/(4Δy).
 */
function proofPath(start: Pose, G: Pose): { path: Vec2[]; r: number } {
  const L = G.x - start.x - LEAD - RUN;
  const dy = G.y - start.y;
  const r = (L * L + dy * dy) / (4 * dy);
  const th = Math.asin(L / 2 / r);
  const x0 = start.x + LEAD;
  const n = 40;
  const path: Vec2[] = [{ x: start.x, y: start.y }];
  for (let i = 0; i <= n; i++) {
    const a = (th * i) / n;
    path.push({ x: x0 + r * Math.sin(a), y: start.y + r * (1 - Math.cos(a)) });
  }
  for (let i = n - 1; i >= 0; i--) {
    const a = (th * i) / n;
    path.push({ x: x0 + L - r * Math.sin(a), y: G.y - r * (1 - Math.cos(a)) });
  }
  path.push({ x: G.x, y: G.y });
  return { path, r };
}

describe('발권기 배치 (설계 C4)', () => {
  for (const { name, spec } of CARS) {
    it(`${name}: 요소·바닥·조명·목표가 설계대로`, () => {
      const sc = buildKiosk(spec);
      const { wl, xk, xb, xEnd } = layout(spec, sc);
      expect(sc.kind).toBe('kiosk');
      expect(sc.kiosk).toEqual({ x: xk, faceY: FACE_Y });
      for (const el of sc.elements) expect(isConvex(el.poly), el.id).toBe(true);
      for (const f of sc.floor) expect(isConvex(f.poly)).toBe(true);
      expect(new Set(sc.elements.map((el) => el.id)).size).toBe(sc.elements.length);

      // 벽 (높이 = 지붕 3.0): 차로 오른쪽 벽면 y = −W_l, 섬 뒤 y 1.2–1.5, 뒤 끝 벽면 x = 0, 앞 끝 벽면 x = Xb + 3
      const walls = sc.elements.filter((el) => el.tag === 'wall');
      expect(walls).toHaveLength(4);
      const wallAt = (f: (b: ReturnType<typeof box>) => boolean) => walls.find((w) => f(box(w.poly)));
      expectBox(wallAt((b) => Math.abs(b.y1 + wl) < 1e-9), -0.3, -wl - 0.3, xEnd + 0.3, -wl, 0, 3);
      expectBox(wallAt((b) => Math.abs(b.y0 - 1.2) < 1e-9), -0.3, 1.2, xEnd + 0.3, 1.5, 0, 3);
      expectBox(wallAt((b) => Math.abs(b.x1) < 1e-9), -0.3, -wl, 0, 1.2, 0, 3);
      expectBox(wallAt((b) => Math.abs(b.x0 - xEnd) < 1e-9), xEnd, -wl, xEnd + 0.3, 1.2, 0, 3);
      // 섬 연석, 발권기, 차단기 함
      const curbs = sc.elements.filter((el) => el.kind === 'curb');
      expect(curbs).toHaveLength(1);
      expectBox(curbs[0], xk - 3, 0, xb + 1.5, 1.2, 0, 0.15);
      const kiosks = sc.elements.filter((el) => el.tag === 'kiosk');
      expect(kiosks).toHaveLength(1);
      expectBox(kiosks[0], xk - 0.25, FACE_Y, xk + 0.25, 0.55, 0, 1.55);
      const barrier = sc.elements.filter((el) => el.tag === 'barrier');
      expectBox(barrier.find((el) => el.hMin === 0), xb - 0.2, 0.3, xb + 0.2, 0.7, 0, 1.1);
      // 막대: [Xb ± 0.04] × [−W_l + 0.1, 0.3], 높이 0.85–0.95, 함 쪽부터 0.5 m 칸, 색이 번갈아
      const arm = barrier.filter((el) => el.hMin > 0).sort((a, b) => box(b.poly).y1 - box(a.poly).y1);
      expect(arm.length).toBe(Math.ceil((wl + 0.2) / 0.5 - 1e-9));
      arm.forEach((el, i) => {
        expectBox(el, xb - 0.04, Math.max(-wl + 0.1, 0.3 - 0.5 * (i + 1)), xb + 0.04, 0.3 - 0.5 * i, 0.85, 0.95);
        if (i > 0) expect(el.meta?.color).not.toBe(arm[i - 1].meta?.color);
      });
      expect(new Set(arm.map((el) => el.meta?.color)).size).toBe(2);
      expect(sc.elements).toHaveLength(4 + 1 + 1 + 1 + arm.length);

      expect(sc.ceilingHeight).toBe(3);
      expect(sc.outdoor).toBeUndefined();
      expect(sc.floor).toHaveLength(1);
      expect(sc.floor[0].tone).toBe('aisle');
      const fb = box(sc.floor[0].poly);
      [fb.x0, fb.y0, fb.x1, fb.y1].forEach((v, i) => expect(v).toBeCloseTo([0, -wl, xEnd, 1.2][i], 9));
      // 조명: 차로 가운데 위 3 m 간격
      expect(sc.lamps.length).toBeGreaterThan(3);
      sc.lamps.forEach((p, i) => {
        expect(p.y).toBeCloseTo(-wl / 2, 9);
        expect(p.heading).toBe(0);
        if (i > 0) expect(p.x - sc.lamps[i - 1].x).toBeCloseTo(3, 9);
      });
      expect(sc.lamps[sc.lamps.length - 1].x).toBeLessThan(xEnd);

      // 목표: slot, 차로 방향 0, 10°. 사각형은 눈이 발권기 ±0.40 m, 창문 쪽 차체가 앞면 0.30 m 안인 차의 범위
      expect(sc.goal.kind).toBe('slot');
      expect(sc.goal.maxAngleDeg).toBe(10);
      const want = rectFromAabb(xk - (spec.length - spec.eye.fromFront) - 0.4, FACE_Y - 0.3 - spec.width, xk + spec.eye.fromFront + 0.4, FACE_Y, 0);
      expect(sc.goal.rect.angle).toBe(0);
      for (const k of ['cx', 'cy', 'halfL', 'halfW'] as const) expect(sc.goal.rect[k]).toBeCloseTo(want[k], 9);
    });
  }
});

describe('출발과 증명 자세 G', () => {
  for (const { name, spec } of CARS) {
    it(`${name}: 출발은 차로 가운데·막히지 않음·아직 성공 아님, G는 막히지 않고 성공, 차단기는 G보다 1 m 이상 앞`, () => {
      const sc = buildKiosk(spec);
      const { wl, R, reachG, xk } = layout(spec, sc);
      const ctx = motionCtx(spec, sc.elements);
      const k = sc.kiosk!;

      // 출발: y = −W_l/2, 뒤범퍼가 뒤 끝 벽면 1.5 m 앞, 동쪽
      expect(sc.start.y).toBeCloseTo(-wl / 2, 12);
      expect(sc.start.x - spec.rearOverhang).toBeCloseTo(1.5, 12);
      expect(sc.start.heading).toBe(0);
      expect(poseClear(ctx, sc.start, 0).kind).toBe('ok');
      expect(kioskEval(sc.goal, ctx.fp, spec, sc.start, k).success).toBe(false);
      expect(evaluateGoal(sc.goal, ctx.fp, sc.start).success).toBe(false);

      // G: 눈이 발권기 중심(along 0), reach = max(mo, 0.10 − e) + 0.06, heading 0
      const G = kioskTargetPose(spec, sc);
      expect(G.heading).toBe(0);
      const ev = kioskEval(sc.goal, ctx.fp, spec, G, k);
      expect(ev.reach).toBeCloseTo(reachG, 9);
      expect(ev.along).toBeCloseTo(0, 9);
      expect(reachG).toBeLessThanOrEqual(0.26 + 1e-9); // 창(0.30)까지 4 cm 이상 남는다 (미러 2.6 m 차가 경계)
      expect(poseClear(ctx, G, 0).kind).toBe('ok');
      expect(ev.success).toBe(true);
      expect(evaluateGoal(sc.goal, ctx.fp, G).success).toBe(true);

      // 출발 → G: 곧게 2 m, 반경 1.5R의 S자 (길이 2√(1.5·R·Δy)), 곧게 8 m. S자는 섬 앞끝(Xk − 3)보다 앞에서 끝난다
      const dy = G.y - sc.start.y;
      expect(G.x - sc.start.x).toBeCloseTo(LEAD + 2 * Math.sqrt(1.5 * R * dy) + RUN, 9);
      expect(G.x - RUN + spec.wheelbase).toBeLessThan(xk - 3);

      // 차단기 막대(차로를 가로지름)는 G의 차 맨 앞보다 1 m 이상 앞 (설계: 앞범퍼 1.2 m 앞에 막대 중심, 앞면까지 1.16 m)
      const front = Math.max(...carVerts(spec, G).map((p) => p.x));
      const armX = Math.min(...sc.elements.filter((el) => el.tag === 'barrier' && el.hMin > 0).flatMap((el) => el.poly.map((p) => p.x)));
      expect(armX - front).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('해결 가능성: 출발에서 앞으로만 순수 추종해 G에 선다 (전환 0)', () => {
  it('KNOWN_TIGHT는 비어 있다', () => {
    expect(KNOWN_TIGHT).toEqual([]);
  });

  for (const { name, spec } of CARS) {
    it(name, () => {
      const sc = buildKiosk(spec);
      const G = kioskTargetPose(spec, sc);
      const ctx = motionCtx(spec, sc.elements);
      const { path, r } = proofPath(sc.start, G);
      expect(r).toBeGreaterThanOrEqual(1.5 * layout(spec, sc).R);

      // 목표를 주지 않는다: slot 사각형은 G보다 0.40 m 앞에서 이미 성공한다. 경로 끝(G)을 지나면 멈춘다
      const d = startDrive(ctx, sc.start, 0);
      const res = pursue(d, path);
      expect(res.end, res.error).toBe('end');
      const ev = kioskEval(sc.goal, ctx.fp, spec, d.pose, sc.kiosk!);
      expect(ev.success, `reach ${ev.reach.toFixed(4)} along ${ev.along.toFixed(4)} angle ${ev.angleErrDeg.toFixed(2)}°`).toBe(true);

      const log = driveLog(d);
      expect(log.dirChanges).toBe(0);
      if (spec === MODEL_Y_2025) expect(log.dirChanges).toBeLessThanOrEqual(SCORE_PAR.kiosk.moves);
      // 시간 기준 가드: 마지막(유일한) 구간은 P로 끝나므로 정지로 끝난다
      const T = proofTime(log, sc.goal.kind);
      expect(SCORE_PAR.kiosk.tGood, `T ${T.toFixed(2)}`).toBeGreaterThanOrEqual(1.5 * T);
    });
  }
});
