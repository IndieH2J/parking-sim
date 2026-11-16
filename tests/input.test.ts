import { describe, expect, it } from 'vitest';
import { KEY_GEAR, KEY_LOOK } from '../src/input/input';

// 기어·시선 키 맵 (계약서 개정 2026-11-16 controls). input.ts는 모듈 수준에서 DOM을 건드리지 않아 node에서 import할 수 있다.

const gearCodes = Object.keys(KEY_GEAR);
const lookCodes = Object.keys(KEY_LOOK);

describe('키 맵', () => {
  it('기어: 1 P · 2 R · 3 N · 4 D, 예전 글자 키 P·R·N·F(=D)는 별칭', () => {
    expect(KEY_GEAR).toEqual({ Digit1: 'P', Digit2: 'R', Digit3: 'N', Digit4: 'D', KeyP: 'P', KeyR: 'R', KeyN: 'N', KeyF: 'D' });
  });

  it('시선: 5 좌미러 · 6 좌창 · 7 정면 · 8 우창 · 9 우미러 · 0 뒤', () => {
    expect(KEY_LOOK).toEqual({ Digit5: 'LM', Digit6: 'LW', Digit7: 'F', Digit8: 'RW', Digit9: 'RM', Digit0: 'BACK' });
  });

  it('두 맵은 겹치지 않는다 (숫자 키 0~9를 나눠 쓴다)', () => {
    expect(gearCodes.filter((c) => lookCodes.includes(c))).toEqual([]);
    const digits = [...gearCodes, ...lookCodes].filter((c) => c.startsWith('Digit')).sort();
    expect(digits).toEqual(['Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9']);
  });

  it('숫자패드 코드는 없다', () => {
    for (const c of [...gearCodes, ...lookCodes]) expect(c.startsWith('Numpad'), c).toBe(false);
  });

  it('운전·핸들·탑뷰 키(W S A D C T, Space, 화살표)는 어느 맵에도 없다', () => {
    const driving = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyC', 'KeyT', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    for (const c of driving) {
      expect(gearCodes.includes(c), c).toBe(false);
      expect(lookCodes.includes(c), c).toBe(false);
    }
  });
});
