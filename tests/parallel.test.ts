import { describe, expect, it } from 'vitest';
import { buildFootprint } from '../src/sim/footprint';
import { aabbRect, type Pose, type Vec2 } from '../src/sim/geometry';
import { evaluateGoal, rectFromAabb, type ORect } from '../src/sim/goal';
import { motionCtx, poseClear } from '../src/sim/motion';
import { readSensors } from '../src/sim/sensors';
import { MODEL_Y_2025, type VehicleSpec } from '../src/sim/specs';
import { findCollision, prepare, type WorldElement } from '../src/sim/world';
import { CEILING, isConvex, LINE_WIDTH } from '../src/scenarios/common';
import { PARALLEL_LENGTH_PRESETS, PARALLEL_LENGTH_RANGE, type Scenario } from '../src/scenarios/types';
import { AISLE_W, buildParallel, SLOT_W } from '../src/scenarios/parallel';
import {
  allSpecs,
  dirChanges,
  inRect,
  moveSteering,
  moveUntilBlocked,
  setSteer,
  startDrive,
  type Drive,
} from './helpers/drive';

// 평행 주차 (계약서 §1.8.3, §1.7, §8). 빌더는 index.ts를 거치지 않고 직접 import한다 (§A.5).

const DEG = Math.PI / 180;
const lw = LINE_WIDTH;

function bbox(poly: Vec2[]) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
function expectBox(poly: Vec2[], x0: number, y0: number, x1: number, y1: number) {
  const b = bbox(poly);
  expect(b.x0).toBeCloseTo(x0, 9);
  expect(b.y0).toBeCloseTo(y0, 9);
  expect(b.x1).toBeCloseTo(x1, 9);
  expect(b.y1).toBeCloseTo(y1, 9);
}

/** 이웃 차 규칙: 4대, 모두 동쪽, 오른쪽 면이 연석면에서 0.15 m, 목표 칸 양옆은 선에서 0.10 m, 나머지는 칸 가운데 */
function expectNeighbours(sc: Scenario, L: number) {
  const cars = sc.elements.filter((e) => e.kind === 'solid' && e.tag === 'car').sort((a, b) => bbox(a.poly).x0 - bbox(b.poly).x0);
  expect(cars.map((c) => Math.floor(Number(c.meta?.cx) / L))).toEqual([0, 1, 3, 4]);
  for (const c of cars) {
    expect(c.meta?.heading).toBe(0);
    const b = bbox(c.poly);
    expect(b.y0).toBeCloseTo(0.15, 9);
    expect(b.y1).toBeLessThanOrEqual(SLOT_W + lw / 2); // 주차 열 안
    expect(b.x1 - b.x0).toBeCloseTo(Number(c.meta?.length), 9);
  }
  const [s0, s1, s3, s4] = cars.map((c) => bbox(c.poly));
  expect((s0.x0 + s0.x1) / 2).toBeCloseTo(0.5 * L, 9);
  expect(s1.x1).toBeCloseTo(2 * L - lw / 2 - 0.1, 9);
  expect(s3.x0).toBeCloseTo(3 * L + lw / 2 + 0.1, 9);
  expect((s4.x0 + s4.x1) / 2).toBeCloseTo(4.5 * L, 9);
  expect(s3.x0 - s1.x1).toBeCloseTo(L + lw + 0.2, 9); // 빈 길이
}

const LENGTHS = [PARALLEL_LENGTH_RANGE.min, ...PARALLEL_LENGTH_PRESETS, PARALLEL_LENGTH_RANGE.max];

describe('평행 주차 배치 (§1.8.3, §1.7)', () => {
  for (const L of LENGTHS) {
    const sc = buildParallel({ slotLength: L });
    const xMax = 5 * L + 8;

    it(`L ${L} m: 요소 (볼록, id 유일, 벽·연석·선·이웃 차)`, () => {
      expect(sc.kind).toBe('parallel');
      const ids = sc.elements.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const e of sc.elements) expect(isConvex(e.poly), e.id).toBe(true);
      expect(sc.elements.filter((e) => e.kind === 'wheelStop')).toEqual([]);

      // 연석: 바퀴만 막는 경계석, 보행통로 쪽 (연석면 y = 0)
      const curbs = sc.elements.filter((e) => e.kind === 'curb');
      expect(curbs.length).toBe(1);
      const [curb] = curbs;
      expectBox(curb.poly, -6, -0.15, xMax, 0);
      expect([curb.hMin, curb.hMax, curb.dir, curb.meta?.color]).toEqual([0, 0.15, 0, 0xc8c8c8]);

      // 벽: 보행통로 뒤, 차로 맞은편 (차로 5.0 m), 양 끝
      const walls = sc.elements.filter((e) => e.kind === 'solid' && e.tag === 'wall');
      expect(walls.length).toBe(4);
      for (const w of walls) expect([w.hMin, w.hMax]).toEqual([0, CEILING]);
      const boxes = walls.map((w) => bbox(w.poly));
      const has = (x0: number, y0: number, x1: number, y1: number) =>
        boxes.some((b) => [b.x0 - x0, b.y0 - y0, b.x1 - x1, b.y1 - y1].every((v) => Math.abs(v) < 1e-9));
      expect(has(-6, -1.8, xMax, -1.5)).toBe(true);
      expect(has(-6, 7.0, xMax, 7.3)).toBe(true);
      expect(has(-6, -1.8, -5.7, 7.3)).toBe(true);
      expect(has(xMax - 0.3, -1.8, xMax, 7.3)).toBe(true);

      // 주차선: 칸 경계 가로선 x = k·L (연석면 → 차로 쪽 선 바깥 가장자리) + 차로 쪽 세로선 하나 (중심 y 2.0)
      const lines = sc.elements.filter((e) => e.kind === 'line');
      const across = lines.filter((e) => e.dir === Math.PI / 2).sort((a, b) => bbox(a.poly).x0 - bbox(b.poly).x0);
      const along = lines.filter((e) => e.dir === 0);
      expect([lines.length, across.length, along.length]).toEqual([7, 6, 1]);
      across.forEach((e, k) => expectBox(e.poly, k * L - lw / 2, 0, k * L + lw / 2, 2.0 + lw / 2));
      expectBox(along[0].poly, -lw / 2, 2.0 - lw / 2, 5 * L + lw / 2, 2.0 + lw / 2);

      expectNeighbours(sc, L);
      expect(sc.elements.length).toBe(4 + 1 + 7 + 4);
    });

    it(`L ${L} m: 목표 칸·출발·바닥·조명·범위`, () => {
      // 앞뒤 = 칸 선 안쪽 가장자리, 좌우 = 연석면 ~ 차로 쪽 선 바깥 가장자리, 요구 방향 0
      expect(sc.goal.kind).toBe('slot');
      expect(sc.goal.maxAngleDeg).toBe(15);
      const want = rectFromAabb(2 * L + lw / 2, 0, 3 * L - lw / 2, 2.0 + lw / 2, 0);
      for (const k of ['cx', 'cy', 'angle', 'halfL', 'halfW'] as const) expect(sc.goal.rect[k]).toBeCloseTo(want[k], 9);
      expect(sc.start).toEqual({ x: 2 * L - 9, y: 4.5, heading: 0 });
      expect(sc.bounds).toEqual({ x0: -6, x1: xMax, y0: -1.8, y1: 7.3 });
      expect(sc.ceilingHeight).toBe(2.7);

      expect(sc.floor.map((f) => [f.tone, f.h])).toEqual([
        ['aisle', undefined],
        ['walkway', 0.15],
      ]);
      expectBox(sc.floor[0].poly, -6, 2.0, xMax, 7.0);
      expectBox(sc.floor[1].poly, -6, -1.5, xMax, -0.15);
      for (const f of sc.floor) expect(isConvex(f.poly)).toBe(true);

      const lamps: Pose[] = [];
      for (let x = -4; x < xMax - 1; x += 3) for (const y of [1.0, 4.5]) lamps.push({ x, y, heading: 0 });
      expect(sc.lamps).toEqual(lamps);
    });
  }

  it('시드: 기본값은 7, 다른 시드는 이웃 차 크기·색만 바꾸고 배치 규칙은 같다', () => {
    expect(buildParallel({ slotLength: 6 })).toEqual(buildParallel({ slotLength: 6, seed: 7 }));
    const other = buildParallel({ slotLength: 6, seed: 3 });
    const metas = (sc: Scenario) => sc.elements.filter((e) => e.tag === 'car').map((e) => e.meta);
    expect(metas(other)).not.toEqual(metas(buildParallel({ slotLength: 6 })));
    expectNeighbours(other, 6);
  });

  it('모델 Y의 좌우 여유는 15.5 cm (2.0 m 칸, 차로 쪽 선 바깥 가장자리까지)', () => {
    const { rect } = buildParallel({ slotLength: 6 }).goal;
    expect(2 * rect.halfW - MODEL_Y_2025.width).toBeCloseTo(0.155, 9);
  });

  it('칸 안에 든 차체는 바퀴를 연석에 올리지 않는다 (모든 차종, 연석에 붙인 자세)', () => {
    for (const L of PARALLEL_LENGTH_PRESETS) {
      const sc = buildParallel({ slotLength: L });
      const r = sc.goal.rect;
      for (const spec of allSpecs()) {
        const ctx = motionCtx(spec, sc.elements);
        const mid = (spec.wheelbase + spec.frontOverhang - spec.rearOverhang) / 2;
        const pose = { x: r.cx - mid, y: 0.001 + spec.width / 2, heading: 0 }; // 차체 오른쪽 면이 연석면에서 1 mm
        const ev = evaluateGoal(sc.goal, ctx.fp, pose);
        expect(ev.success, spec.id).toBe(true);
        expect(ev.margin.right).toBeCloseTo(0.001, 9);
        expect(poseClear(ctx, pose, 0).kind, spec.id).toBe('ok');
      }
    }
  });

  it('센서: 칸 가운데 자세에서 연석까지 거리가 오른쪽 측면 거리(하늘색)로 잡힌다', () => {
    const sc = buildParallel({ slotLength: 6 });
    const fp = buildFootprint(MODEL_Y_2025);
    const r = sc.goal.rect;
    const mid = (MODEL_Y_2025.wheelbase + MODEL_Y_2025.frontOverhang - MODEL_Y_2025.rearOverhang) / 2;
    const pose = { x: r.cx - mid, y: r.cy, heading: 0 }; // 차체 중심 = 칸 중심 (__sim.goalPose와 같은 자세)
    const ev = evaluateGoal(sc.goal, fp, pose);
    expect(ev.margin.right).toBeCloseTo(0.0775, 9);
    expect(readSensors(fp, pose, sc.elements).lines.rightBody).toBeCloseTo(ev.margin.right, 9);
  });
});

// ---- 해결 가능성 (§8.2): 칸 안의 목표 자세 G에서 차로까지 빠져나온다. 거꾸로 돌리면 차로에서 칸으로 들어가는 길이다. ----

/** §8.2 실패 정책: 증명하지 못한 경우만 이유와 함께 적고 it.skip으로 건너뛴다. 모델 Y·쏘나타·쏘렌토는 넣지 않는다. */
const KNOWN_TIGHT: { vehicle: string; option: string; reason: string }[] = [];

/**
 * 계획용 세계: solid마다 외접 사각형을 MARGIN만큼 키운다 (연석은 그대로).
 * 여기서 poseClear를 통과하는 자세는 실제 세계에서도 통과하고(solid는 커지기만 함), 이웃 차·벽과 늘 MARGIN 이상 떨어진다.
 * 그래서 DS 간격 사이의 스침이 없고, 사람이 따라 할 만한 여유가 있는 길만 증명한다.
 */
const MARGIN = 0.1;
/** 막힌 자리에서 물러서는 원호 길이 */
const BACKOFF = 0.1;
/** 한 번 꺾어 움직이는 최대 거리 */
const STROKE_MAX = 3;
/** 빠져나가기 탐색 조각 */
const CH = 0.1;
/** 펴기를 끝내는 방향 */
const HDG_DONE = 2 * DEG;

/** G: 칸 앞뒤 가운데, 방향 0, 차체 왼쪽 면이 차로 쪽 선 바깥 가장자리 0.02 m 안 (타이어 ↔ 연석 여유가 가장 크다) */
function goalPose(sc: Scenario, spec: VehicleSpec): Pose {
  const r = sc.goal.rect;
  const mid = (spec.wheelbase + spec.frontOverhang - spec.rearOverhang) / 2;
  return { x: r.cx - mid, y: r.cy + r.halfW - 0.02 - spec.width / 2, heading: 0 };
}

/** 출발 통로: x [xMin + 0.3, xMax − 0.3], y [2.0 + lw/2, 7.0], 방향 0 */
const corridorOf = (sc: Scenario): ORect =>
  rectFromAabb(sc.bounds.x0 + 0.3, SLOT_W + lw / 2, sc.bounds.x1 - 0.3, SLOT_W + AISLE_W, 0);

function inflated(elements: WorldElement[]): WorldElement[] {
  return elements.map((e) => {
    if (e.kind !== 'solid') return e;
    const b = bbox(e.poly);
    return prepare({ ...e, poly: aabbRect(b.x0 - MARGIN, b.y0 - MARGIN, b.x1 + MARGIN, b.y1 + MARGIN) });
  });
}

const blocked = (moved: number) => Math.abs(moved) < CH - 1e-9;
/** d를 건드리지 않는 탐색용 사본 */
const probeOf = (d: Drive): Drive => startDrive(d.ctx, d.pose, d.steer);

/** 정지 상태에서 target 쪽으로 0.05씩 거부되기 전까지 돌린다 (연석 옆에서는 일부만 된다, §1.5) */
function steerStill(d: Drive, target: number): void {
  while (d.steer !== target) {
    const next = Math.abs(target - d.steer) <= 0.05 ? target : d.steer + Math.sign(target - d.steer) * 0.05;
    if (!setSteer(d, next)) return;
  }
}

/** target 쪽 끝까지 조향하며(정지 상태에서 되는 만큼, 나머지는 움직이며) dir로 막힐 때까지 가서 BACKOFF만큼 덜 간 자리에 선다 */
function stroke(d: Drive, target: 1 | -1, dir: 1 | -1): number {
  steerStill(d, target);
  const reach = Math.abs(moveSteering(probeOf(d), target, dir * STROKE_MAX));
  return moveSteering(d, target, dir * (reach < STROKE_MAX - 1e-9 ? Math.max(0, reach - BACKOFF) : reach));
}

/** 오른쪽 끝으로 돌며 방향이 HDG_DONE 이하가 될 때까지 전진하고, 곧게 최대 2 m 더 가며 통로에 들어가면 true */
function straighten(d: Drive, corridor: ORect): boolean {
  if (d.pose.heading > HDG_DONE) {
    steerStill(d, -1);
    for (let i = 0; i < 100 && d.pose.heading > HDG_DONE; i++) if (blocked(moveSteering(d, -1, CH))) return false;
  }
  steerStill(d, 0);
  for (let i = 0; i < 20; i++) {
    if (inRect(d.ctx.fp, d.pose, corridor, 20)) return true;
    if (blocked(moveSteering(d, 0, CH))) return false;
  }
  return inRect(d.ctx.fp, d.pose, corridor, 20);
}

/**
 * 지금 자리에서 빠져나가기를 사본으로 시험한다: 왼쪽 끝으로 돌며 CH씩 전진하다가, 끝까지 오른쪽으로 펴면 차체 오른쪽 면이
 * 통로 안에 들 만큼 나왔으면 펴기를 시험한다. 성공하는 가장 짧은 왼쪽 조각 수, 없으면 null.
 */
function findExit(d: Drive, corridor: ORect): number | null {
  const p = probeOf(d);
  const R = p.ctx.spec.wheelbase / Math.tan(p.ctx.maxSteer); // 끝까지 돌렸을 때 뒤축 중심 회전 반경
  steerStill(p, 1);
  for (let n = 1; n <= 60; n++) {
    if (blocked(moveSteering(p, 1, CH))) return null;
    const rightSide = p.pose.y + R * (1 - Math.cos(p.pose.heading)) - p.ctx.spec.width / 2;
    if (rightSide >= corridor.cy - corridor.halfW && straighten(probeOf(p), corridor)) return n;
  }
  return null;
}

/**
 * G → 통로: 뒤차에서 0.15 m까지 곧게 후진, 빠져나갈 수 있으면 나가고, 아니면 왼쪽 전진 · 오른쪽 후진을 한 번 더 한다.
 * 실제 움직임은 helpers/drive.ts의 startDrive·setSteer·moveUntilBlocked·moveSteering만 쓴다. 사본(probeOf)은 미리 보기용이고,
 * 같은 호출을 같은 순서로 하므로 실제 차도 사본과 똑같이 움직인다.
 */
function driveOut(sc: Scenario, spec: VehicleSpec): Drive {
  const corridor = corridorOf(sc);
  const d = startDrive(motionCtx(spec, inflated(sc.elements)), goalPose(sc, spec), 0);
  moveUntilBlocked(d, -1, STROKE_MAX, 0.15 - MARGIN);
  for (let i = 0; i < 6; i++) {
    const n = findExit(d, corridor);
    if (n !== null) {
      steerStill(d, 1);
      for (let k = 0; k < n; k++) moveSteering(d, 1, CH);
      straighten(d, corridor);
      break;
    }
    const f = stroke(d, 1, 1); // 왼쪽으로 앞차 앞까지
    const r = stroke(d, -1, -1); // 오른쪽으로 뒤차·연석 앞까지
    if (Math.abs(f) + Math.abs(r) < 0.05) break;
  }
  return d;
}

describe('해결 가능성 (§8.2): 칸에서 통로로 빠져나온다', () => {
  const cases = [
    ...PARALLEL_LENGTH_PRESETS.map((L) => ({ L, specs: allSpecs() })),
    // 5.8 m는 직접 입력 범위의 하한 (계획서 옵션 아님): 모델 Y만 필수
    { L: PARALLEL_LENGTH_RANGE.min, specs: allSpecs().filter((s) => s.id === MODEL_Y_2025.id) },
  ];
  for (const { L, specs } of cases) {
    const sc = buildParallel({ slotLength: L });
    const corridor = corridorOf(sc);
    for (const spec of specs) {
      const option = L.toFixed(1);
      const title = `${spec.id}, ${option} m`;
      const tight = KNOWN_TIGHT.find((k) => k.vehicle === spec.id && k.option === option);
      if (tight) {
        it.skip(`${title} (KNOWN_TIGHT: ${tight.reason})`, () => {});
        continue;
      }
      it(`${title}: 출발·G가 유효하고 G에서 통로까지 전환 12회 이하`, () => {
        const ctx = motionCtx(spec, sc.elements);
        expect(poseClear(ctx, sc.start, 0).kind).toBe('ok');
        expect(evaluateGoal(sc.goal, ctx.fp, sc.start).success).toBe(false);
        expect(inRect(ctx.fp, sc.start, corridor, 20)).toBe(true);

        const G = goalPose(sc, spec);
        expect(evaluateGoal(sc.goal, ctx.fp, G).success).toBe(true);
        expect(poseClear(ctx, G, 0).kind).toBe('ok');

        const d = driveOut(sc, spec);
        expect(inRect(ctx.fp, d.pose, corridor, 20)).toBe(true);
        expect(dirChanges(d)).toBeLessThanOrEqual(12);
        // 계획 세계가 더 보수적이므로 당연하지만, 실제 요소로도 충돌이 없는지 확인한다
        expect(d.path.every((p) => findCollision(ctx.fp, p, sc.elements) === null)).toBe(true);
      });
    }
  }
});
