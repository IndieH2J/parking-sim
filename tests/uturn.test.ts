import { describe, expect, it } from 'vitest';
import { isConvex } from '../src/scenarios/common';
import type { Scenario } from '../src/scenarios/types';
import { buildUturn, UTURN_E, uturnWidth } from '../src/scenarios/uturn';
import { clearance } from '../src/sim/clearance';
import { buildFootprint } from '../src/sim/footprint';
import type { Vec2 } from '../src/sim/geometry';
import { evaluateGoal } from '../src/sim/goal';
import { motionCtx, poseClear } from '../src/sim/motion';
import { SCORE_PAR } from '../src/sim/score';
import { MODEL_Y_2025, type VehicleSpec } from '../src/sim/specs';
import { integratePose, maxSteerAngle } from '../src/sim/vehicle';
import { DS, move, setSteer, startDrive, type Drive } from './helpers/drive';
import { driveLog, minGapAlong, proofTime, pursue, type PursuitResult } from './helpers/pursuit';
import { allCars } from './helpers/specs';

// 막다른 골목 유턴 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C3·D). 빌더를 직접 import한다 (§A.5).
// 기대값은 빌더 상수를 쓰지 않고 설계 문구·차 치수·sc.elements에서 다시 구한다 (보정값 E만 고정해 적는다).
// 증명 범위: 11대 (프리셋 8 + 극단 치수 3).

/** §8.2 예외 목록. 이 코스는 11대 모두 증명하므로 비어 있어야 한다 (항목을 넣지 않는다). */
const KNOWN_TIGHT: string[] = [];

/**
 * 폭 계수 E (고정값). 보정: 아래 탐욕 K턴이 11대 모두 전환 2번 이하·최소 여유 0.20 m 이상으로 끝나는 가장 작은 E를
 * 0.01 간격으로 찾으면 0.49 (WIDE_SWING이 정함, 0.001 간격으로는 0.484), 여기에 0.03을 더했다. 0.49~0.91은 11대 모두 통과한다.
 */
const E = 0.52;

/** 다리를 멈추는 여유 (m): 다음 스텝 자세의 clearance가 이보다 작아지면 그 스텝을 가지 않는다 (gapFull 0.20 m보다 2 cm 크게) */
const GAP_STOP = 0.22;
/** 회전 다리 수 상한: 방향 전환 12번 */
const MAX_LEGS = 13;

/** 뒤축 최소 회전 반경 */
const turnRadius = (spec: VehicleSpec) => spec.wheelbase / Math.tan(maxSteerAngle(spec));

/** 설계 C3에서 다시 구한 배치: 폭, 벽면, 출발 범퍼, 출구 구역 */
function layout(spec: VehicleSpec) {
  const fp = buildFootprint(spec);
  const verts = [...fp.body.poly, ...fp.mirrorLeft.poly, ...fp.mirrorRight.poly];
  const far = (pts: Vec2[]) => Math.max(...pts.map((p) => Math.hypot(p.x, p.y)));
  const df = far(verts.filter((p) => p.x >= 0)); // 뒤축 앞쪽에서 가장 먼 차체·미러 꼭짓점까지
  const dr = far(verts.filter((p) => p.x < 0)); // 뒤쪽
  const R = turnRadius(spec);
  const Wu = df + dr + 0.5 + E * R;
  const front = -(R + 2.0); // 출발 앞범퍼 x (막다른 벽면 x = 0)
  const rear = front - spec.length; // 출발 뒷범퍼 x
  const zx1 = rear - 2; // 출구 구역 동쪽 끝
  const zx0 = zx1 - Math.max(5, spec.length + 1); // 서쪽 끝
  return { df, dr, R, Wu, hw: Wu / 2, front, zx0, zx1, xW: zx0 - 4 };
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
const box = (poly: Vec2[]): Box => ({
  x0: Math.min(...poly.map((p) => p.x)),
  x1: Math.max(...poly.map((p) => p.x)),
  y0: Math.min(...poly.map((p) => p.y)),
  y1: Math.max(...poly.map((p) => p.y)),
});

interface KTurn {
  d: Drive;
  /** 회전 다리 수 (마지막 서쪽 추종은 빼고) */
  legs: number;
  /** 서쪽 추종 결과. 회전을 끝내지 못했으면 null */
  run: PursuitResult | null;
  error?: string;
}

/**
 * 탐욕 K턴 (설계 D): 출발 자세에서 바로(직진 s0 = 0) 전진 왼쪽 끝 / 후진 오른쪽 끝을 번갈아 간다 (둘 다 heading이 커진다).
 * 다리마다 다음 스텝 자세의 clearance가 GAP_STOP보다 작아지기 전, 또는 heading이 π에 이르면 멈춘다 (π는 마지막 짧은 스텝으로 정확히 맞춘다).
 * 그다음 지금 뒤축 y의 서쪽 직선을 추종해 출구 구역(sc.goal)에 들어간다.
 * 움직임은 모두 drive.ts의 setSteer·move와 pursue다. integratePose·clearance는 다음 자세를 미리 보는 데만 쓴다 (순간이동 없음).
 * s0 = 0이어도 앞범퍼가 막다른 벽면에서 R + 2 m라, 11대 모두 증명 내내 막다른 벽까지 3 m 넘게 남는다 (보정 때 잰 값).
 */
function kTurn(spec: VehicleSpec, sc: Scenario): KTurn {
  const ctx = motionCtx(spec, sc.elements);
  const d = startDrive(ctx, sc.start, 0);
  /** heading이 1 m에 바뀌는 양 (rad/m) = 1 / 최소 회전 반경 */
  const k = Math.tan(ctx.maxSteer) / spec.wheelbase;
  let dir: 1 | -1 = 1;
  let legs = 0;
  let turned = false;
  while (!turned) {
    if (legs === MAX_LEGS) return { d, legs, run: null, error: `${MAX_LEGS} legs without reaching heading π` };
    if (!setSteer(d, dir)) return { d, legs, run: null, error: `steer refused at leg ${legs + 1}` }; // 전진은 왼쪽 끝(+1), 후진은 오른쪽 끝(−1)
    let moved = 0;
    for (;;) {
      const rest = (Math.PI - d.pose.heading) / k; // heading π까지 남은 거리
      const step = Math.min(DS, rest);
      const next = integratePose(d.pose, spec, d.steer, dir * step, 1);
      if (clearance(ctx.fp, next, ctx.elements, GAP_STOP) < GAP_STOP) break;
      const m = Math.abs(move(d, dir * step));
      moved += m;
      if (m < step - 1e-12) break; // poseClear 거부 (clearance가 GAP_STOP 이상이면 일어나지 않는다)
      if (step === rest) {
        turned = true;
        break;
      }
    }
    if (moved === 0) return { d, legs, run: null, error: `leg ${legs + 1} cannot start at heading ${((d.pose.heading * 180) / Math.PI).toFixed(1)}°` };
    legs++;
    dir = dir === 1 ? -1 : 1;
  }
  // 서쪽 추종: 지금 뒤축에서 출구 구역 서쪽 끝까지 같은 y의 직선
  const g = sc.goal.rect;
  const p = d.pose;
  const run = pursue(d, [{ x: p.x, y: p.y }, { x: g.cx - g.halfL, y: p.y }], { goal: sc.goal });
  return { d, legs, run };
}

describe('폭 Wu = d_f + d_r + 0.50 + E·R (설계 C3)', () => {
  it('E는 보정값 0.52로 고정, 모델 Y 7.94 m', () => {
    expect(UTURN_E).toBe(E);
    const L = layout(MODEL_Y_2025);
    expect(uturnWidth(MODEL_Y_2025)).toBeCloseTo(L.Wu, 9);
    expect(L.Wu).toBeCloseTo(7.941, 3);
    // 설계의 예전 추정 E = 0.55로는 설계 문구대로 8.07 m (d_f·d_r·R을 설계와 같게 읽었는지 확인)
    expect(L.df + L.dr + 0.5 + 0.55 * L.R).toBeCloseTo(8.07, 2);
  });
});

describe('배치 (설계 C3, 11대)', () => {
  for (const { name, spec } of allCars()) {
    it(name, () => {
      const sc = buildUturn(spec);
      const L = layout(spec);
      expect(sc.kind).toBe('uturn');
      expect(sc.outdoor).toBe(true);
      expect(sc.lamps).toEqual([]);
      expect(sc.scorePar).toEqual({ moves: 2, gapFull: 0.2 });
      // 요소: 모두 볼록, id가 겹치지 않음. 높이 2.0 m 벽 4개뿐
      expect(sc.elements.every((e) => isConvex(e.poly))).toBe(true);
      expect(new Set(sc.elements.map((e) => e.id)).size).toBe(sc.elements.length);
      expect(sc.elements.map((e) => [e.kind, e.tag, e.hMin, e.hMax])).toEqual(Array(4).fill(['solid', 'wall', 0, 2.0]));
      // 벽면: 남·북 y = ∓Wu/2, 동쪽 막다른 벽 x = 0, 서쪽 끝 벽 = 구역 서쪽 끝에서 4 m. 모서리가 막혀 있고 벽은 모두 벽면 바깥이다
      const walls = sc.elements.map((e) => box(e.poly));
      const one = (pred: (b: Box) => boolean) => {
        const m = walls.filter(pred);
        expect(m).toHaveLength(1);
        return m[0];
      };
      const at = (a: number, b: number) => Math.abs(a - b) < 1e-9;
      const south = one((b) => at(b.y1, -L.hw));
      const north = one((b) => at(b.y0, L.hw));
      const east = one((b) => at(b.x0, 0));
      const west = one((b) => at(b.x1, L.xW));
      for (const b of [south, north]) {
        expect(b.x0).toBeLessThanOrEqual(L.xW);
        expect(b.x1).toBeGreaterThanOrEqual(0);
      }
      for (const b of [east, west]) {
        expect(b.y0).toBeLessThanOrEqual(-L.hw);
        expect(b.y1).toBeGreaterThanOrEqual(L.hw);
      }
      for (const b of walls) expect(b.x1 <= L.xW || b.x0 >= 0 || b.y1 <= -L.hw || b.y0 >= L.hw).toBe(true);
      // 바닥: 벽면 안쪽 전체가 도로
      expect(sc.floor.map((f) => f.tone)).toEqual(['road']);
      expect(isConvex(sc.floor[0].poly)).toBe(true);
      const f = box(sc.floor[0].poly);
      expect(f.x0).toBeCloseTo(L.xW, 9);
      expect(f.x1).toBeCloseTo(0, 9);
      expect(f.y0).toBeCloseTo(-L.hw, 9);
      expect(f.y1).toBeCloseTo(L.hw, 9);
      // 출발: 동쪽, 남쪽 벽면에서 차체까지 0.55 m, 앞범퍼가 막다른 벽면에서 R + 2.0 m. 충돌 없음, 아직 성공 아님
      expect(sc.start.heading).toBe(0);
      expect(sc.start.y - spec.width / 2 + L.hw).toBeCloseTo(0.55, 9);
      expect(sc.start.x + spec.wheelbase + spec.frontOverhang).toBeCloseTo(L.front, 9);
      const ctx = motionCtx(spec, sc.elements);
      expect(poseClear(ctx, sc.start, 0).kind).toBe('ok');
      expect(evaluateGoal(sc.goal, ctx.fp, sc.start).success).toBe(false);
      // 목표: zone 30°, 서쪽(π). 출발 뒷범퍼에서 2 m 서쪽부터 길이 max(5, 전장 + 1), 벽면~벽면
      const g = sc.goal.rect;
      expect(sc.goal.kind).toBe('zone');
      expect(sc.goal.maxAngleDeg).toBe(30);
      expect(g.angle).toBe(Math.PI);
      expect(g.cx + g.halfL).toBeCloseTo(L.zx1, 9);
      expect(g.cx - g.halfL).toBeCloseTo(L.zx0, 9);
      expect(g.cy - g.halfW).toBeCloseTo(-L.hw, 9);
      expect(g.cy + g.halfW).toBeCloseTo(L.hw, 9);
    });
  }
});

describe('해결 가능성: 탐욕 K턴으로 돌아 출구 구역까지 (설계 D, 11대)', () => {
  it('KNOWN_TIGHT는 비어 있다', () => expect(KNOWN_TIGHT).toEqual([]));

  for (const { name, spec } of allCars()) {
    it(`${name}: 3점 회전 (전진·후진·전진, 전환 2), 가장 가까이 간 거리 ≥ gapFull, 시간 기준`, () => {
      const sc = buildUturn(spec);
      const r = kTurn(spec, sc);
      expect(r.run?.end, r.error ?? r.run?.error).toBe('goal');
      expect(evaluateGoal(sc.goal, r.d.ctx.fp, r.d.pose).success).toBe(true);
      const log = driveLog(r.d);
      expect(log.legs.map(Math.sign)).toEqual([1, -1, 1]);
      expect(log.dirChanges).toBeLessThanOrEqual(sc.scorePar!.moves!);
      expect(log.dirChanges).toBeLessThanOrEqual(SCORE_PAR.uturn.moves);
      const gap = minGapAlong(r.d);
      expect(gap, `minGap ${gap.toFixed(4)} m`).toBeGreaterThanOrEqual(sc.scorePar!.gapFull!);
      // 시간 기준: tGood ≥ 1.5 × 상한 속도로 이 주행에 걸리는 최소 시간 (출구 구역은 움직이는 채로 성공)
      const T = proofTime(log, sc.goal.kind);
      expect(SCORE_PAR.uturn.tGood, `T ${T.toFixed(2)} s`).toBeGreaterThanOrEqual(1.5 * T);
    });
  }
});
