import { describe, expect, it } from 'vitest';
import { isConvex, octagon } from '../src/scenarios/common';
import { buildNarrowRamp, rampLaneWidths, rampSweep } from '../src/scenarios/narrowRamp';
import { RAMP_RADIUS_OPTIONS } from '../src/scenarios/types';
import { clearance } from '../src/sim/clearance';
import { buildFootprint, wheelPolys } from '../src/sim/footprint';
import { aabbRect, boundingRadius, type Vec2 } from '../src/sim/geometry';
import { evaluateGoal, rectFromAabb, type Goal } from '../src/sim/goal';
import { motionCtx } from '../src/sim/motion';
import { MODEL_Y_2025, type VehicleSpec } from '../src/sim/specs';
import { prepare, type WorldElement } from '../src/sim/world';
import { allSpecs, dirChanges, DS, move, moveSteering, moveUntilBlocked, setSteer, startDrive, type Drive } from './helpers/drive';
import { driveLog, minGapAlong, proofTime, pursue } from './helpers/pursuit';
import { allCars, OVERSIZED } from './helpers/specs';
import { legTime } from './helpers/timing';

// 단계 3 증명 도구의 회귀 테스트 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C0).
// WF-3a 코어 리뷰가 스크래치에서 확인한 것(logcheck·rampcmp·octcheck)을 옮겼다:
// driveLog·proofTime·pursue의 경계 동작, pursue = 램프 증명(driveRamp)의 시간, octagon의 모양.

/** 높이 0..h 상자 (solid는 벽, curb는 높이 0.15) */
const box = (id: string, x0: number, y0: number, x1: number, y1: number, kind: 'solid' | 'curb' = 'solid', h = 2.7): WorldElement =>
  prepare({ id, kind, tag: kind === 'solid' ? 'wall' : undefined, poly: aabbRect(x0, y0, x1, y1), hMin: 0, hMax: kind === 'curb' ? 0.15 : h });

/** 넓은 빈 마당: 남북 벽 y = ±8, 동쪽 벽 x = 30 */
const YARD = [box('n', -40, 8, 40, 8.3), box('s', -40, -8.3, 40, -8), box('e', 30, -8, 30.3, 8)];

describe('driveLog·proofTime: drive.ts 동작과 pursue를 섞어도 실제 순서대로 센다', () => {
  it('전진 → 제자리 조향 → 전진 → 후진(moveSteering) → 후진 → 전진(moveUntilBlocked): 구간 +3.5, −3, +', () => {
    const d = startDrive(motionCtx(MODEL_Y_2025, YARD), { x: 0, y: 0, heading: 0 }, 0);
    move(d, 2);
    setSteer(d, 0.5);
    move(d, 1.5);
    moveSteering(d, -0.5, -2);
    setSteer(d, 0);
    move(d, -1);
    moveUntilBlocked(d, 1, 50, 0.1);
    const log = driveLog(d);
    expect(log.dirChanges).toBe(dirChanges(d));
    // 같은 방향 이동은 사이에 제자리 조향이 있어도 한 구간
    expect(log.legs).toHaveLength(3);
    expect(log.legs[0]).toBeCloseTo(3.5, 9);
    expect(log.legs[1]).toBeCloseTo(-3, 9);
    expect(log.legs[2]).toBeGreaterThan(0);
    expect(log.legs.reduce((s, x) => s + x, 0)).toBeCloseTo(
      d.segments.reduce((s, x) => s + x.dist, 0),
      9,
    );
    // 마지막 구간만 목표 종류를 따른다: zone은 움직이며 끝나고, slot(발권기)은 정지로 끝난다
    const [a, b, c] = log.legs.map(Math.abs);
    const zone = proofTime(log, 'zone');
    const slot = proofTime(log, 'slot');
    expect(zone).toBeCloseTo(legTime(a, false) + legTime(b, false) + legTime(c, true), 12);
    expect(slot).toBeCloseTo(legTime(a, false) + legTime(b, false) + legTime(c, false), 12);
    expect(zone).toBeLessThan(slot);
  });

  it('움직이지 않은 운전: 구간 없음, 전환 0, 시간 0', () => {
    const log = driveLog(startDrive(motionCtx(MODEL_Y_2025, YARD), { x: 0, y: 0, heading: 0 }, 0));
    expect(log).toEqual({ legs: [], dirChanges: 0 });
    expect(proofTime(log, 'zone')).toBe(0);
  });
});

describe('pursue: 끝나는 방식', () => {
  it('바퀴가 연석에 걸리면 blocked, 막은 것을 알린다', () => {
    const curb = box('c1', 8, -3, 8.3, 3, 'curb');
    const d = startDrive(motionCtx(MODEL_Y_2025, [...YARD, curb]), { x: 0, y: 0, heading: 0 }, 0);
    const r = pursue(d, [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
    expect(r.end).toBe('blocked');
    expect(r.error).toMatch(/wheel F[LR] on curb c1/);
  });

  it('후진 추종 + 목표: 구역에서 처음 성공한 자세에서 멈춘다, 후진 한 구간', () => {
    const goal: Goal = { kind: 'zone', rect: rectFromAabb(-20, -3, -12, 3, 0), maxAngleDeg: 30 };
    const d = startDrive(motionCtx(MODEL_Y_2025, YARD), { x: 0, y: 0, heading: 0 }, 0);
    const path: Vec2[] = [];
    for (let x = 0; x >= -25; x -= 0.25) path.push({ x, y: x > -5 ? 0 : -Math.min(2, ((-x - 5) / 5) * 2) });
    const r = pursue(d, path, { dir: -1, goal });
    expect(r.end, r.error).toBe('goal');
    expect(evaluateGoal(goal, buildFootprint(MODEL_Y_2025), d.pose).success).toBe(true);
    const log = driveLog(d);
    expect(log.legs).toHaveLength(1);
    expect(log.legs[0]).toBeLessThan(0);
  });
});

describe('minGapAlong = 지나간 모든 자세의 clearance 최솟값', () => {
  // 폭 3.2 m 통로 (벽면 y = ±1.6)에서 옆으로 0.2 m 흔드는 S자
  const NARROW = [box('a', -5, 1.6, 40, 1.9), box('b', -5, -1.9, 40, -1.6)];
  const path: Vec2[] = [];
  for (let x = 0; x <= 30; x += 0.25) path.push({ x, y: x < 5 ? 0 : x < 15 ? 0.2 * Math.sin(((x - 5) / 10) * Math.PI) : 0 });

  it.each(allCars())('$name', ({ spec }) => {
    const d = startDrive(motionCtx(spec, NARROW), { x: 0, y: 0, heading: 0 }, 0);
    const r = pursue(d, path);
    expect(r.end, r.error).toBe('end');
    const plain = Math.min(...d.path.map((p) => clearance(d.ctx.fp, p, d.ctx.elements, 1)));
    expect(minGapAlong(d)).toBe(plain);
    expect(plain).toBeLessThan(1); // 상한이 아니라 잰 값
  });
});

// ---- pursue = 램프 증명 (tests/narrowRamp.test.ts의 layout·steadyWindow·referencePath·driveRamp를 그대로 옮김) ----
// 그 파일은 고정이라(내보내기를 더할 수 없음) 여기에 복사한다. 두 운전의 경로는 pursue가 경로를 0.05 m로 다시 나누므로
// 0.4 mm 안에서 다를 수 있다. 같아야 하는 것은 증명 시간 T (1e-3 s 안).

const CURB_W = 0.3;
const RAMP_LOOK_AHEAD = 2.5;
const BLEND = 2;
const KEEP = 2;

function layout(spec: VehicleSpec, Ri: number) {
  const { straight: Ws, curve: Wc } = rampLaneWidths(spec, Ri);
  const sw = rampSweep(spec, Ri);
  const need = Math.max(sw.wheelOuter + CURB_W, sw.bodyOuter) + 0.125;
  const c1 = { x: 12, y: Ws / 2 + Ri };
  const yS = Ws / 2 + 2 * Ri;
  const yN = yS + Ws;
  const c2 = { x: 4, y: yN + Ri };
  const xE = 4 - Ri;
  const zoneLen = Math.max(5, spec.length + 1);
  const hold = need > Math.hypot(Ri + Ws, 1.5) ? Math.min(Math.sqrt(need ** 2 - (Ri + Ws) ** 2), 4.5) : 0;
  const s3Len = Math.max(10, zoneLen + 5, hold + 1.5 + zoneLen);
  return { Ri, Ws, Wc, c1, yS, c2, xE, yEnd: c2.y + s3Len };
}
type Layout = ReturnType<typeof layout>;

const unitV = (deg: number): Vec2 => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });
const at = (c: Vec2, r: number, u: Vec2): Vec2 => ({ x: c.x + r * u.x, y: c.y + r * u.y });

function steadyWindow(spec: VehicleSpec, Ri: number, Wc: number): { rMin: number; rMax: number } {
  const fp = buildFootprint(spec);
  const rMin = Ri + CURB_W + Math.max(spec.trackFront, spec.trackRear) / 2 + spec.tireWidth / 2;
  const fits = (r: number) => {
    const rad = (p: Vec2) => Math.hypot(p.x, r - p.y);
    const wheel = Math.max(...Object.values(wheelPolys(spec, Math.atan(spec.wheelbase / r))).flat().map(rad));
    const body = Math.max(...[fp.body.poly, fp.mirrorLeft.poly, fp.mirrorRight.poly].flat().map(rad));
    return wheel <= Ri + Wc - CURB_W && body <= Ri + Wc;
  };
  if (!fits(rMin)) return { rMin, rMax: rMin };
  let lo = rMin;
  let hi = Ri + Wc;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return { rMin, rMax: lo };
}

function referencePath(spec: VehicleSpec, g: Layout): Vec2[] {
  const w = steadyWindow(spec, g.Ri, g.Wc);
  const dC = g.Ws / 2;
  const dIn = (w.rMin + w.rMax) / 2 - g.Ri;
  const blend = (t: number) => dC + ((dIn - dC) * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t))))) / 2;
  const after = (v: number) => blend(1 - (v - KEEP) / BLEND);
  const h = 0.05;
  const pts: Vec2[] = [];
  const arc = (c: Vec2, a0Deg: number, sweepDeg: number) => {
    const len = ((Math.abs(sweepDeg) * Math.PI) / 180) * (g.Ri + dIn);
    const n = Math.ceil(len / h);
    for (let k = 0; k < n; k++) pts.push(at(c, g.Ri + blend((len * k) / n / BLEND), unitV(a0Deg + (sweepDeg * k) / n)));
  };
  for (let x = 0; x < 12; x += h) pts.push({ x, y: 0 });
  arc(g.c1, -90, 180);
  for (let x = 12; x > 4; x -= h) pts.push({ x, y: g.yS + (x > 8 ? after(12 - x) : dC) });
  arc(g.c2, -90, -90);
  for (let y = g.c2.y; y < g.yEnd + RAMP_LOOK_AHEAD + 1; y += h) pts.push({ x: g.xE - after(y - g.c2.y), y });
  return pts;
}

/** narrowRamp.test.ts driveRamp (막힌 이유 문자열만 뺐다) */
function driveRamp(spec: VehicleSpec, Ri: number): { d: Drive; success: boolean } {
  const sc = buildNarrowRamp({ innerRadius: Ri }, spec);
  const ctx = motionCtx(spec, sc.elements);
  const ref = referencePath(spec, layout(spec, Ri));
  const d = startDrive(ctx, sc.start, 0);
  let i0 = 0;
  const maxSteps = Math.ceil((ref.length * 0.05) / DS);
  for (let step = 0; step < maxSteps; step++) {
    if (evaluateGoal(sc.goal, ctx.fp, d.pose).success) return { d, success: true };
    const p = d.pose;
    let iBest = i0;
    let best = Infinity;
    for (let i = i0; i < Math.min(ref.length, i0 + 200); i++) {
      const dd = (ref[i].x - p.x) ** 2 + (ref[i].y - p.y) ** 2;
      if (dd < best) {
        best = dd;
        iBest = i;
      }
    }
    i0 = iBest;
    let j = i0;
    while (j < ref.length - 1 && Math.hypot(ref[j].x - p.x, ref[j].y - p.y) < RAMP_LOOK_AHEAD) j++;
    const c = Math.cos(p.heading);
    const s = Math.sin(p.heading);
    const dx = ref[j].x - p.x;
    const dy = ref[j].y - p.y;
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    const kappa = (2 * ly) / (lx * lx + ly * ly);
    const steer = Math.max(-1, Math.min(1, Math.atan(spec.wheelbase * kappa) / ctx.maxSteer));
    if (steer !== d.steer) setSteer(d, steer);
    if (move(d, DS) === 0) return { d, success: false };
  }
  return { d, success: false };
}

/** 램프 증명의 차: 모델 Y·프리셋과 직접 입력 최대급 차 */
const RAMP_CARS: [string, VehicleSpec][] = [...allSpecs().map((s): [string, VehicleSpec] => [s.id, s]), ['OVERSIZED', OVERSIZED]];

describe('pursue = 램프 증명 (driveRamp): 같은 기준 경로에서 증명 시간 T가 1e-3 s 안에서 같다', () => {
  for (const Ri of RAMP_RADIUS_OPTIONS) {
    for (const [name, spec] of RAMP_CARS) {
      it(`${name} 반경 ${Ri} m`, () => {
        const run = driveRamp(spec, Ri);
        expect(run.success).toBe(true);
        const Ta = legTime(
          run.d.segments.reduce((s, x) => s + Math.abs(x.dist), 0),
          true,
        );
        const sc = buildNarrowRamp({ innerRadius: Ri }, spec);
        const d = startDrive(motionCtx(spec, sc.elements), sc.start, 0);
        const r = pursue(d, referencePath(spec, layout(spec, Ri)), { goal: sc.goal });
        expect(r.end, r.error).toBe('goal');
        const log = driveLog(d);
        expect(log.dirChanges).toBe(0);
        const Tb = proofTime(log, sc.goal.kind);
        expect(Math.abs(Tb - Ta), `driveRamp ${Ta.toFixed(3)} s, pursue ${Tb.toFixed(3)} s`).toBeLessThan(1e-3);
      });
    }
  }
});

describe('octagon (common.ts): r = 중심에서 변까지 거리', () => {
  it.each([
    [0, 0, 0.15],
    [12.3, -4.56, 0.15],
    [-3, 7, 1],
  ])('중심 (%s, %s), r %s: 볼록·반시계, 축에 수직인 변이 중심 ± r, 꼭짓점은 r / cos(π/8)', (cx, cy, r) => {
    const p = octagon(cx, cy, r);
    expect(p).toHaveLength(8);
    expect(isConvex(p)).toBe(true);
    let area2 = 0;
    for (let i = 0; i < 8; i++) area2 += p[i].x * p[(i + 1) % 8].y - p[(i + 1) % 8].x * p[i].y;
    expect(area2).toBeGreaterThan(0);
    // 네 변이 cx ± r, cy ± r에 놓이고 꼭짓점 두 개씩 (평평한 면)
    const e = 1e-12;
    const xs = p.map((q) => q.x);
    const ys = p.map((q) => q.y);
    expect(Math.min(...xs)).toBeCloseTo(cx - r, 11);
    expect(Math.max(...xs)).toBeCloseTo(cx + r, 11);
    expect(Math.min(...ys)).toBeCloseTo(cy - r, 11);
    expect(Math.max(...ys)).toBeCloseTo(cy + r, 11);
    for (const [k, v] of [
      ['x', cx - r],
      ['x', cx + r],
      ['y', cy - r],
      ['y', cy + r],
    ] as const) {
      expect(p.filter((q) => Math.abs(q[k] - v) < e)).toHaveLength(2);
    }
    const br = boundingRadius(p);
    expect(br.r).toBeCloseTo(r / Math.cos(Math.PI / 8), 11);
    expect(br.c.x).toBeCloseTo(cx, 11);
    expect(br.c.y).toBeCloseTo(cy, 11);
    // 모든 변의 중점이 중심에서 r
    for (let i = 0; i < 8; i++) {
      const a = p[i];
      const q = p[(i + 1) % 8];
      expect(Math.hypot((a.x + q.x) / 2 - cx, (a.y + q.y) / 2 - cy)).toBeCloseTo(r, 11);
    }
  });
});
