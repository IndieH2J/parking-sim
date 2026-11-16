import { describe, expect, it } from 'vitest';
import { buildAlley } from '../src/scenarios/alley';
import { isConvex } from '../src/scenarios/common';
import type { Scenario } from '../src/scenarios/types';
import { polygonDistance, type Vec2 } from '../src/sim/geometry';
import { evaluateGoal } from '../src/sim/goal';
import { motionCtx, poseClear } from '../src/sim/motion';
import { SCORE_PAR } from '../src/sim/score';
import type { VehicleSpec } from '../src/sim/specs';
import { maxSteerAngle } from '../src/sim/vehicle';
import type { WorldElement } from '../src/sim/world';
import { startDrive } from './helpers/drive';
import { driveLog, LOOK_AHEAD, minGapAlong, proofTime, pursue } from './helpers/pursuit';
import { allCars } from './helpers/specs';

// 좁은 골목 통과 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C2·D). 빌더를 직접 import한다 (§A.5).
// 기대값은 빌더 상수를 쓰지 않고 설계 문구·차 치수·sc.elements에서 다시 구한다. 증명 범위: 11대 (프리셋 8 + 극단 치수 3).

/** 좁은 곳의 미러 바깥 여유 s (설계 C2, 구성 하나) */
const ROOM = 0.3;
/** S자 원호 반경 = 이 값 × 뒤축 최소 회전 반경 (설계 C2 간격 식 2√(1.5·R·Δy)의 S자와 같은 반경) */
const TURN_K = 1.5;

/** §8.2 예외 목록. 이 코스는 11대 모두 증명하므로 비어 있어야 한다 (항목을 넣지 않는다). */
const KNOWN_TIGHT: string[] = [];

/** 뒤축 최소 회전 반경 */
const turnRadius = (spec: VehicleSpec) => spec.wheelbase / Math.tan(maxSteerAngle(spec));

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

/** 좁은 곳 하나: 주차 차와 전봇대, 각 외접 사각형, 차가 붙은 벽(−1 남, +1 북), 통로 가운데 y (차 안쪽 면과 전봇대 가까운 면의 가운데) */
interface Pinch {
  car: WorldElement;
  pole: WorldElement;
  c: Box;
  p: Box;
  side: -1 | 1;
  yc: number;
}

/** 요소에서 읽은 배치: 벽면 (남 yS, 북 yN, 서쪽 끝 xW, 동쪽 끝 xE)과 좁은 곳 (서쪽부터) */
function readLayout(sc: Scenario) {
  const walls = sc.elements.filter((e) => e.tag === 'wall').map((e) => box(e.poly));
  const long = walls.filter((b) => b.x1 - b.x0 > b.y1 - b.y0);
  const ends = walls.filter((b) => b.x1 - b.x0 <= b.y1 - b.y0);
  const cars = sc.elements.filter((e) => e.tag === 'car');
  const pinches: Pinch[] = sc.elements
    .filter((e) => e.tag === 'pole')
    .map((pole): Pinch => {
      const p = box(pole.poly);
      const px = (p.x0 + p.x1) / 2;
      const car = cars.find((e) => {
        const b = box(e.poly);
        return b.x0 <= px && px <= b.x1;
      })!;
      const c = box(car.poly);
      const side = c.y1 < p.y0 ? -1 : 1; // 차가 전봇대보다 남쪽이면 남쪽 벽
      const lo = side < 0 ? c.y1 : p.y1; // 통로 남쪽 끝
      const hi = side < 0 ? p.y0 : c.y0; // 통로 북쪽 끝
      return { car, pole, c, p, side, yc: (lo + hi) / 2 };
    })
    .sort((a, b) => a.c.x0 - b.c.x0);
  return {
    yS: Math.max(...long.filter((b) => b.y1 <= 0).map((b) => b.y1)),
    yN: Math.min(...long.filter((b) => b.y0 >= 0).map((b) => b.y0)),
    xW: Math.min(...ends.map((b) => b.x1)),
    xE: Math.max(...ends.map((b) => b.x0)),
    pinches,
  };
}

/** (xs, y0)에서 동쪽을 향해 출발해 반경 rho 원호 두 개로 dy만큼 옆으로 옮겨 다시 동쪽을 향하는 S자 (뒤축 경로 점, 약 5 cm 간격) */
function sBend(xs: number, y0: number, dy: number, rho: number): Vec2[] {
  const s = Math.sign(dy);
  const phi = Math.acos(1 - Math.abs(dy) / (2 * rho)); // 원호 하나가 도는 각
  const len = 2 * rho * Math.sin(phi); // S자의 x 길이
  const n = Math.max(2, Math.ceil((rho * phi) / 0.05));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (phi * i) / n;
    out.push({ x: xs + rho * Math.sin(t), y: y0 + s * rho * (1 - Math.cos(t)) });
  }
  for (let i = n - 1; i >= 0; i--) {
    const t = (phi * i) / n;
    out.push({ x: xs + len - rho * Math.sin(t), y: y0 + dy - s * rho * (1 - Math.cos(t)) });
  }
  return out;
}

/**
 * 증명 경로 (뒤축 중심, 지나갈 순서): 출발 자세에서 첫 통로 가운데를 따라 곧게 가고, 좁은 곳 사이마다 반경 1.5R 원호 두 개의 S자로
 * 다음 통로 가운데로 옮긴 뒤, 마지막 통로 가운데를 따라 출구 구역 끝 + 앞보기 거리까지 곧게 간다.
 * S자는 '앞 차를 뒤범퍼가 지난 뒤'(뒤축 x = 앞 차 끝 + 뒤 오버행)와 '다음 차에 앞범퍼가 닿기 전'(뒤축 x = 다음 차 시작 − 축거 − 앞 오버행) 사이의 가운데에 둔다.
 */
function proofPath(sc: Scenario, spec: VehicleSpec): Vec2[] {
  const rho = TURN_K * turnRadius(spec);
  const ps = readLayout(sc).pinches;
  const pts: Vec2[] = [{ x: sc.start.x, y: sc.start.y }];
  for (let k = 1; k < ps.length; k++) {
    const dy = ps[k].yc - ps[k - 1].yc;
    const len = 2 * rho * Math.sin(Math.acos(1 - Math.abs(dy) / (2 * rho)));
    const lo = ps[k - 1].c.x1 + spec.rearOverhang;
    const hi = ps[k].c.x0 - spec.wheelbase - spec.frontOverhang;
    pts.push(...sBend((lo + hi - len) / 2, ps[k - 1].yc, dy, rho));
  }
  const g = sc.goal.rect;
  pts.push({ x: g.cx + g.halfL + LOOK_AHEAD, y: ps[ps.length - 1].yc });
  return pts;
}

describe('골목 배치 (설계 C2): 11대', () => {
  for (const { name, spec } of allCars()) {
    it(`${name}: 요소·벽·좁은 곳·간격·출발·목표`, () => {
      const sc = buildAlley(spec);
      const F = spec.widthMirrors + 2 * ROOM;
      expect(sc.kind).toBe('alley');
      for (const e of sc.elements) expect(isConvex(e.poly), e.id).toBe(true);
      for (const f of sc.floor) expect(isConvex(f.poly)).toBe(true);
      expect(new Set(sc.elements.map((e) => e.id)).size).toBe(sc.elements.length);
      // 야외: 조명 없음, 도로 바닥. 점수 기준: 전환 0, gap 만점 0.20 m
      expect(sc.outdoor).toBe(true);
      expect(sc.lamps).toEqual([]);
      expect(sc.floor.map((f) => f.tone)).toEqual(['road']);
      expect(sc.scorePar).toEqual({ moves: 0, gapFull: 0.2 });
      // 요소: 벽 4 (높이 2.0), 주차 차 3, 전봇대 3 (높이 7.0)
      expect(sc.elements.map((e) => `${e.kind}:${e.tag}`).sort()).toEqual([
        ...Array<string>(3).fill('solid:car'),
        ...Array<string>(3).fill('solid:pole'),
        ...Array<string>(4).fill('solid:wall'),
      ]);
      for (const e of sc.elements.filter((x) => x.tag === 'wall')) expect([e.hMin, e.hMax]).toEqual([0, 2.0]);
      for (const e of sc.elements.filter((x) => x.tag === 'pole')) expect([e.hMin, e.hMax]).toEqual([0, 7.0]);

      const L = readLayout(sc);
      // 골목 폭 Wa = F + 2.6, 가운데 y = 0
      expect(L.yN - L.yS).toBeCloseTo(F + 2.6, 9);
      expect(L.yN + L.yS).toBeCloseTo(0, 9);
      // 좁은 곳 3군데, 주차 차가 붙은 벽 σ = (−1, +1, −1)
      expect(L.pinches.map((q) => q.side)).toEqual([-1, 1, -1]);
      for (const q of L.pinches) {
        const w = q.c.y1 - q.c.y0; // 주차 차 폭 (축 정렬)
        // 빈 폭 = F: 차 안쪽 면 ↔ 전봇대 가까운 면 (가운데로 지나가면 양쪽 미러 바깥 30 cm)
        expect(polygonDistance(q.car.poly, q.pole.poly)).toBeCloseTo(F, 9);
        // 전봇대: 지름 0.30 m, 차 가운데 x
        expect(q.p.x1 - q.p.x0).toBeCloseTo(0.3, 9);
        expect(q.p.y1 - q.p.y0).toBeCloseTo(0.3, 9);
        expect((q.p.x0 + q.p.x1) / 2).toBeCloseTo((q.c.x0 + q.c.x1) / 2, 9);
        // 주차 차는 벽면에서 0.15 m. 통로 가운데는 σ 반대쪽으로 차 폭 − 1.15 (약 0.7 m)
        expect(q.side < 0 ? q.c.y0 - L.yS : L.yN - q.c.y1).toBeCloseTo(0.15, 9);
        expect(q.yc).toBeCloseTo(-q.side * (w - 1.15), 9);
        // 전봇대 뒤 벽까지 2.15 − 차 폭 = 0.23~0.35 m: 어떤 차도 돌아가지 못한다
        const behind = q.side < 0 ? L.yN - q.p.y1 : q.p.y0 - L.yS;
        expect(behind).toBeCloseTo(2.15 - w, 9);
        expect(behind).toBeGreaterThanOrEqual(0.23);
        expect(behind).toBeLessThanOrEqual(0.35);
      }
      // 간격: 첫 차는 출발 앞범퍼 8 m 앞, 다음 차 시작 = 앞 차 끝 + 전장 + 2√(1.5·R·Δy) + 2.0
      expect(L.pinches[0].c.x0 - (sc.start.x + spec.wheelbase + spec.frontOverhang)).toBeCloseTo(8, 9);
      for (let k = 1; k < L.pinches.length; k++) {
        const a = L.pinches[k - 1];
        const b = L.pinches[k];
        const S = 2 * Math.sqrt(1.5 * turnRadius(spec) * Math.abs(b.yc - a.yc));
        expect(b.c.x0 - a.c.x1).toBeCloseTo(spec.length + S + 2.0, 9);
      }
      // 출발: 뒤범퍼가 서쪽 끝 벽면에서 1.5 m, 첫 통로 가운데, 동쪽. 충돌 없음, 아직 성공 아님
      expect(sc.start.x - spec.rearOverhang - L.xW).toBeCloseTo(1.5, 9);
      expect(sc.start.y).toBeCloseTo(L.pinches[0].yc, 9);
      expect(sc.start.heading).toBe(0);
      const ctx = motionCtx(spec, sc.elements);
      expect(poseClear(ctx, sc.start, 0).kind).toBe('ok');
      expect(evaluateGoal(sc.goal, ctx.fp, sc.start).success).toBe(false);
      // 목표: zone 30°, 각도 0. 마지막 차 끝 + 2 m부터 길이 max(5, 전장 + 1), 벽면~벽면. 동쪽 끝 벽면은 구역 3 m 뒤
      const g = sc.goal.rect;
      expect(sc.goal.kind).toBe('zone');
      expect(sc.goal.maxAngleDeg).toBe(30);
      expect(g.angle).toBe(0);
      expect(g.cx - g.halfL).toBeCloseTo(L.pinches[2].c.x1 + 2, 9);
      expect(2 * g.halfL).toBeCloseTo(Math.max(5, spec.length + 1), 9);
      expect(g.cy - g.halfW).toBeCloseTo(L.yS, 9);
      expect(g.cy + g.halfW).toBeCloseTo(L.yN, 9);
      expect(L.xE - (g.cx + g.halfL)).toBeCloseTo(3, 9);
    });
  }
});

describe('해결 가능성: 출발에서 출구 구역까지 전진만 (설계 D, 11대)', () => {
  it('KNOWN_TIGHT는 비어 있다', () => expect(KNOWN_TIGHT).toEqual([]));

  for (const { name, spec } of allCars()) {
    it(`${name}: 순수 추종 전진, 전환 0, 가장 가까이 간 거리 ≥ gapFull, 시간 기준`, () => {
      const sc = buildAlley(spec);
      const d = startDrive(motionCtx(spec, sc.elements), sc.start, 0);
      const r = pursue(d, proofPath(sc, spec), { goal: sc.goal });
      expect(r.end, r.error).toBe('goal');
      const log = driveLog(d);
      expect(log.legs.every((l) => l > 0)).toBe(true); // 전진만
      expect(log.dirChanges).toBe(0);
      expect(log.dirChanges).toBeLessThanOrEqual(sc.scorePar!.moves!);
      expect(log.dirChanges).toBeLessThanOrEqual(SCORE_PAR.alley.moves);
      const gap = minGapAlong(d);
      expect(gap, `minGap ${gap.toFixed(4)} m`).toBeGreaterThanOrEqual(sc.scorePar!.gapFull!);
      // 시간 기준: tGood ≥ 1.5 × 상한 속도로 이 주행에 걸리는 최소 시간 (출구 구역은 움직이는 채로 성공)
      const T = proofTime(log, sc.goal.kind);
      expect(SCORE_PAR.alley.tGood, `T ${T.toFixed(2)} s`).toBeGreaterThanOrEqual(1.5 * T);
    });
  }
});
