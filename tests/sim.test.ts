import { describe, expect, it } from 'vitest';
import { MODEL_Y_2025 as SPEC } from '../src/sim/specs';
import { buildFootprint, wheelPolys } from '../src/sim/footprint';
import { integratePose, initialState, maxSteerAngle, updateSpeed } from '../src/sim/vehicle';
import { type Pose, type Vec2, toWorld } from '../src/sim/geometry';
import { findCollision, findWheelBlock, prepare, type WorldElement } from '../src/sim/world';
import { readSensors } from '../src/sim/sensors';
import { evaluateGoal } from '../src/sim/goal';
import { buildRearPerpendicular, LINE_WIDTH } from '../src/scenarios/rearPerpendicular';
import { aabbRect } from '../src/sim/geometry';

function extents(poly: Vec2[]) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { dx: Math.max(...xs) - Math.min(...xs), dy: Math.max(...ys) - Math.min(...ys) };
}

describe('제원과 외곽 형상', () => {
  it('오버행 + 축거 = 전장', () => {
    expect(SPEC.rearOverhang + SPEC.wheelbase + SPEC.frontOverhang).toBeCloseTo(SPEC.length, 6);
  });

  it('차체 외곽은 4,790 × 1,920 mm, 미러 포함 폭은 2,129 mm', () => {
    const fp = buildFootprint(SPEC);
    const b = extents(fp.body.poly);
    expect(b.dx).toBeCloseTo(4.79, 6);
    expect(b.dy).toBeCloseTo(1.92, 6);
    const all = extents([...fp.body.poly, ...fp.mirrorLeft.poly, ...fp.mirrorRight.poly]);
    expect(all.dy).toBeCloseTo(2.129, 6);
  });
});

describe('차량 운동', () => {
  it('최대 조향각 ≈ 33.4°', () => {
    expect((maxSteerAngle(SPEC) * 180) / Math.PI).toBeCloseTo(33.4, 1);
  });

  // 적분기와 δmax 유도가 서로 맞는지만 확인한다 (실제 차와 같다는 증명은 아님).
  it('최대 조향으로 돌면 바깥 앞타이어 외곽 궤적 직경이 12.13 m ± 1%', () => {
    let s = initialState(0, 0, 0);
    const outer = { x: SPEC.wheelbase, y: -(SPEC.trackFront / 2 + SPEC.tireWidth / 2) }; // 좌회전 시 오른쪽이 바깥
    const pts: Vec2[] = [];
    for (let i = 0; i < 60 * 60; i++) {
      const p = integratePose(s, SPEC, 1, 1, 1 / 60);
      s = { ...s, ...p };
      pts.push(toWorld(outer, s));
    }
    let maxD = 0;
    for (let i = 0; i < pts.length; i += 7) {
      for (let j = i + 1; j < pts.length; j += 7) {
        maxD = Math.max(maxD, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
      }
    }
    expect(Math.abs(maxD - 12.13) / 12.13).toBeLessThan(0.01);
  });

  it('D에서 페달 없이 크리프로 서서히 전진, 브레이크를 밟으면 정지 유지', () => {
    let s = { ...initialState(0, 0, 0), gear: 'D' as const };
    for (let i = 0; i < 300; i++) s = { ...s, speed: updateSpeed(s, { throttle: 0, brake: 0, steer: 0 }, 1 / 60) };
    expect(s.speed).toBeGreaterThan(0.5);
    expect(s.speed).toBeLessThan(1.0);
    for (let i = 0; i < 120; i++) s = { ...s, speed: updateSpeed(s, { throttle: 0, brake: 1, steer: 0 }, 1 / 60) };
    expect(s.speed).toBe(0);
  });
});

/** 목표 칸 중앙에 후면 주차된 자세 (앞이 통로 쪽) */
function parkedPose(slotWidth: number): { pose: Pose; sc: ReturnType<typeof buildRearPerpendicular> } {
  const sc = buildRearPerpendicular({ slotWidth, target: 'between' });
  const r = sc.goal.rect;
  // 뒤범퍼를 칸 뒷선 안쪽 0.1 m에 둔다 (안쪽 길이 4.925 m − 4.79 m = 여유 0.135 m).
  // 목표 rect의 뒤 경계는 뒷선 바깥 가장자리(v1보다 0.15 m 깊음)이므로 거기서 0.25 m 안 = 4.825 (5.0 m 칸).
  // heading -90°이므로 뒤축은 뒤범퍼에서 rearOverhang만큼 통로 쪽.
  const rearBumperY = r.cy + r.halfL - 0.25;
  return { pose: { x: r.cx, y: rearBumperY - SPEC.rearOverhang, heading: -Math.PI / 2 }, sc };
}

describe('주차선 여유 거리 (2.5 m 칸, 라인 중심 간, 라인 폭 0.15 m)', () => {
  it('차체 21.5 cm, 미러 11.05 cm (±0.5 cm)', () => {
    const { pose, sc } = parkedPose(2.5);
    const r = readSensors(buildFootprint(SPEC), pose, sc.elements);
    const bodyGap = (2.5 - LINE_WIDTH - SPEC.width) / 2;
    const mirrorGap = (2.5 - LINE_WIDTH - SPEC.widthMirrors) / 2;
    expect(bodyGap).toBeCloseTo(0.215, 6);
    expect(mirrorGap).toBeCloseTo(0.1105, 6);
    for (const v of [r.lines.leftBody, r.lines.rightBody]) expect(Math.abs(v! - 0.215)).toBeLessThan(0.005);
    for (const v of [r.lines.leftMirror, r.lines.rightMirror]) expect(Math.abs(v! - 0.1105)).toBeLessThan(0.005);
  });

  it('중앙 정렬 자세는 칸 안으로 판정되고 충돌·휠스톱 걸림이 없다', () => {
    const { pose, sc } = parkedPose(2.5);
    const fp = buildFootprint(SPEC);
    expect(evaluateGoal(sc.goal, fp, pose).success).toBe(true);
    expect(findCollision(fp, pose, sc.elements)).toBeNull();
    expect(findWheelBlock(SPEC, pose, 0, sc.elements)).toBeNull();
  });
});

describe('충돌 판정', () => {
  const fp = buildFootprint(SPEC);
  const pose: Pose = { x: 0, y: 0, heading: 0 };
  const el = (e: Omit<WorldElement, 'id'>): WorldElement => prepare({ ...e, id: 't' });

  it('미러가 기둥에 겹치면 미러 충돌', () => {
    // 왼쪽 미러(y 0.86~1.0645, x 2.12~2.3)만 걸치는 기둥
    const pillar = el({ kind: 'solid', tag: 'pillar', poly: aabbRect(2.0, 1.0, 2.8, 1.8), hMin: 0, hMax: 2.7 });
    expect(findCollision(fp, pose, [pillar])?.part).toBe('mirrorLeft');
  });

  it('미러 높이보다 낮은 장애물은 미러와 충돌하지 않는다', () => {
    const low = el({ kind: 'solid', poly: aabbRect(2.0, 1.0, 2.8, 1.8), hMin: 0, hMax: 0.5 });
    expect(findCollision(fp, pose, [low])).toBeNull();
  });

  it('뒤 오버행이 휠스톱 위를 지나가면 충돌도 걸림도 아니다', () => {
    // 뒤축(x=0)보다 뒤, 뒤범퍼(x=-1.011) 안쪽에 휠스톱
    const stop = el({ kind: 'wheelStop', poly: aabbRect(-0.8, 0.35, -0.65, 0.85), hMin: 0, hMax: 0.12 });
    expect(findCollision(fp, pose, [stop])).toBeNull();
    expect(findWheelBlock(SPEC, pose, 0, [stop])).toBeNull();
  });

  it('바퀴가 휠스톱에 닿으면 걸림', () => {
    const stop = el({ kind: 'wheelStop', poly: aabbRect(-0.45, 0.35, -0.3, 0.85), hMin: 0, hMax: 0.12 });
    expect(findWheelBlock(SPEC, pose, 0, [stop])?.wheel).toBe('RL');
  });

  it('주차선을 밟아도 충돌이 아니다', () => {
    const line = el({ kind: 'line', poly: aabbRect(-2, -0.075, 5, 0.075), hMin: 0, hMax: 0.003, dir: 0 });
    expect(findCollision(fp, pose, [line])).toBeNull();
  });

  it('바퀴 형상은 휠베이스·윤거 위치에 있다', () => {
    const w = wheelPolys(SPEC, 0);
    const c = (p: Vec2[]) => ({ x: p.reduce((a, q) => a + q.x, 0) / 4, y: p.reduce((a, q) => a + q.y, 0) / 4 });
    expect(c(w.FL).x).toBeCloseTo(SPEC.wheelbase, 6);
    expect(c(w.RR).y).toBeCloseTo(-SPEC.trackRear / 2, 6);
  });
});

describe('시나리오', () => {
  for (const slotWidth of [2.3, 2.5, 2.6]) {
    for (const target of ['between', 'pillar'] as const) {
      it(`출발 위치는 충돌 없음 (칸 ${slotWidth} m, ${target})`, () => {
        const sc = buildRearPerpendicular({ slotWidth, target });
        expect(findCollision(buildFootprint(SPEC), sc.start, sc.elements)).toBeNull();
        expect(2 * sc.goal.rect.halfW).toBeCloseTo(slotWidth - LINE_WIDTH, 6);
      });
    }
  }
});
