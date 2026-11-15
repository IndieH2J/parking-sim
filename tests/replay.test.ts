import { describe, expect, it } from 'vitest';
import { wrapPi } from '../src/sim/goal';
import type { VehicleState } from '../src/sim/vehicle';
import {
  cumulativeDistance,
  distanceAt,
  frameAt,
  MAX_FRAMES,
  Playback,
  Recorder,
  REPLAY_HZ,
  trailOf,
  type ReplayFrame,
} from '../src/sim/replay';

const DT = 1 / 60; // main.ts 고정 스텝
const st = (x: number, o: Partial<VehicleState> = {}): VehicleState => ({
  x,
  y: 0,
  heading: 0,
  speed: 0.9,
  steer: 0,
  gear: 'D',
  ...o,
});
const fr = (t: number, o: Partial<ReplayFrame> = {}): ReplayFrame => ({
  t,
  x: 0,
  y: 0,
  heading: 0,
  steer: 0,
  speed: 0,
  gear: 'D',
  ...o,
});
/** 각도 차이 (−π, π] */
const angDiff = (a: number, b: number) => Math.abs(wrapPi(a - b));

describe('Recorder (§5.3)', () => {
  it('계약 상수: 10 Hz, 최대 12000 프레임 (20분)', () => {
    expect([REPLAY_HZ, MAX_FRAMES]).toEqual([10, 12000]);
    expect(MAX_FRAMES / REPLAY_HZ).toBe(20 * 60);
  });

  it('60 Hz 스텝 601번 → 10 Hz 프레임 101개 (tracker.elapsed처럼 dt를 누적한 t)', () => {
    const r = new Recorder();
    let t = 0;
    for (let k = 0; k < 601; k++) {
      t += DT; // tracker.step()이 elapsed를 먼저 늘리고, 그다음 sample(elapsed, state)
      r.sample(t, st(0.9 * t));
    }
    expect(r.frames.length).toBe(101);
    for (let i = 1; i < r.frames.length; i++) expect(r.frames[i].t - r.frames[i - 1].t).toBeCloseTo(1 / REPLAY_HZ, 9);
    expect(r.frames[0].t).toBeCloseTo(DT, 12);
    expect(r.duration).toBeCloseTo(601 * DT, 9);
    expect(r.frames[100].x).toBeCloseTo(0.9 * 601 * DT, 9);
  });

  it('t = k/60 (k = 0..600)이어도 101개, 0 s부터 10 s까지', () => {
    const r = new Recorder();
    for (let k = 0; k <= 600; k++) r.sample(k / 60, st(k));
    expect(r.frames.length).toBe(101);
    expect(r.frames[0].t).toBe(0);
    expect(r.frames[100].t).toBeCloseTo(10, 12);
    expect(r.frames.map((f) => f.x)).toEqual(Array.from({ length: 101 }, (_, i) => 6 * i));
  });

  it('0.1 s가 안 지난 호출은 버리고, 1e-9 안쪽 오차는 받아들인다', () => {
    const r = new Recorder();
    r.sample(0, st(0));
    r.sample(0.05, st(1));
    expect(r.frames.length).toBe(1);
    r.sample(0.1 - 1e-12, st(2));
    expect(r.frames.length).toBe(2);
    r.sample(0.15, st(3));
    expect(r.frames.map((f) => f.x)).toEqual([0, 2]);
  });

  it('프레임은 state의 복사본 (main.ts는 state를 제자리에서 바꾼다)', () => {
    const r = new Recorder();
    const s = st(1, { y: 2, heading: 0.5, steer: -0.3, speed: -0.8, gear: 'R' });
    r.sample(0, s);
    s.x = 99;
    s.heading = 2;
    s.gear = 'P';
    r.finish(0.3, s);
    s.x = -1;
    expect(r.frames[0]).toEqual({ t: 0, x: 1, y: 2, heading: 0.5, steer: -0.3, speed: -0.8, gear: 'R' });
    expect(r.frames[1]).toMatchObject({ t: 0.3, x: 99, heading: 2, gear: 'P' });
  });

  it('heading은 (−π, π]로 정규화해 저장한다', () => {
    const r = new Recorder();
    r.sample(0, st(0, { heading: 7 }));
    r.sample(0.1, st(0, { heading: -Math.PI }));
    expect(r.frames[0].heading).toBeCloseTo(7 - 2 * Math.PI, 12);
    expect(r.frames[1].heading).toBeCloseTo(Math.PI, 12);
  });

  it('finish: 끝 상태를 붙이고 duration = 그 t', () => {
    const r = new Recorder();
    r.sample(0, st(0));
    r.sample(0.1, st(0.09));
    r.finish(0.15, st(0.135, { speed: 0, gear: 'P' }));
    expect(r.frames.length).toBe(3);
    expect(r.frames[2]).toEqual({ t: 0.15, x: 0.135, y: 0, heading: 0, steer: 0, speed: 0, gear: 'P' });
    expect(r.duration).toBe(0.15);
  });

  it('finish: 마지막 프레임과 t가 같으면 바꿔 쓴다 (zone 목표: 같은 elapsed에서 sample 직후 성공)', () => {
    const r = new Recorder();
    r.sample(0, st(0));
    r.sample(0.1, st(0.09));
    r.finish(0.1, st(0.5, { speed: 0, gear: 'P' }));
    expect(r.frames.length).toBe(2);
    expect(r.frames[1]).toMatchObject({ t: 0.1, x: 0.5, gear: 'P' });
  });

  it('finish: 빈 기록에도 프레임 1개 (첫 이동에서 충돌해 sample이 없던 경우)', () => {
    const r = new Recorder();
    expect(r.duration).toBe(0);
    r.finish(0, st(3));
    expect(r.frames.length).toBe(1);
    expect(r.duration).toBe(0);
    expect(frameAt(r.frames, 0).x).toBe(3);
  });

  it('MAX_FRAMES부터 sample은 무시하고, finish는 그래도 끝 상태를 붙인다', () => {
    const r = new Recorder();
    for (let k = 0; k < MAX_FRAMES + 50; k++) r.sample(k / REPLAY_HZ, st(k));
    expect(r.frames.length).toBe(MAX_FRAMES);
    expect(r.frames[MAX_FRAMES - 1].x).toBe(MAX_FRAMES - 1);
    r.finish(1300, st(-5, { speed: 0, gear: 'P' }));
    expect(r.frames.length).toBe(MAX_FRAMES + 1);
    expect(r.frames[MAX_FRAMES]).toMatchObject({ t: 1300, x: -5, gear: 'P' });
    expect(r.duration).toBe(1300);
  });

  it('reset은 같은 배열을 비우고, 다시 처음부터 기록한다', () => {
    const r = new Recorder();
    const arr = r.frames;
    for (let k = 0; k < 5; k++) r.sample(k / REPLAY_HZ, st(k));
    r.reset();
    expect(r.frames).toBe(arr);
    expect(r.frames.length).toBe(0);
    expect(r.duration).toBe(0);
    r.sample(0, st(7));
    expect(r.frames).toEqual([fr(0, { x: 7, speed: 0.9 })]);
  });
});

describe('frameAt', () => {
  const frames: ReplayFrame[] = [
    fr(1, { x: 0, y: 0, heading: 0, steer: 0, speed: 0.5, gear: 'D' }),
    fr(1.1, { x: 1, y: -2, heading: 0.2, steer: 1, speed: 1.5, gear: 'R' }),
    fr(1.2, { x: 3, y: -2, heading: 0.4, steer: -1, speed: -0.5, gear: 'N' }),
  ];

  it('사이: x, y, steer, speed는 선형 보간, gear는 앞 프레임', () => {
    const f = frameAt(frames, 1.075); // 첫 구간의 3/4
    expect(f.t).toBe(1.075);
    expect(f.x).toBeCloseTo(0.75, 9);
    expect(f.y).toBeCloseTo(-1.5, 9);
    expect(f.heading).toBeCloseTo(0.15, 9);
    expect(f.steer).toBeCloseTo(0.75, 9);
    expect(f.speed).toBeCloseTo(1.25, 9);
    expect(f.gear).toBe('D');
    const g = frameAt(frames, 1.15); // 둘째 구간 가운데
    expect(g.x).toBeCloseTo(2, 9);
    expect(g.steer).toBeCloseTo(0, 9);
    expect(g.speed).toBeCloseTo(0.5, 9);
    expect(g.gear).toBe('R');
  });

  it('프레임 시각에서는 그 프레임 그대로', () => {
    for (const f of frames) expect(frameAt(frames, f.t)).toEqual(f);
  });

  it('범위 밖은 처음·마지막 프레임 (t도 그 값), 돌려준 값은 복사본', () => {
    expect(frameAt(frames, 0)).toEqual(frames[0]);
    expect(frameAt(frames, -5)).toEqual(frames[0]);
    expect(frameAt(frames, 99)).toEqual(frames[2]);
    const f = frameAt(frames, 99);
    f.x = 1234;
    expect(frames[2].x).toBe(3);
  });

  it('heading: ±π를 지나는 짧은 호로 보간한다 (0 쪽 긴 호가 아님)', () => {
    const span = wrapPi(-3.1 - 3.1); // 2π − 6.2 ≈ 0.083 rad
    const w = [fr(0, { heading: 3.1 }), fr(1, { heading: -3.1 })];
    expect(angDiff(frameAt(w, 0.5).heading, Math.PI)).toBeLessThan(1e-9);
    const q = frameAt(w, 0.75).heading;
    expect(q).toBeGreaterThan(-Math.PI);
    expect(q).toBeLessThanOrEqual(Math.PI);
    expect(angDiff(q, 3.1 + 0.75 * span)).toBeLessThan(1e-9);
    const back = [fr(0, { heading: -3.1 }), fr(1, { heading: 3.1 })];
    expect(angDiff(frameAt(back, 0.5).heading, Math.PI)).toBeLessThan(1e-9);
    expect(angDiff(frameAt(back, 0.25).heading, -3.1 - 0.25 * span)).toBeLessThan(1e-9);
  });

  it('정규화 안 된 state.heading(한 바퀴 넘게 돈 차)도 짧은 호로', () => {
    const r = new Recorder();
    r.sample(0, st(0, { heading: 6.2 }));
    r.sample(0.1, st(0, { heading: 6.4 }));
    const h = frameAt(r.frames, 0.05).heading;
    expect(angDiff(h, 6.3)).toBeLessThan(1e-9);
    expect(h).toBeGreaterThan(-Math.PI);
    expect(h).toBeLessThanOrEqual(Math.PI);
  });

  it('프레임이 많아도 (이분 탐색) 맞는 구간을 고른다', () => {
    const many = Array.from({ length: 2000 }, (_, i) => fr(i / REPLAY_HZ, { x: (i / REPLAY_HZ) * 2, gear: i % 2 ? 'R' : 'D' }));
    for (const t of [0.03, 12.34, 99.95, 150.05, 199.87]) {
      const f = frameAt(many, t);
      expect(f.x).toBeCloseTo(2 * t, 9);
      expect(f.gear).toBe(Math.floor(t * REPLAY_HZ + 1e-9) % 2 ? 'R' : 'D');
    }
  });

  it('프레임이 없으면 RangeError', () => {
    expect(() => frameAt([], 0)).toThrow(RangeError);
  });
});

describe('trailOf', () => {
  const frames = [fr(0, { x: 0, y: 0 }), fr(0.1, { x: 1, y: 2 }), fr(0.2, { x: 3, y: 2 })];

  it('t 이하 프레임의 점 + t의 보간점', () => {
    const p = trailOf(frames, 0.15);
    expect(p.length).toBe(3);
    expect(p.slice(0, 2)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 2 },
    ]);
    expect(p[2].x).toBeCloseTo(2, 9);
    expect(p[2].y).toBeCloseTo(2, 9);
  });

  it('t가 프레임 시각과 같으면 보간점을 겹쳐 넣지 않는다', () => {
    expect(trailOf(frames, 0.1)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 2 },
    ]);
  });

  it('처음 전에는 첫 점 하나, 끝 뒤에는 모든 점, 빈 기록은 []', () => {
    expect(trailOf(frames, -1)).toEqual([{ x: 0, y: 0 }]);
    expect(trailOf(frames, 5)).toEqual(frames.map((f) => ({ x: f.x, y: f.y })));
    expect(trailOf([], 1)).toEqual([]);
  });

  it('마지막 점은 frameAt 위치와 같다', () => {
    for (const t of [0.01, 0.05, 0.12, 0.19]) {
      const p = trailOf(frames, t).at(-1)!;
      const f = frameAt(frames, t);
      expect(p.x).toBeCloseTo(f.x, 12);
      expect(p.y).toBeCloseTo(f.y, 12);
    }
  });
});

describe('cumulativeDistance · distanceAt (바퀴 굴림, §5.4)', () => {
  it('빈 기록은 [] · 0, 프레임 하나(골 자세에서 바로 P)는 [0] · 언제나 0', () => {
    expect(cumulativeDistance([])).toEqual([]);
    expect(distanceAt([], [], 1)).toBe(0);
    const one = [fr(2.5, { x: 3, y: -1, heading: 1 })];
    const cum = cumulativeDistance(one);
    expect(cum).toEqual([0]);
    for (const t of [-1, 0, 2.5, 9]) expect(distanceAt(one, cum, t)).toBe(0);
  });

  it('직진 전진은 +, 후진은 −, 서쪽을 보고 −x로 가면 전진(+)', () => {
    const fwd = [0, 1, 2, 3].map((k) => fr(k * 0.1, { x: 0.5 * k }));
    expect(cumulativeDistance(fwd).map((d) => +d.toFixed(12))).toEqual([0, 0.5, 1, 1.5]);
    const rev = [0, 1, 2].map((k) => fr(k * 0.1, { x: -0.3 * k, speed: -1, gear: 'R' }));
    expect(cumulativeDistance(rev).map((d) => +d.toFixed(12))).toEqual([0, -0.3, -0.6]);
    const west = [0, 1].map((k) => fr(k * 0.1, { x: -0.4 * k, heading: Math.PI }));
    expect(cumulativeDistance(west)[1]).toBeCloseTo(0.4, 12);
  });

  it('앞으로 갔다 뒤로 오면 순 거리, 정지 구간은 그대로', () => {
    const f = [fr(0, { x: 0 }), fr(0.1, { x: 1 }), fr(0.2, { x: 1 }), fr(0.3, { x: 0.25 })];
    expect(cumulativeDistance(f).map((d) => +d.toFixed(12))).toEqual([0, 1, 1, 0.25]);
  });

  it('distanceAt: 프레임 사이는 선형 보간, 범위 밖은 처음·마지막 값, 프레임 시각에서는 그 값', () => {
    const f = [fr(0, { x: 0 }), fr(0.1, { x: 1 }), fr(0.3, { x: 2 })];
    const cum = cumulativeDistance(f);
    expect(distanceAt(f, cum, -1)).toBe(0);
    expect(distanceAt(f, cum, 0.05)).toBeCloseTo(0.5, 12);
    expect(distanceAt(f, cum, 0.1)).toBeCloseTo(1, 12);
    expect(distanceAt(f, cum, 0.2)).toBeCloseTo(1.5, 12);
    expect(distanceAt(f, cum, 7)).toBeCloseTo(2, 12);
  });

  it('원호 주행: 0.1 s 현의 합이 호 길이와 0.1 % 안 (60 Hz 기록과 같은 방식)', () => {
    const R = 5;
    const v = 2; // m/s
    const r = new Recorder();
    let t = 0;
    for (let k = 0; k < 600; k++) {
      t += DT;
      const th = (v * t) / R;
      r.sample(t, st(R * Math.sin(th), { y: R * (1 - Math.cos(th)), heading: th, speed: v }));
    }
    const cum = cumulativeDistance(r.frames);
    const f = r.frames;
    const arc = v * (f[f.length - 1].t - f[0].t);
    expect(Math.abs(cum[cum.length - 1] - arc) / arc).toBeLessThan(1e-3);
  });
});

describe('Playback', () => {
  it('처음: t 0, 정지, 1배속. 정지 중 tick은 t를 바꾸지 않는다', () => {
    const p = new Playback(10);
    expect(p.duration).toBe(10);
    expect([p.t, p.playing, p.rate]).toEqual([0, false, 1]);
    expect(p.tick(1)).toBe(0);
  });

  it('배속: tick(dt)은 dt × rate만큼 진행', () => {
    const p = new Playback(10);
    p.play();
    expect(p.tick(1)).toBeCloseTo(1, 12);
    p.setRate(2);
    expect(p.tick(1)).toBeCloseTo(3, 12);
    p.setRate(0.5);
    expect(p.tick(1)).toBeCloseTo(3.5, 12);
    p.setRate(4);
    expect(p.tick(0.5)).toBeCloseTo(5.5, 12);
    expect(p.rate).toBe(4);
    expect(p.playing).toBe(true);
  });

  it('seek: 0..duration으로 자르고, 재생 상태는 그대로', () => {
    const p = new Playback(10);
    p.seek(4);
    expect(p.t).toBe(4);
    expect(p.playing).toBe(false);
    p.seek(-3);
    expect(p.t).toBe(0);
    p.seek(25);
    expect(p.t).toBe(10);
    p.play(); // 끝에서 play → 0부터
    p.seek(6);
    expect(p.playing).toBe(true);
    expect(p.tick(0.5)).toBeCloseTo(6.5, 12);
  });

  it('끝에 닿으면 duration에서 멈추고 playing = false, 다시 play()하면 0부터', () => {
    const p = new Playback(3);
    p.setRate(2);
    p.play();
    p.tick(1);
    expect(p.tick(1)).toBe(3);
    expect(p.playing).toBe(false);
    expect(p.tick(1)).toBe(3);
    p.play();
    expect(p.t).toBe(0);
    expect(p.playing).toBe(true);
    expect(p.tick(0.25)).toBeCloseTo(0.5, 12);
  });

  it('끝이 아니면 play()는 그 자리에서 이어 간다, toggle은 재생·정지를 번갈아', () => {
    const p = new Playback(10);
    p.seek(5);
    p.toggle();
    expect(p.playing).toBe(true);
    expect(p.t).toBe(5);
    p.tick(1);
    p.toggle();
    expect(p.playing).toBe(false);
    expect(p.tick(1)).toBeCloseTo(6, 12);
    p.pause();
    expect(p.playing).toBe(false);
  });

  it('duration 0 (첫 스텝 충돌): play 후 tick 한 번에 끝', () => {
    const p = new Playback(0);
    p.play();
    expect(p.tick(0.016)).toBe(0);
    expect(p.playing).toBe(false);
  });
});
