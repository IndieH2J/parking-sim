import type { Gear } from '../sim/vehicle';
import type { LookTarget } from '../render/cameras';

export interface InputCallbacks {
  onGear: (g: Gear) => void;
  onLook: (l: LookTarget) => void;
  onLookDrag: (dx: number, dy: number) => void;
  /** 터치 핸들 조작 시작 시 현재 정규화 조향값 */
  getSteer: () => number;
  /** 핸들 한쪽 최대 회전각(rad) */
  maxWheel: number;
}

const KEY_GEAR: Record<string, Gear> = { KeyP: 'P', KeyR: 'R', KeyN: 'N', KeyF: 'D' };
const KEY_LOOK: Record<string, LookTarget> = {
  Digit1: 'LM',
  Digit2: 'LW',
  Digit3: 'F',
  Digit4: 'RW',
  Digit5: 'RM',
  Digit6: 'BACK',
};

/** 키보드·터치·마우스 입력을 모아 페달/조향 의도로 바꾼다. */
export class Input {
  private keys = new Set<string>();
  private touchAccel = false;
  private touchBrake = false;
  /** 터치 핸들로 정한 조향값. 소비되면 null */
  private touchSteer: number | null = null;
  centerRequested = false;

  constructor(private readonly cb: InputCallbacks) {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    this.bindPedal('pedal-accel', (v) => (this.touchAccel = v));
    this.bindPedal('pedal-brake', (v) => (this.touchBrake = v));
    document.querySelectorAll<HTMLButtonElement>('[data-gear]').forEach((b) => {
      this.bindPress(b, () => cb.onGear(b.dataset.gear as Gear));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-look]').forEach((b) => {
      this.bindPress(b, () => cb.onLook(b.dataset.look as LookTarget));
    });
    this.bindWheel();
    this.bindLookDrag();
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (down) {
      if (KEY_GEAR[e.code] && !e.repeat) this.cb.onGear(KEY_GEAR[e.code]);
      if (KEY_LOOK[e.code] && !e.repeat) this.cb.onLook(KEY_LOOK[e.code]);
      if (e.code === 'KeyC') this.centerRequested = true;
      this.keys.add(e.code);
    } else {
      this.keys.delete(e.code);
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  }

  /**
   * 기어·시선 버튼은 누르는 순간(pointerdown) 실행한다. 다른 손가락으로 페달이나 핸들을 누르고 있으면 그 탭은 주 포인터가 아니라
   * 브라우저가 click을 만들지 않는다 (click만 들으면 브레이크를 밟은 채 R을 눌러도 무시됐다).
   * 키보드(Enter·Space)로 생긴 click(detail 0)은 그대로 받고, 포인터가 만든 click(detail ≥ 1)은 pointerdown에서 이미 처리했으므로 무시한다.
   */
  private bindPress(b: HTMLButtonElement, act: () => void) {
    b.addEventListener('pointerdown', (e) => {
      if (e.button === 0) act();
    });
    b.addEventListener('click', (e) => {
      if (e.detail === 0) act();
    });
  }

  private bindPedal(id: string, set: (v: boolean) => void) {
    const el = document.getElementById(id)!;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      set(true);
    });
    const up = () => {
      el.classList.remove('active');
      set(false);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private bindWheel() {
    const el = document.getElementById('wheel')!;
    let active = -1;
    let lastAngle = 0;
    let wheel = 0; // rad, + = 왼쪽(반시계)
    const angleOf = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
    };
    el.addEventListener('pointerdown', (e) => {
      active = e.pointerId;
      el.setPointerCapture(e.pointerId);
      lastAngle = angleOf(e);
      wheel = this.cb.getSteer() * this.cb.maxWheel;
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== active) return;
      // 지난 값이 이미 소비됐으면 실제 조향에서 다시 시작한다. 조향이 거부된 경우(연석·휠스톱) 다음 드래그에서 핸들이 튀지 않게.
      if (this.touchSteer === null) wheel = this.cb.getSteer() * this.cb.maxWheel;
      const a = angleOf(e);
      let d = a - lastAngle;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      lastAngle = a;
      // 화면 좌표에서 시계방향(+) 드래그 = 오른쪽 조향(-)
      wheel = Math.max(-this.cb.maxWheel, Math.min(this.cb.maxWheel, wheel - d));
      this.touchSteer = wheel / this.cb.maxWheel;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === active) active = -1;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  private bindLookDrag() {
    const view = document.getElementById('view')!;
    let id = -1;
    let lx = 0;
    let ly = 0;
    view.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      lx = e.clientX;
      ly = e.clientY;
      view.setPointerCapture(e.pointerId);
    });
    view.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      this.cb.onLookDrag(e.clientX - lx, e.clientY - ly);
      lx = e.clientX;
      ly = e.clientY;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === id) id = -1;
    };
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
  }

  get accel(): boolean {
    return this.touchAccel || this.keys.has('ArrowUp') || this.keys.has('KeyW');
  }

  get brake(): boolean {
    return this.touchBrake || this.keys.has('ArrowDown') || this.keys.has('KeyS') || this.keys.has('Space');
  }

  /** 키보드 조향 방향 (+1 왼쪽, -1 오른쪽, 0 유지) */
  get steerDir(): number {
    const l = this.keys.has('ArrowLeft') || this.keys.has('KeyA');
    const r = this.keys.has('ArrowRight') || this.keys.has('KeyD');
    return (l ? 1 : 0) - (r ? 1 : 0);
  }

  takeTouchSteer(): number | null {
    const v = this.touchSteer;
    this.touchSteer = null;
    return v;
  }
}
