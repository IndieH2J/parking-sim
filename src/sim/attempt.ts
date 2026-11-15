import type { MoveResult } from './motion';

// 시도 하나의 사건 집계 (계약서 §1.6). v3 점수가 이 값을 쓴다.

export interface AttemptEvents {
  dirChanges: number;
  elapsed: number;
  curbTouches: number;
  collisions: number;
}

/** 이보다 작은 속도(m/s)는 정지로 본다. */
const MOVE_EPS = 1e-6;
/**
 * 연석 접촉은 반대 방향으로 움직이거나, 같은 방향으로 이 거리(m)를 넘게 움직여야 끝난다.
 * 거부되면 속도가 0이 되고 크리프가 다시 붙어 연석 쪽으로 몇 mm씩 다가가는데(한 스텝 최대 약 5 cm),
 * 그 스텝마다 접촉을 끝내면 한 번 닿은 것이 여러 번으로 세어졌다 (v2 게이트, 램프에서 4회).
 */
const CONTACT_CLEAR_DIST = 0.3;

export class AttemptTracker {
  /** 처음으로 0이 아닌 속도가 적용되면 true */
  started = false;
  /** 성공 또는 충돌. reset() 전까지 step()을 무시한다. */
  finished = false;
  private dirChanges = 0;
  private elapsed = 0;
  private curbTouches = 0;
  private collisions = 0;
  private lastSign = 0;
  private inContact = false;
  /** 접촉할 때의 진행 방향 (그전에 움직인 적이 없으면 0: 어느 방향으로든 움직이면 접촉이 끝난다) */
  private contactSign = 0;
  /** 접촉 뒤 움직인 거리 */
  private sinceContact = 0;

  /**
   * 시뮬레이션 스텝마다 한 번. appliedSpeed = 실제로 적용한 속도 (정지·거부면 0).
   * result = 이번 스텝의 MoveResult, 이동을 시도하지 않았으면 null.
   */
  step(dt: number, appliedSpeed: number, result: MoveResult | null): { newCurbTouch: boolean } {
    if (this.finished) return { newCurbTouch: false };
    const moving = Math.abs(appliedSpeed) > MOVE_EPS;
    if (moving) {
      this.started = true;
      const sign = Math.sign(appliedSpeed);
      // 반대 방향으로 움직이거나 같은 방향으로 CONTACT_CLEAR_DIST를 넘게 움직이면 연석 접촉이 끝난다
      if (this.inContact) {
        this.sinceContact += Math.abs(appliedSpeed) * dt;
        if (sign !== this.contactSign || this.sinceContact > CONTACT_CLEAR_DIST) this.inContact = false;
      }
      // 진행 방향이 마지막으로 움직인 방향과 다르면 전환 1회 (기어 조작·정지는 세지 않음)
      if (this.lastSign !== 0 && sign !== this.lastSign) this.dirChanges++;
      this.lastSign = sign;
    }
    if (this.started) this.elapsed += dt;
    // 연석 접촉 에피소드: 바퀴가 연석에 막힌 첫 스텝만 센다. 휠스톱은 세지 않는다.
    let newCurbTouch = false;
    if (result?.kind === 'wheel' && result.element.kind === 'curb' && !this.inContact) {
      this.curbTouches++;
      this.inContact = true;
      this.contactSign = this.lastSign;
      this.sinceContact = 0;
      newCurbTouch = true;
    }
    return { newCurbTouch };
  }

  crash(): void {
    this.collisions = 1;
    this.finished = true;
  }

  finish(): void {
    this.finished = true;
  }

  reset(): void {
    this.started = false;
    this.finished = false;
    this.dirChanges = 0;
    this.elapsed = 0;
    this.curbTouches = 0;
    this.collisions = 0;
    this.lastSign = 0;
    this.inContact = false;
    this.contactSign = 0;
    this.sinceContact = 0;
  }

  get events(): AttemptEvents {
    return { dirChanges: this.dirChanges, elapsed: this.elapsed, curbTouches: this.curbTouches, collisions: this.collisions };
  }
}
