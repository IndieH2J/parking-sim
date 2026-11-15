import { describe, expect, it } from 'vitest';
import { buildFrontPerpendicular } from '../src/scenarios/frontPerpendicular';
import { buildNarrowRamp, rampLaneWidths, rampSweep } from '../src/scenarios/narrowRamp';
import { buildParallel } from '../src/scenarios/parallel';
import { AISLE, buildRearPerpendicular } from '../src/scenarios/rearPerpendicular';
import type { Scenario } from '../src/scenarios/types';
import { CHASE_MAX_H, CHASE_OFFSETS, chaseEye, chaseTargets, type Vec3 } from '../src/sim/chaseEye';
import { bodyExtents, buildFootprint } from '../src/sim/footprint';
import { aabbRect, pointInConvex, pointSegmentDistance, polyToWorld, type Pose } from '../src/sim/geometry';
import { evaluateGoal, rectFromAabb } from '../src/sim/goal';
import { motionCtx, poseClear } from '../src/sim/motion';
import { MODEL_Y_2025, type VehicleSpec } from '../src/sim/specs';
import { CUSTOM_ID, DEFAULT_CUSTOM_DIMS, getSpec, listVehicles } from '../src/sim/vehicles';
import { findCollision, prepare, type WorldElement } from '../src/sim/world';
import { inRect, move, setSteer, startDrive } from './helpers/drive';

// 추적 카메라 시선 확보 (계약서 §5.3, Amendments 2026-11-15). 시나리오 빌더는 직접 import한다 (§A.5).

/** 독립 판정: 눈 → 점 선분을 2 cm 이하 간격으로 나눠, 표본이 solid 평면도 안이고 높이가 (hMin, hMax) 사이면 막힘.
 *  helper의 구간 계산을 쓰지 않는다. 점이 평면도 안에 든 solid는 그 점에 대해 빼고 본다 (helper 규칙: 그 겉면이 보임). */
function blocker(eye: Vec3, p: Vec3, elements: readonly WorldElement[]): WorldElement | null {
  const n = Math.max(2, Math.ceil(Math.hypot(p.x - eye.x, p.y - eye.y, p.h - eye.h) / 0.02));
  for (const el of elements) {
    if (el.kind !== 'solid' || pointInConvex(p, el.poly)) continue;
    if (pointSegmentDistance(el.bc!, eye, p) > el.br! + 1e-6) continue; // 평면도에서 선분이 외접원에 닿지 않음
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const q = { x: eye.x + t * (p.x - eye.x), y: eye.y + t * (p.y - eye.y), h: eye.h + t * (p.h - eye.h) };
      if (q.h > el.hMin && q.h < el.hMax && pointInConvex(q, el.poly)) return el;
    }
  }
  return null;
}

/** 시선이 막힌 점 (바라볼 점·지붕 모서리) 목록. 비면 모두 보인다 */
function blockedTargets(pose: Pose, spec: VehicleSpec, eye: Vec3, elements: readonly WorldElement[]): string[] {
  const { look, roof } = chaseTargets(pose, spec);
  const named = [{ name: 'look', p: look }, ...roof.map((p, i) => ({ name: `roof${i}`, p }))];
  return named.flatMap(({ name, p }) => {
    const el = blocker(eye, p, elements);
    return el ? [`${name} by ${el.tag} ${el.id}`] : [];
  });
}

/** 계약 눈 (§5.3), ChaseCam이 예전에 계산하던 순서 그대로 */
function nominal(pose: Pose, spec: VehicleSpec): { eye: Vec3; look: Vec3 } {
  const c = Math.cos(pose.heading);
  const s = Math.sin(pose.heading);
  const { xr, xf } = bodyExtents(spec);
  const centre = (xr + xf) / 2;
  const bx = pose.x + c * centre;
  const by = pose.y + s * centre;
  return { eye: { x: bx - c * 5.5, y: by - s * 5.5, h: 2.8 }, look: { x: bx + c * 2, y: by + s * 2, h: 0.6 } };
}

/** __sim.goalPose와 같은 규칙: 차체 중심 = 목표 사각형 중심, 방향 = rect.angle */
function goalPose(sc: Scenario, spec: VehicleSpec): Pose {
  const r = sc.goal.rect;
  const bc = (spec.wheelbase + spec.frontOverhang - spec.rearOverhang) / 2;
  return { x: r.cx - bc * Math.cos(r.angle), y: r.cy - bc * Math.sin(r.angle), heading: r.angle };
}

/**
 * 후면 직각 해결 가능성 경로 (tests/rearPerpendicular.test.ts와 같은 방법): 뒤로 넣은 자세 G(뒷바퀴가 휠스톱 면 0.03 m 앞)에서
 * s0 m 직진 후 왼쪽 끝 조향으로 통로까지. 거꾸로 돌리면 뒤로 넣는 길이다. 10번째 자세마다 (G 포함).
 */
function rearPerpPath(sc: Scenario, spec: VehicleSpec): Pose[] {
  const ctx = motionCtx(spec, sc.elements);
  const r = sc.goal.rect;
  const stops = sc.elements.filter((e) => e.kind === 'wheelStop' && e.bc!.y > 0 && Math.abs(e.bc!.x - r.cx) < r.halfW);
  const face = Math.min(...stops.flatMap((e) => e.poly.map((p) => p.y)));
  const G: Pose = { x: r.cx, y: face - 0.03 - spec.tireDiameter / 2, heading: -Math.PI / 2 };
  const corridor = rectFromAabb(sc.bounds.x0 + 0.3, -AISLE, sc.bounds.x1 - 0.3, 0, 0);
  const arc = Math.PI / 2 / (Math.tan(ctx.maxSteer) / spec.wheelbase);
  for (let i = 0; i <= 40; i++) {
    const d = startDrive(ctx, G);
    if (move(d, i / 10) < i / 10 - 1e-9 || !setSteer(d, 1) || move(d, arc) < arc - 1e-9) continue;
    if (inRect(ctx.fp, d.pose, corridor, 20)) return d.path.filter((_, k) => k % 10 === 0);
  }
  throw new Error(`no rearPerp drive-out for ${spec.id}`);
}

/** 램프 곡선 가운데 자세 (§1.8.4 배치): 뒤축이 정상 선회 반경 rr, 방향은 접선 */
function rampCurvePoses(spec: VehicleSpec, Ri: number): { name: string; pose: Pose }[] {
  const Ws = rampLaneWidths(spec, Ri).straight;
  const rr = rampSweep(spec, Ri).rr;
  const c1 = { x: 12, y: Ws / 2 + Ri }; // 왼쪽 180°: 중심 방향 −90° → 90°
  const c2 = { x: 4, y: Ws / 2 + 2 * Ri + Ws + Ri }; // 오른쪽 90°: −90° → −180°
  const on = (c: { x: number; y: number }, a: number, heading: number): Pose => ({
    x: c.x + rr * Math.cos(a),
    y: c.y + rr * Math.sin(a),
    heading,
  });
  return [
    { name: 'mid-C1', pose: on(c1, 0, Math.PI / 2) },
    { name: 'mid-C2', pose: on(c2, (-3 * Math.PI) / 4, (3 * Math.PI) / 4) },
  ];
}

interface Case {
  name: string;
  sc: Scenario;
  poses: { name: string; pose: Pose }[];
}

/** 각 종류의 기본 옵션 (src/ui/settings.ts DEFAULT_SETTINGS: 직각 2.5 m·차 사이, 평행 6.0 m, 램프 6 m) + 램프 5 m */
function cases(spec: VehicleSpec): Case[] {
  const perp = { slotWidth: 2.5, target: 'between' as const };
  const rear = buildRearPerpendicular(perp);
  const front = buildFrontPerpendicular(perp);
  const par = buildParallel({ slotLength: 6.0 });
  const basic = (sc: Scenario) => [
    { name: 'start', pose: sc.start },
    { name: 'goalPose', pose: goalPose(sc, spec) },
  ];
  const out: Case[] = [
    {
      name: 'rearPerp',
      sc: rear,
      poses: [
        ...basic(rear),
        ...rearPerpPath(rear, spec).map((pose, i) => ({ name: `path ${i}`, pose })),
        // 휠스톱 없는 2.7 m 벽에 뒤범퍼를 1 cm까지 댄 자세 (통로 서쪽 끝벽): 가장 높이 올려야 하는 경우
        { name: 'rear 1 cm from the west end wall', pose: { x: rear.bounds.x0 + 0.3 + 0.01 + spec.rearOverhang, y: -AISLE / 2, heading: 0 } },
      ],
    },
    { name: 'frontPerp', sc: front, poses: basic(front) },
    { name: 'parallel', sc: par, poses: basic(par) },
  ];
  for (const Ri of [6, 5]) {
    const sc = buildNarrowRamp({ innerRadius: Ri }, spec);
    out.push({ name: `ramp R${Ri}`, sc, poses: [...basic(sc), ...rampCurvePoses(spec, Ri)] });
  }
  return out;
}

const smallest = listVehicles()
  .map((v) => v.spec)
  .reduce((a, b) => (b.length < a.length ? b : a));
const TALL = getSpec(CUSTOM_ID, { ...DEFAULT_CUSTOM_DIMS, heightMm: 2200 });

describe('chaseEye: 빈 공간에서는 계약 눈 그대로 (§5.3)', () => {
  const poses: Pose[] = [
    { x: 0, y: 0, heading: 0 },
    { x: 3.7, y: -2.2, heading: 1.1 },
    { x: -12.5, y: 40.25, heading: -2.9 },
    { x: 7, y: 7, heading: Math.PI },
  ];
  it('요소가 없으면 눈·바라볼 점이 계약 값과 비트 단위로 같다', () => {
    for (const spec of [MODEL_Y_2025, smallest, TALL]) {
      for (const pose of poses) {
        const got = chaseEye(pose, spec, []);
        const want = nominal(pose, spec);
        for (const k of ['x', 'y', 'h'] as const) {
          expect(got.eye[k]).toBe(want.eye[k]);
          expect(got.look[k]).toBe(want.look[k]);
        }
      }
    }
  });

  it('solid가 아닌 요소(선·휠스톱)는 시선을 막지 않는다', () => {
    const sc = buildRearPerpendicular({ slotWidth: 2.5, target: 'between' });
    const pose = goalPose(sc, MODEL_Y_2025);
    expect(chaseEye(pose, MODEL_Y_2025, sc.elements.filter((e) => e.kind !== 'solid'))).toEqual(nominal(pose, MODEL_Y_2025));
  });

  it('CHASE_OFFSETS는 계약 수치', () => {
    expect(CHASE_OFFSETS).toEqual({ behind: 5.5, height: 2.8, ahead: 2, lookH: 0.6 });
  });

  it('다른 수치를 넘기면 그 수치 그대로 (빈 공간)', () => {
    const pose = { x: 3.7, y: -2.2, heading: 1.1 };
    const { xr, xf } = bodyExtents(MODEL_Y_2025);
    const c = Math.cos(pose.heading);
    const s = Math.sin(pose.heading);
    const bx = pose.x + c * ((xr + xf) / 2);
    const by = pose.y + s * ((xr + xf) / 2);
    const got = chaseEye(pose, MODEL_Y_2025, [], { behind: 4, height: 3.5, ahead: 1, lookH: 0.8 });
    expect(got).toEqual({ eye: { x: bx - c * 4, y: by - s * 4, h: 3.5 }, look: { x: bx + c * 1, y: by + s * 1, h: 0.8 } });
  });
});

describe('지붕 점', () => {
  it('네 점 모두 차체 평면도 안, 높이 = 전고, 뒤 두 점·앞 두 점', () => {
    for (const spec of [MODEL_Y_2025, smallest, TALL]) {
      const pose = { x: 1, y: 2, heading: 0.7 };
      const { roof } = chaseTargets(pose, spec);
      const body = polyToWorld(buildFootprint(spec).body.poly, pose);
      expect(roof).toHaveLength(4);
      for (const p of roof) {
        expect(pointInConvex(p, body)).toBe(true);
        expect(p.h).toBe(spec.height);
      }
      // 차 앞쪽 거리: 뒤 두 점 < 앞 두 점, 좌우 대칭
      const along = roof.map((p) => (p.x - pose.x) * Math.cos(pose.heading) + (p.y - pose.y) * Math.sin(pose.heading));
      expect(along[0]).toBeCloseTo(along[1], 9);
      expect(along[2]).toBeCloseTo(along[3], 9);
      expect(along[2] - along[0]).toBeGreaterThan(spec.length / 2);
    }
  });
});

describe('후면 직각 뒤로 넣은 자세: 계약 눈은 뒷벽에 막히고, 올린 눈은 보인다 (v3-replay 알려진 문제)', () => {
  const sc = buildRearPerpendicular({ slotWidth: 2.5, target: 'between' });
  const pose = goalPose(sc, MODEL_Y_2025);

  it('계약 눈에서는 지붕 뒤 모서리가 뒷벽에 가린다 (판정이 실제로 막힘을 잡는지 확인)', () => {
    const blocked = blockedTargets(pose, MODEL_Y_2025, nominal(pose, MODEL_Y_2025).eye, sc.elements);
    expect(blocked.some((b) => b.includes('by wall'))).toBe(true);
  });

  it('chaseEye는 같은 수평 거리 5.5 m에서 눈만 올린다 (상한 안)', () => {
    const { eye } = chaseEye(pose, MODEL_Y_2025, sc.elements);
    const n = nominal(pose, MODEL_Y_2025).eye;
    expect(eye.x).toBeCloseTo(n.x, 9);
    expect(eye.y).toBeCloseTo(n.y, 9);
    expect(eye.h).toBeGreaterThan(2.8);
    expect(eye.h).toBeLessThanOrEqual(CHASE_MAX_H);
    expect(blockedTargets(pose, MODEL_Y_2025, eye, sc.elements)).toEqual([]);
  });
});

describe('올려도 안 되면 수평 거리를 줄인다', () => {
  const spec = MODEL_Y_2025;
  const pose = { x: 0, y: 0, heading: 0 };
  const { xr } = bodyExtents(spec);

  it('뒤범퍼 1 m 뒤에 상한보다 높은 벽: 눈이 벽 앞(차 쪽)으로 와서 모두 보인다', () => {
    const wall = prepare({ id: 'tall', kind: 'solid', tag: 'wall', poly: aabbRect(xr - 1.3, -4, xr - 1.0, 4), hMin: 0, hMax: 20 });
    const { eye, look } = chaseEye(pose, spec, [wall]);
    expect(eye.x).toBeGreaterThan(xr - 1.0); // 벽 앞면보다 차 쪽
    expect(eye.y).toBeCloseTo(0, 9); // 차 축 위 그대로
    expect(eye.h).toBeGreaterThanOrEqual(2.8);
    expect(look).toEqual(nominal(pose, spec).look);
    expect(blockedTargets(pose, spec, eye, [wall])).toEqual([]);
  });

  it('차체를 가로지르는 높은 solid (겹친 자세): 차체 중심 위 상한 높이로 끝난다', () => {
    const { centre } = chaseTargets(pose, spec);
    const slab = prepare({ id: 'slab', kind: 'solid', tag: 'wall', poly: aabbRect(centre.x - 0.1, -4, centre.x + 0.1, 4), hMin: 0, hMax: 20 });
    expect(chaseEye(pose, spec, [slab]).eye).toEqual({ x: centre.x, y: centre.y, h: CHASE_MAX_H });
  });
});

describe('시선 확보: 네 종류 기본 옵션 + 램프 5 m, 출발·목표·경로·곡선 가운데 자세', () => {
  for (const spec of [MODEL_Y_2025, smallest, TALL]) {
    const label = spec.id === CUSTOM_ID ? 'custom 2.2 m tall' : spec.id;
    it(`${label}: 차종 확인`, () => {
      if (spec === TALL) {
        expect(spec.id).toBe(CUSTOM_ID); // 잘못된 직접 입력은 모델 Y로 바뀐다
        expect(spec.height).toBe(2.2);
      } else if (spec === smallest) {
        expect(spec.id).toBe('morning');
      }
    });
    for (const c of cases(spec)) {
      it(`${label} ${c.name}`, () => {
        const fp = buildFootprint(spec);
        const ctx = motionCtx(spec, c.sc.elements);
        for (const { name, pose } of c.poses) {
          const where = `${c.name} ${name}`;
          // 실제로 있을 수 있는 자세 (차체·미러가 solid와 겹치지 않음). 만든 자세는 바퀴까지 막히지 않음
          expect(findCollision(fp, pose, c.sc.elements), where).toBeNull();
          if (name !== 'goalPose') expect(poseClear(ctx, pose, 0).kind, where).toBe('ok');
          if (c.name.startsWith('ramp') && name === 'goalPose') expect(evaluateGoal(c.sc.goal, fp, pose).success, where).toBe(true);

          const { eye, look } = chaseEye(pose, spec, c.sc.elements);
          expect(look, where).toEqual(nominal(pose, spec).look);
          expect(eye.h, where).toBeGreaterThanOrEqual(2.8);
          expect(eye.h, where).toBeLessThanOrEqual(CHASE_MAX_H);
          // 눈은 차체 중심 뒤 축 위, 수평 거리 0..5.5 m
          const { centre } = chaseTargets(pose, spec);
          const vx = eye.x - centre.x;
          const vy = eye.y - centre.y;
          const ch = Math.cos(pose.heading);
          const sh = Math.sin(pose.heading);
          expect(Math.abs(-vx * sh + vy * ch), where).toBeLessThan(1e-9);
          expect(-(vx * ch + vy * sh), where).toBeGreaterThanOrEqual(-1e-9);
          expect(-(vx * ch + vy * sh), where).toBeLessThanOrEqual(5.5 + 1e-9);
          expect(blockedTargets(pose, spec, eye, c.sc.elements), where).toEqual([]);
        }
      });
    }
  }
});
