import { describe, expect, it } from 'vitest';
import { MODEL_Y_2025 as SPEC } from '../src/sim/specs';
import { buildFootprint, wheelPolys } from '../src/sim/footprint';
import {
  canShift,
  integratePose,
  initialState,
  MAX_SPEED,
  maxSteerAngle,
  pedalStep,
  updateSpeed,
  type VehicleState,
} from '../src/sim/vehicle';
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

  it('정지 상태에서 D·R에 넣고 페달 없이 5초: 속도 0, 자세 그대로', () => {
    for (const gear of ['D', 'R'] as const) {
      let s = { ...initialState(1, 2, 0.5), gear };
      for (let i = 0; i < 300; i++) {
        s = { ...s, speed: updateSpeed(s, { throttle: 0, brake: 0, steer: 0 }, 1 / 60) };
        s = { ...s, ...integratePose(s, SPEC, s.steer, s.speed, 1 / 60) };
        expect(s.speed, gear).toBe(0);
      }
      expect({ x: s.x, y: s.y, heading: s.heading }, gear).toEqual({ x: 1, y: 2, heading: 0.5 });
    }
  });

  const HOLD = 2.0; // vehicle.ts HOLD_DECEL (m/s², 추정값). 바꾸면 여기도 바꾼다.

  it('D·R에서 가속 페달을 1초 밟았다 떼면 2 m/s²로 줄어 정확히 0에서 서고 그대로 선다 (부호가 바뀌지 않음)', () => {
    const dt = 1 / 60;
    for (const [gear, sign] of [['D', 1], ['R', -1]] as const) {
      let s = { ...initialState(0, 0, 0), gear };
      for (let i = 0; i < 60; i++) s = { ...s, speed: updateSpeed(s, { throttle: 1, brake: 0, steer: 0 }, dt) };
      const v0 = s.speed;
      expect(v0 * sign, gear).toBe(MAX_SPEED); // 1초면 상한(5 km/h)에 이른다
      const speeds: number[] = [];
      for (let i = 0; i < 8 * 60; i++) {
        s = { ...s, speed: updateSpeed(s, { throttle: 0, brake: 0, steer: 0 }, dt) };
        speeds.push(s.speed);
      }
      const stop = speeds.indexOf(0); // 처음 0이 된 스텝
      expect(stop, gear).toBeGreaterThan(0);
      // 멈출 때까지 스텝마다 HOLD·dt씩 준다 (0.5초에 1 m/s. 상한에서는 약 0.69초 만에 선다)
      for (let i = 0; i < stop; i++) expect(((i === 0 ? v0 : speeds[i - 1]) - speeds[i]) * sign, gear).toBeCloseTo(HOLD * dt, 9);
      expect((v0 - speeds[29]) * sign, gear).toBeCloseTo(HOLD / 2, 9);
      // 멈추는 데 걸리는 시간 = |v0| / HOLD (한 스텝 안)
      expect(Math.abs((stop + 1) * dt - (v0 * sign) / HOLD), gear).toBeLessThan(dt);
      // 정확히 0에서 서고, 남은 5초 넘게 그대로이며, 반대 부호로 넘어가지 않는다
      expect(speeds[stop], gear).toBe(0);
      expect(speeds.length - stop, gear).toBeGreaterThan(5 * 60);
      expect(speeds.slice(stop).every((v) => v === 0), gear).toBe(true);
      expect(speeds.every((v) => v * sign >= 0), gear).toBe(true);
    }
  });

  it('굴러가는 방향과 반대 기어(앞으로 1 m/s에서 R, 뒤로 1 m/s에서 D)에 페달 없이: 0까지 줄어 서고 반대로 출발하지 않는다', () => {
    const dt = 1 / 60;
    for (const [gear, v0] of [['R', 1], ['D', -1]] as const) {
      // 변속은 2 m/s 이하에서 허용된다 (canShift)
      let s: VehicleState = { ...initialState(0, 0, 0), gear, speed: v0 };
      const speeds: number[] = [];
      for (let i = 0; i < 300; i++) {
        s = { ...s, speed: updateSpeed(s, { throttle: 0, brake: 0, steer: 0 }, dt) };
        speeds.push(s.speed);
      }
      // 기어 방향이 아니라 실제 속도의 반대로 HOLD만큼 준다: 1 m/s ÷ 2 m/s² = 0.5초 (30 스텝)
      const stop = speeds.indexOf(0);
      expect(stop, gear).toBeGreaterThanOrEqual(29);
      expect(stop, gear).toBeLessThanOrEqual(30);
      expect(speeds.slice(stop).every((v) => v === 0), gear).toBe(true);
      expect(speeds.every((v) => v * v0 >= 0), gear).toBe(true);
    }
  });

  it('D·R에서 가속 없이 브레이크를 밟으면 스텝마다 (6·brake + 2)·dt씩 줄어 정확히 0에서 서고 그대로 선다', () => {
    const dt = 1 / 60;
    for (const [gear, v0] of [['D', 1], ['R', -1]] as const) {
      for (const brake of [0.5, 1]) {
        let s: VehicleState = { ...initialState(0, 0, 0), gear, speed: v0 };
        const speeds: number[] = [];
        for (let i = 0; i < 120; i++) {
          s = { ...s, speed: updateSpeed(s, { throttle: 0, brake, steer: 0 }, dt) };
          speeds.push(s.speed);
        }
        const stop = speeds.indexOf(0);
        expect(stop, `${gear} ${brake}`).toBeGreaterThan(0);
        for (let i = 0; i < stop; i++)
          expect(Math.abs(i === 0 ? v0 : speeds[i - 1]) - Math.abs(speeds[i]), `${gear} ${brake}`).toBeCloseTo((6 * brake + HOLD) * dt, 9);
        expect(speeds.slice(stop).every((v) => v === 0), `${gear} ${brake}`).toBe(true);
        expect(speeds.every((v) => v * v0 >= 0), `${gear} ${brake}`).toBe(true);
      }
    }
  });

  it('N은 페달 없이 구름저항(0.25 m/s²)으로 굴러가고, P는 0', () => {
    for (const v0 of [1, -1]) {
      let s: VehicleState = { ...initialState(0, 0, 0), gear: 'N', speed: v0 };
      for (let i = 0; i < 60; i++) s = { ...s, speed: updateSpeed(s, { throttle: 0, brake: 0, steer: 0 }, 1 / 60) };
      expect(s.speed).toBeCloseTo(0.75 * v0, 9);
    }
    const p: VehicleState = { ...initialState(0, 0, 0), gear: 'P', speed: 1 };
    expect(updateSpeed(p, { throttle: 0, brake: 0, steer: 0 }, 1 / 60)).toBe(0);
    expect(updateSpeed(p, { throttle: 1, brake: 0, steer: 0 }, 1 / 60)).toBe(0);
  });
});

describe('속도 상한 (계약서 개정 2026-11-16 controls)', () => {
  it('MAX_SPEED = 5 km/h', () => {
    expect(MAX_SPEED).toBe(5 / 3.6);
  });

  it('D·R에서 가속 페달을 3초 끝까지 밟으면 정확히 상한에 이르고 넘지 않는다 (R은 −MAX_SPEED)', () => {
    const dt = 1 / 60;
    for (const [gear, sign] of [['D', 1], ['R', -1]] as const) {
      let s: VehicleState = { ...initialState(0, 0, 0), gear };
      for (let i = 0; i < 3 * 60; i++) {
        s = { ...s, speed: updateSpeed(s, { throttle: 1, brake: 0, steer: 0 }, dt) };
        expect(s.speed * sign, `${gear} ${i}`).toBeLessThanOrEqual(MAX_SPEED);
      }
      expect(s.speed, gear).toBe(sign * MAX_SPEED);
    }
  });

  it('상한 속도(±MAX_SPEED)에서도 변속할 수 있다 (상한 < 2 m/s라 canShift가 거부하지 않는다)', () => {
    expect(canShift({ ...initialState(0, 0, 0), gear: 'D', speed: MAX_SPEED })).toBe(true);
    expect(canShift({ ...initialState(0, 0, 0), gear: 'R', speed: -MAX_SPEED })).toBe(true);
  });
});

describe('pedalStep: 페달 값 램프 (main.ts에서 옮김, 계약서 개정 2026-11-16 controls)', () => {
  const dt = 1 / 60;

  it('가속: 누르는 동안 스텝마다 0.8·dt씩 올라 정확히 1에서 멈추고, 떼면 어느 값에서든 바로 정확히 0', () => {
    let th = 0;
    const seq: number[] = [];
    for (let i = 0; i < 90; i++) {
      th = pedalStep(th, 0, true, false, dt).throttle;
      seq.push(th);
    }
    // 0.8/s라 1까지 1.25초 = 75 스텝 (누적 오차로 한 스텝 어긋날 수 있다)
    const full = seq.indexOf(1);
    expect(full).toBeGreaterThanOrEqual(74);
    expect(full).toBeLessThanOrEqual(75);
    for (let i = 0; i < full; i++) expect(seq[i] - (i === 0 ? 0 : seq[i - 1]), `${i}`).toBeCloseTo(0.8 * dt, 12);
    expect(seq.slice(full).every((v) => v === 1)).toBe(true);
    for (const v of [1, 0.5, 0.8 * dt]) {
      expect(pedalStep(v, 0, false, false, dt).throttle, `${v}`).toBe(0);
      expect(pedalStep(v, 0, false, true, dt).throttle, `${v}`).toBe(0);
    }
  });

  it('브레이크: 밟으면 스텝마다 3·dt씩 1까지, 떼면 6·dt씩 0까지 오가며 끝값에서 정확히 멈춘다', () => {
    let b = 0;
    const on: number[] = [];
    for (let i = 0; i < 40; i++) {
      b = pedalStep(0, b, false, true, dt).brake;
      on.push(b);
    }
    const full = on.indexOf(1); // 1초에 3 → 20 스텝
    expect(full).toBeGreaterThanOrEqual(19);
    expect(full).toBeLessThanOrEqual(20);
    for (let i = 0; i < full; i++) expect(on[i] - (i === 0 ? 0 : on[i - 1]), `${i}`).toBeCloseTo(3 * dt, 12);
    expect(on.slice(full).every((v) => v === 1)).toBe(true);
    const off: number[] = [];
    for (let i = 0; i < 20; i++) {
      b = pedalStep(0, b, false, false, dt).brake;
      off.push(b);
    }
    const zero = off.indexOf(0); // 1초에 6 → 10 스텝
    expect(zero).toBeGreaterThanOrEqual(9);
    expect(zero).toBeLessThanOrEqual(10);
    for (let i = 0; i < zero; i++) expect((i === 0 ? 1 : off[i - 1]) - off[i], `${i}`).toBeCloseTo(6 * dt, 12);
    expect(off.slice(zero).every((v) => v === 0)).toBe(true);
  });

  it('가속과 브레이크는 따로 움직이고, 변화량은 dt에 비례하며 끝값(0, 1)을 넘지 않는다', () => {
    expect(pedalStep(0.5, 0.5, true, true, dt)).toEqual({ throttle: 0.5 + 0.8 * dt, brake: 0.5 + 3 * dt });
    expect(pedalStep(0.5, 0.5, true, false, dt)).toEqual({ throttle: 0.5 + 0.8 * dt, brake: 0.5 - 6 * dt });
    expect(pedalStep(0.5, 0.5, false, true, dt)).toEqual({ throttle: 0, brake: 0.5 + 3 * dt });
    expect(pedalStep(0.5, 0.5, true, false, 0.1)).toEqual({ throttle: 0.5 + 0.8 * 0.1, brake: 0 });
    expect(pedalStep(0.95, 0.9, true, true, 0.1)).toEqual({ throttle: 1, brake: 1 });
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
