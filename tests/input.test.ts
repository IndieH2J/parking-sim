import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input, KEY_GEAR, KEY_LOOK, type InputCallbacks } from '../src/input/input';

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

// 키 이벤트 처리. 생성자는 리스너를 붙이기만 하므로 가짜 window·document로 Input을 만든다.
function makeInput(cb: Partial<InputCallbacks> = {}) {
  const on: Record<string, (e: unknown) => void> = {};
  const el = { addEventListener() {} };
  vi.stubGlobal('window', { addEventListener: (type: string, fn: (e: unknown) => void) => (on[type] = fn) });
  vi.stubGlobal('document', { getElementById: () => el, querySelectorAll: () => [] });
  const noop = () => {};
  const input = new Input({ onGear: noop, onLook: noop, onLookDrag: noop, onTopView: noop, getSteer: () => 0, maxWheel: 1, ...cb });
  const key = (type: 'keydown' | 'keyup', code: string, tagName = 'BODY') =>
    on[type]({ code, repeat: false, target: { tagName }, preventDefault() {} });
  return { input, key };
}

describe('키 이벤트와 입력칸', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('입력칸에서 뗀 키도 놓는다: W를 누른 채 시트의 입력칸을 누르고 W를 떼면 W가 눌린 채로 남지 않는다', () => {
    const { input, key } = makeInput();
    key('keydown', 'KeyW');
    expect(input.keyIntent.fwd).toBe(true);
    key('keyup', 'KeyW', 'INPUT');
    expect(input.keyIntent.fwd).toBe(false);
    expect(input.accel).toBe(false);
    key('keydown', 'Space');
    key('keyup', 'Space', 'SELECT');
    expect(input.keyIntent.brake).toBe(false);
  });

  it('입력칸에서 누른 키는 여전히 운전·기어 입력이 아니다 (칸 폭에 숫자를 쳐도 기어가 바뀌지 않는다)', () => {
    const gears: string[] = [];
    const { input, key } = makeInput({ onGear: (g) => gears.push(g) });
    key('keydown', 'Digit2', 'INPUT');
    key('keydown', 'KeyW', 'INPUT');
    expect(gears).toEqual([]);
    expect(input.keyIntent.fwd).toBe(false);
    key('keydown', 'Digit2');
    expect(gears).toEqual(['R']);
  });
});
