import { describe, expect, it } from 'vitest';
import { legRun, legTime } from './helpers/timing';

// 구간 시간 1D 복제(tests/helpers/timing.ts)의 성질을 고정한다. 모든 시간 기준 가드(tGood ≥ 1.5 × T)가 이 함수에 기댄다.
// legTime(L, false) = 정지에서 출발해 정지로 끝나는 구간 (방향을 바꾸기 전 구간, 발권기의 마지막 구간).

/** 0 ~ 70 m, 1 cm 간격 (가장 긴 증명 구간은 골목·램프의 약 60 m) */
const GRID = Array.from({ length: 7001 }, (_, i) => i / 100);

describe('legTime(L, false): 정지 → 정지 구간', () => {
  it('속도 0으로 끝나고, 선 자리는 L − 1.2 cm ~ L + 3.7 cm (스텝 단위로 떼므로 정확히 L은 아니다)', () => {
    const bad: string[] = [];
    for (const L of GRID) {
      const r = legRun(L, false);
      if (r.v !== 0 || r.x - L < -0.012 || r.x - L > 0.037 || r.t !== legTime(L, false)) {
        bad.push(`L ${L}: x ${r.x.toFixed(4)} v ${r.v} t ${r.t}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('움직이며 끝나는 구간(legTime(L, true))보다 짧지 않다', () => {
    const bad = GRID.filter((L) => legTime(L, false) < legTime(L, true));
    expect(bad).toEqual([]);
  });

  it('L이 길어지면 줄지 않는다', () => {
    const t = GRID.map((L) => legTime(L, false));
    const bad = GRID.filter((_, i) => i > 0 && t[i] < t[i - 1]).map((L) => `L ${L}`);
    expect(bad).toEqual([]);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThan(t[1]);
  });
});
