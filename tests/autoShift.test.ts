import { describe, expect, it } from 'vitest';
import { autoShift, type DriveKeys } from '../src/sim/autoShift';
import { AttemptTracker } from '../src/sim/attempt';
import { aabbRect } from '../src/sim/geometry';
import type { MoveResult } from '../src/sim/motion';
import { initialState, MAX_SPEED, pedalStep, updateSpeed, type Gear, type VehicleState } from '../src/sim/vehicle';
import { prepare } from '../src/sim/world';

// 키보드 자동 변속 (계약서 개정 2026-11-16 controls, 설계 .dev/v4-design.md B2)

const GEARS: Gear[] = ['P', 'R', 'N', 'D'];
const SPEEDS = [-1, -0.01, -0, 0, 0.01, 1];
const speedText = (v: number) => (Object.is(v, -0) ? '-0' : String(v));

/** W·↑ / S·↓ / Space의 8가지 조합 */
const KEYS = {
  none: { fwd: false, rev: false, brake: false },
  Space: { fwd: false, rev: false, brake: true },
  W: { fwd: true, rev: false, brake: false },
  'W+Space': { fwd: true, rev: false, brake: true },
  S: { fwd: false, rev: true, brake: false },
  'S+Space': { fwd: false, rev: true, brake: true },
  'W+S': { fwd: true, rev: true, brake: false },
  'W+S+Space': { fwd: true, rev: true, brake: true },
} satisfies Record<string, DriveKeys>;
type KeyName = keyof typeof KEYS;

/** [기어 ('keep' = 그대로), 가속, 브레이크] */
type Row = [Gear | 'keep', boolean, boolean];
/** 설계 B2 표를 손으로 옮긴 것. 열: [뒤로 움직이는 중, 정지 (+0·−0), 앞으로 움직이는 중] */
const TABLE: Record<KeyName, [Row, Row, Row]> = {
  none: [
    ['keep', false, false],
    ['keep', false, false],
    ['keep', false, false],
  ],
  Space: [
    ['keep', false, true],
    ['keep', false, true],
    ['keep', false, true],
  ],
  'W+S': [
    ['keep', false, true],
    ['keep', false, true],
    ['keep', false, true],
  ],
  'W+S+Space': [
    ['keep', false, true],
    ['keep', false, true],
    ['keep', false, true],
  ],
  W: [
    ['keep', false, true],
    ['D', true, false],
    ['D', true, false],
  ],
  'W+Space': [
    ['keep', false, true],
    ['D', false, true],
    ['D', false, true],
  ],
  S: [
    ['R', true, false],
    ['R', true, false],
    ['keep', false, true],
  ],
  'S+Space': [
    ['R', false, true],
    ['R', false, true],
    ['keep', false, true],
  ],
};

describe('autoShift 표: 기어 4 × 속도 6 (−0 포함) × 키 8', () => {
  for (const name of Object.keys(KEYS) as KeyName[]) {
    it(name, () => {
      for (const gear of GEARS) {
        for (const speed of SPEEDS) {
          const [g, throttle, brake] = TABLE[name][speed < 0 ? 0 : speed > 0 ? 2 : 1];
          expect(autoShift(gear, speed, KEYS[name]), `${gear} ${speedText(speed)}`).toEqual({
            gear: g === 'keep' ? gear : g,
            throttle,
            brake,
          });
        }
      }
    });
  }

  it('대표 행', () => {
    // 정지(+0·−0)에서 W·S는 바로 D·R
    expect(autoShift('P', 0, KEYS.W)).toEqual({ gear: 'D', throttle: true, brake: false });
    expect(autoShift('P', -0, KEYS.S)).toEqual({ gear: 'R', throttle: true, brake: false });
    expect(autoShift('D', -0, KEYS.S)).toEqual({ gear: 'R', throttle: true, brake: false });
    expect(autoShift('R', -0, KEYS.W)).toEqual({ gear: 'D', throttle: true, brake: false });
    expect(autoShift('N', 0, KEYS.S)).toEqual({ gear: 'R', throttle: true, brake: false });
    // 반대로 움직이는 중: 기어 그대로 제동만 (아주 느려도)
    expect(autoShift('D', 1, KEYS.S)).toEqual({ gear: 'D', throttle: false, brake: true });
    expect(autoShift('D', 0.01, KEYS.S)).toEqual({ gear: 'D', throttle: false, brake: true });
    expect(autoShift('R', -1, KEYS.W)).toEqual({ gear: 'R', throttle: false, brake: true });
    expect(autoShift('N', -0.01, KEYS.W)).toEqual({ gear: 'N', throttle: false, brake: true });
    // 이미 원하는 쪽으로 움직이는 중이면 기어와 상관없이 바로 그 방향 기어
    expect(autoShift('N', 1, KEYS.W)).toEqual({ gear: 'D', throttle: true, brake: false });
    expect(autoShift('R', 0.01, KEYS.W)).toEqual({ gear: 'D', throttle: true, brake: false });
    expect(autoShift('D', -1, KEYS.S)).toEqual({ gear: 'R', throttle: true, brake: false });
    // Space와 함께: 기어는 미리 바꾸고 브레이크를 밟은 채
    expect(autoShift('P', 0, KEYS['W+Space'])).toEqual({ gear: 'D', throttle: false, brake: true });
    // W+S: 방향 없음, 제동
    expect(autoShift('D', 1, KEYS['W+S'])).toEqual({ gear: 'D', throttle: false, brake: true });
    expect(autoShift('R', -1, KEYS.none)).toEqual({ gear: 'R', throttle: false, brake: false });
    expect(autoShift('N', 0, KEYS.Space)).toEqual({ gear: 'N', throttle: false, brake: true });
  });
});

describe('autoShift는 P를 고르지 않는다', () => {
  it('모든 기어·속도·키에서 출력이 P이면 입력도 P다', () => {
    for (const gear of GEARS) {
      for (const speed of SPEEDS) {
        for (const name of Object.keys(KEYS) as KeyName[]) {
          if (autoShift(gear, speed, KEYS[name]).gear === 'P') expect(gear, `${gear} ${speedText(speed)} ${name}`).toBe('P');
        }
      }
    }
  });

  it('P에 서 있을 때 (+0·−0): 출력이 P ⇔ 방향 키가 없음 (W·S 중 하나만 누르면 D·R)', () => {
    for (const speed of [0, -0]) {
      for (const name of Object.keys(KEYS) as KeyName[]) {
        const k = KEYS[name];
        const direction = k.fwd !== k.rev;
        expect(autoShift('P', speed, k).gear === 'P', `${speedText(speed)} ${name}`).toBe(!direction);
      }
    }
  });

  it('P의 속도는 늘 0이라 (updateSpeed) 표의 "P인 채 반대 방향 제동" 줄은 게임에서 나오지 않는다', () => {
    for (const speed of [-1, 1]) {
      for (const throttle of [0, 1]) {
        expect(updateSpeed({ ...initialState(0, 0, 0), gear: 'P', speed }, { throttle, brake: 0, steer: 0 }, 1 / 60)).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------- main.ts step() 순서 복제

/** main.ts DT */
const DT = 1 / 60;
const OK: MoveResult = { kind: 'ok' };
const WHEEL_STOP: MoveResult = {
  kind: 'wheel',
  wheel: 'RL',
  element: prepare({ id: 'stop', kind: 'wheelStop', poly: aabbRect(-0.45, 0.35, -0.3, 0.85), hMin: 0, hMax: 0.12 }),
};

interface Frame {
  gear: Gear;
  speed: number;
  x: number;
  throttle: number;
}

/**
 * main.ts step()의 1~5단계를 자동 변속 모드로 그대로 따라 한다 (1D: 조향·구역 목표 없음, 터치 페달 안 누름).
 * autoShift (지난 스텝의 속도로) → 기어가 바뀌면 throttle = 0 → pedalStep → updateSpeed
 * → 속도 0이면 state.speed = 0 / 이동이 거부되면(휠스톱) state.speed = 0 / 아니면 이동 → AttemptTracker.
 */
class StepReplica {
  s: VehicleState;
  throttle = 0;
  brake = 0;
  x = 0;
  readonly tracker = new AttemptTracker();
  /** 스텝이 끝난 뒤의 값 */
  readonly trace: Frame[] = [];

  constructor(gear: Gear = 'P', speed = 0) {
    this.s = { ...initialState(0, 0, 0), gear, speed };
  }

  /** blocked = 이 스텝의 이동이 휠스톱에 거부된다 */
  step(keys: DriveKeys, blocked = false) {
    const cmd = autoShift(this.s.gear, this.s.speed, keys);
    if (cmd.gear !== this.s.gear) {
      this.s.gear = cmd.gear;
      this.throttle = 0;
    }
    ({ throttle: this.throttle, brake: this.brake } = pedalStep(this.throttle, this.brake, cmd.throttle, cmd.brake, DT));
    const speed = updateSpeed(this.s, { throttle: this.throttle, brake: this.brake, steer: 0 }, DT);
    if (speed === 0) {
      this.s.speed = 0;
      this.tracker.step(DT, 0, null);
    } else if (blocked) {
      this.s.speed = 0;
      this.tracker.step(DT, 0, WHEEL_STOP);
    } else {
      this.x += speed * DT;
      this.s.speed = speed;
      this.tracker.step(DT, speed, OK);
    }
    this.trace.push({ gear: this.s.gear, speed: this.s.speed, x: this.x, throttle: this.throttle });
  }

  /** seconds 동안 같은 키를 누른다. 이번에 쌓인 프레임을 돌려준다 */
  hold(keys: DriveKeys, seconds: number, blocked = false): Frame[] {
    const n0 = this.trace.length;
    for (let i = 0; i < Math.round(seconds / DT); i++) this.step(keys, blocked);
    return this.trace.slice(n0);
  }
}

describe('step() 순서 복제: 자동 변속으로 운전', () => {
  it('P에서 W 3초: 첫 스텝에 D, 속도는 정확히 MAX_SPEED에 이르고 넘지 않는다', () => {
    const r = new StepReplica();
    const tr = r.hold(KEYS.W, 3);
    expect(tr.every((f) => f.gear === 'D')).toBe(true);
    expect(tr[0].throttle).toBe(pedalStep(0, 0, true, false, DT).throttle);
    expect(tr.every((f) => f.speed >= 0 && f.speed <= MAX_SPEED)).toBe(true);
    expect(r.s.speed).toBe(MAX_SPEED);
    expect(r.tracker.events.dirChanges).toBe(0);
  });

  it('이어서 S: 움직이는 동안 D 그대로, 정확히 0인 스텝 뒤에 R, 0.30 m 안에 서고 −MAX_SPEED까지 후진, 전환 1회', () => {
    const r = new StepReplica();
    r.hold(KEYS.W, 3);
    const x0 = r.x;
    const tr = r.hold(KEYS.S, 4);
    const iR = tr.findIndex((f) => f.gear === 'R');
    expect(iR).toBeGreaterThan(1);
    // R 전까지는 D로 앞으로 가며 제동하고, R 바로 앞 스텝에서 처음으로 정확히 0
    expect(tr.slice(0, iR).every((f) => f.gear === 'D')).toBe(true);
    expect(tr.slice(0, iR - 1).every((f) => f.speed > 0)).toBe(true);
    expect(Object.is(tr[iR - 1].speed, 0)).toBe(true);
    // R인데 앞으로 움직인 스텝은 없다
    expect(r.trace.some((f) => f.gear === 'R' && f.speed > 0)).toBe(false);
    // 상한에서 약 0.30초·0.25 m 만에 선다
    const stopDist = tr[iR - 1].x - x0;
    expect(stopDist).toBeGreaterThan(0.2);
    expect(stopDist).toBeLessThanOrEqual(0.3);
    expect(iR * DT).toBeLessThan(0.35);
    // 계속 누르면 후진 상한까지
    expect(tr.every((f) => f.speed >= -MAX_SPEED)).toBe(true);
    expect(r.s.speed).toBe(-MAX_SPEED);
    expect(r.s.gear).toBe('R');
    expect(r.tracker.events.dirChanges).toBe(1);
  });

  it('달리는 중 W+S: 기어 그대로 서고, 계속 눌러도 다시 출발하지 않는다 (D·R 모두)', () => {
    for (const [first, gear, sign] of [
      ['W', 'D', 1],
      ['S', 'R', -1],
    ] as const) {
      const r = new StepReplica();
      r.hold(KEYS[first], 2);
      expect(r.s.speed, gear).toBe(sign * MAX_SPEED);
      const tr = r.hold(KEYS['W+S'], 2);
      expect(tr.every((f) => f.gear === gear)).toBe(true);
      expect(tr.every((f) => f.speed * sign >= 0)).toBe(true);
      const stop = tr.findIndex((f) => f.speed === 0);
      expect(stop, gear).toBeGreaterThan(0);
      expect(tr.slice(stop).every((f) => f.speed === 0), gear).toBe(true);
      expect(r.tracker.events.dirChanges, gear).toBe(0);
    }
  });

  it('P에서 Space+W: D로 바뀌지만 움직이지 않고, Space를 떼면 출발한다 (Space+S는 R)', () => {
    for (const [withSpace, without, gear, sign] of [
      ['W+Space', 'W', 'D', 1],
      ['S+Space', 'S', 'R', -1],
    ] as const) {
      const r = new StepReplica();
      const held = r.hold(KEYS[withSpace], 1);
      expect(held.every((f) => f.gear === gear && f.speed === 0 && f.throttle === 0), gear).toBe(true);
      expect(r.x, gear).toBe(0);
      expect(r.tracker.started, gear).toBe(false);
      const tr = r.hold(KEYS[without], 2);
      expect(tr.every((f) => f.gear === gear && f.speed * sign >= 0), gear).toBe(true);
      expect(r.s.speed * sign, gear).toBeGreaterThan(0);
    }
  });

  it('N에서 뒤로 구르는 중 W: 기어 N인 채 0까지 제동한 뒤 D로 출발한다', () => {
    const r = new StepReplica('N', -1);
    const tr = r.hold(KEYS.W, 2);
    const iD = tr.findIndex((f) => f.gear === 'D');
    expect(iD).toBeGreaterThan(1);
    expect(tr.slice(0, iD).every((f) => f.gear === 'N')).toBe(true);
    expect(tr.slice(0, iD - 1).every((f) => f.speed < 0)).toBe(true);
    expect(Object.is(tr[iD - 1].speed, 0)).toBe(true);
    expect(tr.some((f) => f.gear === 'D' && f.speed < 0)).toBe(false);
    expect(r.s.speed).toBeGreaterThan(0);
    expect(r.tracker.events.dirChanges).toBe(1);
  });

  it('S로 휠스톱에 막힌 채(매 스텝 속도 0): W로 바꾸면 바로 D가 되고 가속 값은 0부터 다시 오른다', () => {
    const r = new StepReplica();
    const pinned = r.hold(KEYS.S, 2, true);
    expect(pinned.every((f) => f.gear === 'R' && f.speed === 0)).toBe(true);
    expect(r.throttle).toBe(1); // 막힌 동안 가속 값은 끝까지 올랐다
    expect(r.x).toBe(0);
    r.step(KEYS.W);
    expect(r.s.gear).toBe('D');
    expect(r.throttle).toBe(pedalStep(0, 0, true, false, DT).throttle);
    const tr = r.hold(KEYS.W, 2);
    expect(tr.every((f) => f.gear === 'D' && f.speed >= 0)).toBe(true);
    expect(r.s.speed).toBeGreaterThan(0);
    expect(r.tracker.events.dirChanges).toBe(0);
  });
});
