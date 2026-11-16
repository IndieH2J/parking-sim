import { describe, expect, it } from 'vitest';
import { buildNarrowRamp, rampLaneWidths, rampSweep } from '../src/scenarios/narrowRamp';
import { boundsOf, isConvex } from '../src/scenarios/common';
import { RAMP_RADIUS_OPTIONS, type Scenario } from '../src/scenarios/types';
import { buildFootprint, wheelPolys } from '../src/sim/footprint';
import { pointInConvex, type Vec2 } from '../src/sim/geometry';
import { evaluateGoal } from '../src/sim/goal';
import { motionCtx, poseClear, type MoveResult } from '../src/sim/motion';
import { SCORE_PAR } from '../src/sim/score';
import { readSensors } from '../src/sim/sensors';
import { MODEL_Y_2025, type VehicleSpec } from '../src/sim/specs';
import { integratePose } from '../src/sim/vehicle';
import { CUSTOM_ID, DEFAULT_CUSTOM_DIMS, getSpec, listVehicles, type CustomDims } from '../src/sim/vehicles';
import type { WorldElement } from '../src/sim/world';
import { allSpecs, dirChanges, DS, move, setSteer, startDrive, type Drive } from './helpers/drive';
import { legTime } from './helpers/timing';

// 좁은 통로·곡선 램프 (계약서 §1.8.4, §8.2). 빌더를 직접 import한다 (§A.5).

/** §8.2 SHOULD: 직접 입력 최대급 차 (CustomDims 필드 순서대로 6000, 2200, 2600, 2000, 3800, 1300, 1900, 15.0) */
const OVERSIZED_DIMS: CustomDims = {
  lengthMm: 6000,
  widthMm: 2200,
  widthMirrorsMm: 2600,
  heightMm: 2000,
  wheelbaseMm: 3800,
  frontOverhangMm: 1300,
  trackMm: 1900,
  turningDiameterM: 15.0,
};
const OVERSIZED = getSpec(CUSTOM_ID, OVERSIZED_DIMS);

const CURB_W = 0.3;
const WALL_T = 0.3;

/**
 * 계약서 문구에서 다시 구한 절대 좌표 (빌더 내부 값을 쓰지 않는다).
 * hold: 곡선 출구 바깥 벽을 곡선 폭으로 더 유지하는 거리 (v2-ramp 결정 로그). 정상 선회 스웹트 패스 + 여유(need)가
 * 1.5 m 테이퍼 끝 원 √((Ri + Ws)² + 1.5²) 안이면 0 (모델 Y·프리셋 전부), 넘으면 √(need² − (Ri + Ws)²) (최대 4.5 m).
 */
function layout(spec: VehicleSpec, Ri: number) {
  const { straight: Ws, curve: Wc } = rampLaneWidths(spec, Ri);
  const sw = rampSweep(spec, Ri);
  const need = Math.max(sw.wheelOuter + CURB_W, sw.bodyOuter) + 0.125;
  const c1 = { x: 12, y: Ws / 2 + Ri }; // C1 중심
  const yS = Ws / 2 + 2 * Ri; // S2 남쪽 벽면 (C1 안쪽)
  const yN = yS + Ws; // S2 북쪽 벽면 (C2 안쪽)
  const c2 = { x: 4, y: yN + Ri }; // C2 중심
  const xE = 4 - Ri; // S3 동쪽 벽면 (C2 안쪽)
  const xW = xE - Ws; // S3 서쪽 벽면
  const zoneLen = Math.max(5, spec.length + 1);
  const hold = need > Math.hypot(Ri + Ws, 1.5) ? Math.min(Math.sqrt(need ** 2 - (Ri + Ws) ** 2), 4.5) : 0;
  const s3Len = Math.max(10, zoneLen + 5, hold + 1.5 + zoneLen); // 출구 구역이 테이퍼에 걸리지 않게 (hold가 있을 때만 늘어남)
  return { Ri, Ws, Wc, c1, yS, yN, c2, xE, xW, zoneLen, s3Len, yEnd: c2.y + s3Len, hold };
}
type Layout = ReturnType<typeof layout>;

const isWall = (e: WorldElement) => e.kind === 'solid' && e.tag === 'wall';
const isCurb = (e: WorldElement) => e.kind === 'curb';
const unitV = (deg: number): Vec2 => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });
const at = (c: Vec2, r: number, u: Vec2): Vec2 => ({ x: c.x + r * u.x, y: c.y + r * u.y });
const neg = (v: Vec2): Vec2 => ({ x: -v.x, y: -v.y });
const N: Vec2 = { x: 0, y: 1 };
const S: Vec2 = { x: 0, y: -1 };
const E: Vec2 = { x: 1, y: 0 };
const W: Vec2 = { x: -1, y: 0 };

/** 곡선 정상 선회의 뒤축 반경 창: 안쪽 뒷바퀴가 안쪽 연석면, 바깥 바퀴가 바깥 연석면, 차체·미러가 바깥 벽면에 닿기 전 */
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

// ---------------------------------------------------------------- 차로 너비

describe('rampLaneWidths (§1.8.4)', () => {
  it('모델 Y 반경 6 m: 스웹트 패스 중간값이 계약서 값과 같다 (rr 7.37, 바퀴 8.83, 차체 9.09)', () => {
    const s = rampSweep(MODEL_Y_2025, 6);
    expect(s.rr).toBeCloseTo(7.37, 2);
    expect(s.wheelOuter).toBeCloseTo(8.83, 2);
    expect(s.bodyOuter).toBeCloseTo(9.09, 2);
    // 정상 선회 뒤축 반경 창: 계약서 "about [7.24, 7.87]" (반경 5 m: [6.24, 6.80])
    const w6 = steadyWindow(MODEL_Y_2025, 6, 3.6);
    expect(w6.rMin).toBeCloseTo(7.245, 3);
    expect(w6.rMax).toBeCloseTo(7.87, 2);
    const w5 = steadyWindow(MODEL_Y_2025, 5, 3.6);
    expect(w5.rMin).toBeCloseTo(6.245, 3);
    expect(w5.rMax).toBeCloseTo(6.8, 2);
  });

  it('모델 Y는 반경 6·5 m 모두 법정 최소 (3.3, 3.6) 그대로', () => {
    for (const Ri of RAMP_RADIUS_OPTIONS) expect(rampLaneWidths(MODEL_Y_2025, Ri)).toEqual({ straight: 3.3, curve: 3.6 });
  });

  it('프리셋도 모두 법정 최소 그대로 (넓히는 프리셋 없음)', () => {
    const widened = listVehicles().flatMap((v) =>
      RAMP_RADIUS_OPTIONS.map((Ri) => ({ id: v.id, Ri, w: rampLaneWidths(v.spec, Ri) })).filter(
        (c) => c.w.straight !== 3.3 || c.w.curve !== 3.6,
      ),
    );
    expect(widened).toEqual([]);
  });

  it('어떤 차든 법정 최소 이상', () => {
    for (const spec of [...allSpecs(), OVERSIZED]) {
      for (const Ri of RAMP_RADIUS_OPTIONS) {
        const w = rampLaneWidths(spec, Ri);
        expect(w.straight).toBeGreaterThanOrEqual(3.3);
        expect(w.curve).toBeGreaterThanOrEqual(3.6);
      }
    }
  });

  it('직접 입력 최대급 차는 곡선만 넓힌다', () => {
    expect(OVERSIZED.id).toBe(CUSTOM_ID); // 유효한 직접 입력 (모델 Y로 대체되지 않음)
    for (const Ri of RAMP_RADIUS_OPTIONS) {
      const w = rampLaneWidths(OVERSIZED, Ri);
      expect(w.straight).toBe(3.3);
      expect(w.curve).toBeGreaterThan(3.9);
    }
  });
});

// ---------------------------------------------------------------- 배치

type Band = 'wall' | 'curb' | 'free' | 'other';
/** 점이 들어 있는 요소. 벽 하나 · 연석 하나 · 없음 외에는 'other' (겹침) */
function bandAt(sc: Scenario, p: Vec2): Band {
  const hits = sc.elements.filter((e) => pointInConvex(p, e.poly));
  if (hits.length === 0) return 'free';
  if (hits.length === 1 && isWall(hits[0])) return 'wall';
  if (hits.length === 1 && isCurb(hits[0])) return 'curb';
  return 'other';
}
const inFloor = (sc: Scenario, p: Vec2) => sc.floor.some((f) => pointInConvex(p, f.poly));

/** 단면: 진행 방향 왼쪽·오른쪽 벽면 위 점과 벽 쪽 단위 법선. 조각 이음매가 아닌 조각 가운데에서 잰다. */
interface Probe {
  name: string;
  sides: { f: Vec2; n: Vec2 }[];
}
function probes(g: Layout): Probe[] {
  const sec = (name: string, lf: Vec2, ln: Vec2, rf: Vec2, rn: Vec2): Probe => ({
    name,
    sides: [
      { f: lf, n: ln },
      { f: rf, n: rn },
    ],
  });
  const a = unitV(2.5); // C1 꼭대기 옆 조각
  const b = unitV(47.5);
  const c = unitV(-137.5); // C2 조각
  const d = unitV(-177.5); // C2 끝 조각
  const list: Probe[] = [
    sec('S1 x 6', { x: 6, y: g.Ws / 2 }, N, { x: 6, y: -g.Ws / 2 }, S),
    sec('S1 테이퍼 가운데', { x: 11.25, y: g.Ws / 2 }, N, { x: 11.25, y: -g.Wc / 2 }, S),
    sec('C1 2.5°', at(g.c1, g.Ri, a), neg(a), at(g.c1, g.Ri + g.Wc, a), a),
    sec('C1 47.5°', at(g.c1, g.Ri, b), neg(b), at(g.c1, g.Ri + g.Wc, b), b),
    sec('S2 C1 출구 테이퍼 가운데', { x: 12 - g.hold - 0.75, y: g.yS }, S, { x: 12 - g.hold - 0.75, y: g.yS + (g.Wc + g.Ws) / 2 }, N),
    sec('S2 x 6', { x: 6, y: g.yS }, S, { x: 6, y: g.yN }, N),
    sec('S2 C2 입구 테이퍼 가운데', { x: 4.75, y: g.yS + (g.Ws - g.Wc) / 2 }, S, { x: 4.75, y: g.yN }, N),
    sec('C2 −137.5°', at(g.c2, g.Ri + g.Wc, c), c, at(g.c2, g.Ri, c), neg(c)),
    sec('C2 −177.5°', at(g.c2, g.Ri + g.Wc, d), d, at(g.c2, g.Ri, d), neg(d)),
    sec('S3 테이퍼 가운데', { x: g.xE - (g.Wc + g.Ws) / 2, y: g.c2.y + g.hold + 0.75 }, W, { x: g.xE, y: g.c2.y + g.hold + 0.75 }, E),
    sec('S3 출구 구역 시작', { x: g.xW, y: g.yEnd - g.zoneLen + 0.1 }, W, { x: g.xE, y: g.yEnd - g.zoneLen + 0.1 }, E),
    sec('S3 출구 구역 가운데', { x: g.xW, y: g.yEnd - g.zoneLen / 2 }, W, { x: g.xE, y: g.yEnd - g.zoneLen / 2 }, E),
  ];
  if (g.hold > 0) {
    list.push(
      sec('S2 C1 출구 폭 유지', { x: 12 - g.hold / 2, y: g.yS }, S, { x: 12 - g.hold / 2, y: g.yS + g.Wc }, N),
      sec('S3 C2 출구 폭 유지', { x: g.xE - g.Wc, y: g.c2.y + g.hold / 2 }, W, { x: g.xE, y: g.c2.y + g.hold / 2 }, E),
    );
  }
  return list;
}

const same = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9;
const sharedCount = (a: Vec2[], b: Vec2[]) => a.filter((p) => b.some((q) => same(p, q))).length;

/** 꼭짓점 2개 이상을 공유하는 조각끼리 이은 그래프의 연결 요소와 차수 */
function seamGraph(polys: Vec2[][]): { comps: number[][]; deg: number[] } {
  const adj = polys.map(() => [] as number[]);
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      if (sharedCount(polys[i], polys[j]) >= 2) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }
  const seen = polys.map(() => false);
  const comps: number[][] = [];
  for (let i = 0; i < polys.length; i++) {
    if (seen[i]) continue;
    seen[i] = true;
    const stack = [i];
    const comp: number[] = [];
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      for (const j of adj[k]) {
        if (!seen[j]) {
          seen[j] = true;
          stack.push(j);
        }
      }
    }
    comps.push(comp);
  }
  return { comps, deg: adj.map((x) => x.length) };
}
/** 연결 요소가 한 줄(양 끝 차수 1, 나머지 2)인지 */
const isPath = (comp: number[], deg: number[]) =>
  comp.filter((i) => deg[i] === 1).length === 2 && comp.every((i) => deg[i] === 1 || deg[i] === 2);

const CASES = RAMP_RADIUS_OPTIONS.flatMap((Ri) => [...allSpecs(), OVERSIZED].map((spec) => ({ Ri, spec })));

describe('램프 배치 (§1.8.4)', () => {
  for (const { Ri, spec } of CASES) {
    const name = `${spec.id} 반경 ${Ri} m`;
    const sc = buildNarrowRamp({ innerRadius: Ri }, spec);
    const g = layout(spec, Ri);
    const walls = sc.elements.filter(isWall);
    const curbs = sc.elements.filter(isCurb);

    it(`${name}: 요소·출발·목표·범위`, () => {
      expect(sc.kind).toBe('ramp');
      expect(sc.ceilingHeight).toBe(2.3);
      expect(new Set(sc.elements.map((e) => e.id)).size).toBe(sc.elements.length);
      expect(walls.length + curbs.length).toBe(sc.elements.length); // 벽과 연석뿐
      for (const e of sc.elements) expect(isConvex(e.poly), e.id).toBe(true);
      for (const e of walls) expect([e.hMin, e.hMax]).toEqual([0, 2.3]);
      for (const e of curbs) {
        expect([e.hMin, e.hMax]).toEqual([0, 0.12]);
        expect(Number.isFinite(e.dir)).toBe(true);
        expect(e.meta?.color).toBe(0xd8b020);
      }
      // 바닥: 조각마다 하나, 볼록
      expect(sc.floor.length).toBe(curbs.length / 2);
      for (const f of sc.floor) {
        expect(f.tone).toBe('aisle');
        expect(isConvex(f.poly)).toBe(true);
      }
      expect(sc.bounds).toEqual(boundsOf(sc.elements, 1.0));

      expect(sc.start).toEqual({ x: 2, y: 0, heading: 0 });
      const ctx = motionCtx(spec, sc.elements);
      expect(poseClear(ctx, sc.start, 0).kind).toBe('ok');
      expect(evaluateGoal(sc.goal, ctx.fp, sc.start).success).toBe(false);
      // 출구 구역: S3 마지막 zoneLen m, 벽면~벽면, 북쪽 30°
      expect(sc.goal.kind).toBe('zone');
      expect(sc.goal.maxAngleDeg).toBe(30);
      const r = sc.goal.rect;
      expect(r.angle).toBeCloseTo(Math.PI / 2, 12);
      expect(r.cx).toBeCloseTo((g.xW + g.xE) / 2, 9);
      expect(r.cy).toBeCloseTo(g.yEnd - g.zoneLen / 2, 9);
      expect(r.halfL).toBeCloseTo(g.zoneLen / 2, 9);
      expect(r.halfW).toBeCloseTo(g.Ws / 2, 9);
    });

    it(`${name}: 단면이 벽|연석|차로|연석|벽이고 계약서 좌표와 같다, 양 끝은 벽`, () => {
      for (const pr of probes(g)) {
        for (const { f, n } of pr.sides) {
          const p = (k: number) => ({ x: f.x + n.x * k, y: f.y + n.y * k });
          expect(bandAt(sc, p(WALL_T / 2)), `${pr.name}: 벽`).toBe('wall');
          expect(bandAt(sc, p(-CURB_W / 2)), `${pr.name}: 연석`).toBe('curb');
          expect(bandAt(sc, p(-CURB_W - 0.15)), `${pr.name}: 차로`).toBe('free');
          expect(inFloor(sc, p(-CURB_W - 0.15)), `${pr.name}: 바닥`).toBe(true);
        }
        const [l, r] = pr.sides;
        const mid = { x: (l.f.x + r.f.x) / 2, y: (l.f.y + r.f.y) / 2 };
        expect(bandAt(sc, mid), `${pr.name}: 가운데`).toBe('free');
        expect(inFloor(sc, mid), `${pr.name}: 가운데 바닥`).toBe(true);
      }
      const xm = (g.xW + g.xE) / 2;
      expect(bandAt(sc, { x: -WALL_T / 2, y: 0 })).toBe('wall');
      expect(bandAt(sc, { x: 0.15, y: 0 })).toBe('free');
      expect(bandAt(sc, { x: xm, y: g.yEnd + WALL_T / 2 })).toBe('wall');
      expect(bandAt(sc, { x: xm, y: g.yEnd - 0.15 })).toBe('free');
    });

    it(`${name}: 벽·연석 조각이 양쪽에서 한 줄로 이어지고 이음매 꼭짓점을 공유 (|Δ| < 1e-9)`, () => {
      const wg = seamGraph(walls.map((e) => e.poly));
      const chains = wg.comps.filter((x) => x.length > 1);
      // 양쪽 벽 두 줄 + 끝 벽 두 개 (끝 벽은 옆 벽과 꼭짓점 하나만 공유)
      expect(chains.length).toBe(2);
      expect(wg.comps.filter((x) => x.length === 1).length).toBe(2);
      for (const x of chains) {
        expect(isPath(x, wg.deg)).toBe(true);
        expect(x.length).toBe(sc.floor.length);
      }
      const cg = seamGraph(curbs.map((e) => e.poly));
      expect(cg.comps.length).toBe(2);
      for (const x of cg.comps) expect(isPath(x, cg.deg)).toBe(true);
      // 연석마다 벽면 쪽 변을 벽 조각 하나와 공유한다 (벽과 연석 사이 틈 없음)
      for (const c of curbs) expect(walls.filter((w) => sharedCount(c.poly, w.poly) === 2).length, c.id).toBe(1);
    });

    it(`${name}: 곡선은 5° 조각, 안쪽 벽면 반경이 Ri`, () => {
      // 안쪽 연석: 모든 꼭짓점이 곡선 중심에서 Ri(벽면) 또는 Ri + 0.3(연석면)
      const onInner = (c: Vec2) => (e: WorldElement) =>
        e.poly.every((p) => {
          const r = Math.hypot(p.x - c.x, p.y - c.y);
          return Math.abs(r - Ri) < 1e-9 || Math.abs(r - Ri - CURB_W) < 1e-9;
        });
      expect(curbs.filter(onInner(g.c1)).length).toBe(36); // 180° / 5°
      expect(curbs.filter(onInner(g.c2)).length).toBe(18); // 90° / 5°
    });

    it(`${name}: 조명은 차로 중심선을 따라 4 m 간격`, () => {
      expect(sc.lamps[0].x).toBeCloseTo(2, 9);
      expect(sc.lamps[0].y).toBe(0);
      expect(sc.lamps[0].heading).toBe(0);
      for (let i = 1; i < sc.lamps.length; i++) {
        const dist = Math.hypot(sc.lamps[i].x - sc.lamps[i - 1].x, sc.lamps[i].y - sc.lamps[i - 1].y);
        expect(dist).toBeLessThanOrEqual(4 + 1e-9);
        expect(dist).toBeGreaterThan(3.9); // 곡선에서는 현이 호보다 조금 짧다
      }
      for (const l of sc.lamps) expect(bandAt(sc, l)).toBe('free');
      expect(sc.lamps[sc.lamps.length - 1].y).toBeGreaterThan(g.yEnd - 5);
    });
  }
});

// ---------------------------------------------------------------- 센서 (§1.7: 하늘색 숫자 = 연석까지)

describe('센서: 곡선에서도 하늘색 측면 숫자는 연석까지 거리 (§1.7)', () => {
  // 연석면은 벽면에서 0.3 m 안쪽이다 (곡선은 같은 각의 현끼리 평행, 간격 0.3·cos 2.5°). 그래서 같은 쪽의
  // 연석까지 거리 = 벽까지 거리(zones, 흰 숫자) − 약 0.30. 바깥쪽 연석 조각은 진행축과 15° 넘게 어긋나도 잰다.
  const sc = buildNarrowRamp({ innerRadius: 6 }, MODEL_Y_2025);
  const fp = buildFootprint(MODEL_Y_2025);
  const poses = [
    // 리뷰 재현 자세 (C1, 바깥 = 오른쪽): 예전 필터로는 하늘색 59 cm, 실제 연석까지 2.5 cm
    { name: 'C1 (바깥 오른쪽)', pose: { x: 16.119, y: 1.3563, heading: 0.56467 } },
    // 해결 가능성 주행의 C2 가운데 (바깥 = 왼쪽)
    { name: 'C2 (바깥 왼쪽)', pose: { x: -1.2952, y: 17.5794, heading: 2.37407 } },
  ];
  for (const { name, pose } of poses) {
    it(`모델 Y 반경 6 m ${name}: 좌우 모두 연석 = 벽 − 0.30 (±1 cm)`, () => {
      expect(poseClear(motionCtx(MODEL_Y_2025, sc.elements), pose, 0).kind).toBe('ok');
      const s = readSensors(fp, pose, sc.elements);
      for (const side of ['left', 'right'] as const) {
        const wall = s.zones[side];
        const curb = s.lines[`${side}Body`];
        expect(wall).not.toBeNull();
        expect(curb).not.toBeNull();
        expect(Math.abs(curb! - (wall! - 0.3))).toBeLessThan(0.01);
      }
    });
  }
});

// ---------------------------------------------------------------- 해결 가능성 (§8.2: 출발 → 출구 구역, 전진만)

const LOOK_AHEAD = 2.5;
/** 기준 경로가 곡선 안쪽으로 옮겨 가는 길이 (곡선 시작부터)와 곡선 뒤 직선 중심으로 돌아오는 길이 */
const BLEND = 2;
/** 곡선 끝 뒤에도 안쪽 기준을 유지하는 거리 (출구 테이퍼에서 바깥 앞바퀴가 연석에 다가가지 않게) */
const KEEP = 2;

/**
 * 뒤축이 따라갈 기준 경로 (0.05 m 간격 꺾은선).
 * - 직선: 차로 중심 (안쪽 벽면에서 dC = Ws/2)
 * - 곡선: 안쪽 연석 쪽으로 당긴 정상 선회 창의 가운데 반경 (안쪽 벽면에서 dIn). 곡선 처음 BLEND m에 걸쳐 dC → dIn
 * - 곡선 뒤 직선: KEEP m 동안 dIn, 그다음 BLEND m에 걸쳐 dC로
 * 끝 벽 너머까지 늘여 앞보기 점이 항상 있게 한다.
 */
function referencePath(spec: VehicleSpec, g: Layout): Vec2[] {
  const w = steadyWindow(spec, g.Ri, g.Wc);
  const dC = g.Ws / 2;
  const dIn = (w.rMin + w.rMax) / 2 - g.Ri;
  /** t 0 → dC, 1 → dIn (코사인 보간) */
  const blend = (t: number) => dC + ((dIn - dC) * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t))))) / 2;
  /** v = 곡선 끝에서 지난 거리 */
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
  for (let y = g.c2.y; y < g.yEnd + LOOK_AHEAD + 1; y += h) pts.push({ x: g.xE - after(y - g.c2.y), y });
  return pts;
}

interface RampRun {
  d: Drive;
  sc: Scenario;
  success: boolean;
  error?: string;
}

const describeHit = (r: MoveResult) =>
  r.kind === 'wheel'
    ? `wheel ${r.wheel} on ${r.element.kind} ${r.element.id}`
    : r.kind === 'collision'
      ? `${r.hit.part} hits ${r.hit.element.tag} ${r.hit.element.id}`
      : 'ok';

/**
 * 순수 추종(pure pursuit) 전진 운전: 뒤축에서 LOOK_AHEAD 떨어진 기준 경로 위 점을 지나는 원호의 곡률로 조향한다.
 * 스텝마다 setSteer(거부되면 이전 조향 유지) 후 move(DS). 출구 구역 판정(evaluateGoal)이 성공하면 끝난다.
 */
function driveRamp(spec: VehicleSpec, Ri: number): RampRun {
  const sc = buildNarrowRamp({ innerRadius: Ri }, spec);
  const ctx = motionCtx(spec, sc.elements);
  const ref = referencePath(spec, layout(spec, Ri));
  const d = startDrive(ctx, sc.start, 0);
  let i0 = 0;
  const maxSteps = Math.ceil((ref.length * 0.05) / DS);
  for (let step = 0; step < maxSteps; step++) {
    if (evaluateGoal(sc.goal, ctx.fp, d.pose).success) return { d, sc, success: true };
    const p = d.pose;
    // 가장 가까운 기준점 (앞으로만 찾는다)
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
    while (j < ref.length - 1 && Math.hypot(ref[j].x - p.x, ref[j].y - p.y) < LOOK_AHEAD) j++;
    const c = Math.cos(p.heading);
    const s = Math.sin(p.heading);
    const dx = ref[j].x - p.x;
    const dy = ref[j].y - p.y;
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    const kappa = (2 * ly) / (lx * lx + ly * ly);
    const steer = Math.max(-1, Math.min(1, Math.atan(spec.wheelbase * kappa) / ctx.maxSteer));
    if (steer !== d.steer) setSteer(d, steer); // 거부되면 이전 조향 유지
    if (move(d, DS) === 0) {
      const next = integratePose(p, spec, d.steer, DS, 1);
      const pose = `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${((p.heading * 180) / Math.PI).toFixed(1)}°)`;
      return { d, sc, success: false, error: `blocked at ${pose} steer ${d.steer.toFixed(3)}: ${describeHit(poseClear(ctx, next, d.steer))}` };
    }
  }
  return { d, sc, success: false, error: 'step limit' };
}

/** §8.2 예외 목록: 증명하지 못한 (차종, 옵션)만 넣고 결정 로그에 남긴다. 현재 없음. */
const KNOWN_TIGHT: { vehicle: string; option: string; reason: string }[] = [];

function expectDrive(spec: VehicleSpec, Ri: number) {
  const run = driveRamp(spec, Ri);
  expect(run.error).toBeUndefined();
  expect(run.success).toBe(true);
  expect(evaluateGoal(run.sc.goal, buildFootprint(spec), run.d.pose).success).toBe(true);
  expect(dirChanges(run.d)).toBe(0);
  expect(run.d.segments.every((x) => x.dist > 0)).toBe(true); // 전진만
}

/** 모델 Y(DEFAULT_CUSTOM_DIMS) → OVERSIZED_DIMS 직선 위의 직접 입력 치수 (입력 단위로 반올림) */
function customBetween(s: number): CustomDims {
  const o = { ...DEFAULT_CUSTOM_DIMS };
  for (const k of Object.keys(o) as (keyof CustomDims)[]) {
    const v = DEFAULT_CUSTOM_DIMS[k] + (OVERSIZED_DIMS[k] - DEFAULT_CUSTOM_DIMS[k]) * s;
    o[k] = k === 'turningDiameterM' ? Math.round(v * 100) / 100 : Math.round(v);
  }
  return o;
}

/** 그 직선 위에서 pred가 참인 가장 큰 차와 거짓인 가장 작은 차 (이분법, 모델 Y에서 참·최대급에서 거짓) */
function boundary(pred: (sp: VehicleSpec) => boolean): [VehicleSpec, VehicleSpec] {
  const spec = (s: number) => getSpec(CUSTOM_ID, customBetween(s));
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (pred(spec(mid))) lo = mid;
    else hi = mid;
  }
  return [spec(lo), spec(hi)];
}

describe('해결 가능성: 출발에서 출구 구역까지 전진만 (§8.2)', () => {
  for (const Ri of RAMP_RADIUS_OPTIONS) {
    for (const spec of allSpecs()) {
      const option = `R${Ri}`;
      const tight = KNOWN_TIGHT.find((k) => k.vehicle === spec.id && k.option === option);
      if (tight) {
        it.skip(`${spec.id} 반경 ${Ri} m: KNOWN_TIGHT, ${tight.reason}`, () => {});
        continue;
      }
      it(`${spec.id} 반경 ${Ri} m`, () => expectDrive(spec, Ri));
    }
    it(`직접 입력 최대급 차 반경 ${Ri} m: 넓힌 곡선으로 통과 (SHOULD)`, () => expectDrive(OVERSIZED, Ri));
    it(`직접 입력 반경 ${Ri} m: 출구 폭 유지·곡선 넓힘 경계 바로 아래·위 차도 통과`, () => {
      // 출구 폭 유지가 없는 가장 큰 차 / 있는 가장 작은 차 (둘 다 법정 폭 곡선)
      const [noHold, held] = boundary((sp) => layout(sp, Ri).hold === 0);
      // 곡선을 넓히지 않는 가장 큰 차 (유지 없이 1.5 m 테이퍼면 C1 출구에서 벽에 닿던 차) / 넓히는 가장 작은 차
      const [legal, widened] = boundary((sp) => rampLaneWidths(sp, Ri).curve === 3.6);
      for (const sp of [noHold, held, legal, widened]) expect(sp.id).toBe(CUSTOM_ID);
      expect(layout(noHold, Ri).hold).toBe(0);
      expect(layout(held, Ri).hold).toBeGreaterThan(0);
      expect(rampLaneWidths(held, Ri).curve).toBe(3.6);
      expect(layout(legal, Ri).hold).toBeGreaterThan(0);
      expect(rampLaneWidths(widened, Ri).curve).toBeGreaterThan(3.6);
      for (const sp of [noHold, held, legal, widened]) expectDrive(sp, Ri);
    });
  }
});

// ---------------------------------------------------------------- 시간 기준 (D8 속도 상한 5 km/h)

describe('시간 기준: 램프 tGood ≥ 1.5 × 상한 속도로 걸리는 최소 시간 (D8)', () => {
  // T = 해결 가능성 주행의 뒤축 경로 길이를 가속 키를 끝까지 누른 채 가는 시간 (출구 구역은 움직이는 채로 성공한다).
  // 속도 상한이나 램프 길이가 바뀌어 실패하면 SCORE_PAR.ramp를 다시 맞춘다.
  const cars: [string, VehicleSpec][] = [
    ['모델 Y', MODEL_Y_2025],
    ['직접 입력 최대급 차', OVERSIZED],
  ];
  for (const [name, spec] of cars) {
    for (const Ri of RAMP_RADIUS_OPTIONS) {
      it(`${name} 반경 ${Ri} m`, () => {
        const run = driveRamp(spec, Ri);
        expect(run.success, run.error).toBe(true);
        const L = run.d.segments.reduce((s, x) => s + Math.abs(x.dist), 0);
        const T = legTime(L, true);
        console.log(`[ramp-time] ${spec.id} R${Ri}: L ${L.toFixed(2)} m, T ${T.toFixed(2)} s, tGood/T ${(SCORE_PAR.ramp.tGood / T).toFixed(2)}`);
        expect(SCORE_PAR.ramp.tGood).toBeGreaterThanOrEqual(1.5 * T);
      });
    }
  }
});
