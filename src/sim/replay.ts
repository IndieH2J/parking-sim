import type { Vec2 } from './geometry';
import type { Gear, VehicleState } from './vehicle';
import { wrapPi } from './goal';

// 리플레이 기록과 재생 (계약서 §5.3). 순수 모듈: three·DOM을 쓰지 않는다.
// 시간축은 기록할 때 넘긴 t 그대로다 (main.ts는 tracker.events.elapsed를 넘긴다). 재생 시간 0..duration도 같은 축이다.

export interface ReplayFrame {
  t: number;
  x: number;
  y: number;
  /** (−π, π]로 정규화해 저장한다 (state.heading은 정규화되지 않은 누적값) */
  heading: number;
  steer: number;
  speed: number;
  gear: Gear;
}

export const REPLAY_HZ = 10;
export const MAX_FRAMES = 12000; // 20분

const EPS = 1e-9;

/** state는 main.ts가 제자리에서 바꾸므로 값을 복사해 둔다. */
function frameOf(t: number, s: VehicleState): ReplayFrame {
  return { t, x: s.x, y: s.y, heading: wrapPi(s.heading), steer: s.steer, speed: s.speed, gear: s.gear };
}

export class Recorder {
  readonly frames: ReplayFrame[] = [];

  reset(): void {
    this.frames.length = 0;
  }

  /** 비어 있거나 마지막 프레임보다 1/REPLAY_HZ 이상 지났으면 기록한다. MAX_FRAMES부터는 무시한다. */
  sample(t: number, s: VehicleState): void {
    const n = this.frames.length;
    if (n >= MAX_FRAMES) return;
    if (n > 0 && t < this.frames[n - 1].t + 1 / REPLAY_HZ - EPS) return;
    this.frames.push(frameOf(t, s));
  }

  /** 마지막 상태를 항상 남긴다. 같은 t의 프레임이 있으면 바꿔 쓴다. MAX_FRAMES를 넘어도 붙이므로 최대 MAX_FRAMES + 1개. */
  finish(t: number, s: VehicleState): void {
    const n = this.frames.length;
    const f = frameOf(t, s);
    if (n > 0 && Math.abs(this.frames[n - 1].t - t) <= EPS) this.frames[n - 1] = f;
    else this.frames.push(f);
  }

  /** 마지막 프레임의 t (프레임이 없으면 0) */
  get duration(): number {
    const n = this.frames.length;
    return n > 0 ? this.frames[n - 1].t : 0;
  }
}

/**
 * t 시점의 상태. 범위 밖이면 처음·마지막 프레임 (t도 그 프레임 값).
 * x, y, steer, speed는 선형 보간, heading은 짧은 호 쪽으로 보간해 (−π, π]로 정규화, gear는 앞 프레임 값.
 * 프레임이 하나 이상 있어야 한다 (finish()를 거친 기록은 항상 있다).
 */
export function frameAt(frames: readonly ReplayFrame[], t: number): ReplayFrame {
  const n = frames.length;
  if (n === 0) throw new RangeError('frameAt: no frames');
  if (!(t > frames[0].t)) return { ...frames[0] };
  if (t >= frames[n - 1].t) return { ...frames[n - 1] };
  // frames[lo].t ≤ t < frames[hi].t 를 유지하며 이분 탐색
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = frames[lo];
  const b = frames[hi];
  const u = (t - a.t) / (b.t - a.t);
  return {
    t,
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    heading: wrapPi(a.heading + wrapPi(b.heading - a.heading) * u),
    steer: a.steer + (b.steer - a.steer) * u,
    speed: a.speed + (b.speed - a.speed) * u,
    gear: a.gear,
  };
}

/** t까지의 뒤축 중심 궤적: t 이하 프레임의 점들 + t의 보간점 (프레임 시각과 같으면 겹쳐 넣지 않는다). */
export function trailOf(frames: readonly ReplayFrame[], t: number): Vec2[] {
  const n = frames.length;
  if (n === 0) return [];
  const pts: Vec2[] = [];
  let i = 0;
  for (; i < n && frames[i].t <= t; i++) pts.push({ x: frames[i].x, y: frames[i].y });
  if (i === 0) return [{ x: frames[0].x, y: frames[0].y }];
  if (i < n && t > frames[i - 1].t) {
    const a = frames[i - 1];
    const b = frames[i];
    const u = (t - a.t) / (b.t - a.t);
    pts.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  }
  return pts;
}

/**
 * 프레임마다 첫 프레임부터 뒤축 중심이 움직인 부호 있는 거리 (m, 전진 +). 3D 리플레이의 바퀴 굴림용 (계약서 §5.4).
 * 프레임 사이는 직선 거리이고, 부호는 앞 프레임 heading 기준으로 앞으로 갔는지 뒤로 갔는지다.
 * 리플레이를 시작할 때 한 번 만들고 distanceAt에 넘긴다.
 */
export function cumulativeDistance(frames: readonly ReplayFrame[]): number[] {
  const out: number[] = [];
  let d = 0;
  for (let i = 0; i < frames.length; i++) {
    if (i > 0) {
      const a = frames[i - 1];
      const dx = frames[i].x - a.x;
      const dy = frames[i].y - a.y;
      const len = Math.hypot(dx, dy);
      d += dx * Math.cos(a.heading) + dy * Math.sin(a.heading) < 0 ? -len : len;
    }
    out.push(d);
  }
  return out;
}

/** t 시점의 누적 거리 (cum = cumulativeDistance(frames)). frameAt처럼 범위 밖은 처음·마지막 값, 그 사이는 선형 보간. 빈 기록은 0. */
export function distanceAt(frames: readonly ReplayFrame[], cum: readonly number[], t: number): number {
  const n = frames.length;
  if (n === 0) return 0;
  if (!(t > frames[0].t)) return cum[0];
  if (t >= frames[n - 1].t) return cum[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const u = (t - frames[lo].t) / (frames[hi].t - frames[lo].t);
  return cum[lo] + (cum[hi] - cum[lo]) * u;
}

export type PlaybackRate = 0.5 | 1 | 2 | 4;

/** 재생 위치. tick()이 실제 경과 시간 × 배속만큼 t를 옮긴다. */
export class Playback {
  readonly duration: number;
  t = 0;
  playing = false;
  rate: PlaybackRate = 1;

  constructor(duration: number) {
    this.duration = Math.max(0, duration);
  }

  /** 끝에 있으면 처음부터 다시 재생한다. */
  play(): void {
    if (this.t >= this.duration) this.t = 0;
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** 0..duration으로 자른다. 재생 중이면 계속 재생한다. */
  seek(t: number): void {
    this.t = Math.min(this.duration, Math.max(0, t));
  }

  setRate(r: PlaybackRate): void {
    this.rate = r;
  }

  /** 재생 중이면 dtReal·rate만큼 진행하고, 끝에 닿으면 멈춘다 (playing = false). 현재 t를 돌려준다. */
  tick(dtReal: number): number {
    if (this.playing) {
      this.t += dtReal * this.rate;
      if (this.t >= this.duration) {
        this.t = this.duration;
        this.playing = false;
      }
    }
    return this.t;
  }
}
