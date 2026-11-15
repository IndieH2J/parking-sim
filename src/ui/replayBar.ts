import type { PlaybackRate } from '../sim/replay';
import { t } from './i18n';

// 리플레이 조작 막대 (계약서 §5.3). DOM을 만들고 조작을 콜백으로 넘긴다. CSS는 v3-ui가 쓴다.
//   div#replay-bar.panel
//     button.rb-play | input.rb-scrub[type=range] | span.rb-time
//     div.rb-rate > button[data-rate] ×4
//     div.rb-cam > button[data-cam] ×2   (3D만)
//     button.rb-close
// 눌린 배속·카메라 버튼은 class "on" (설정 패널의 .seg button.on과 같은 규칙)과 aria-pressed로 표시한다.

export interface ReplayBarCallbacks {
  onToggle(): void;
  onSeek(t: number): void;
  onRate(r: PlaybackRate): void;
  onCamera(c: 'driver' | 'chase'): void;
  onClose(): void;
}

type Cam = 'driver' | 'chase';
const RATES: readonly PlaybackRate[] = [0.5, 1, 2, 4];
const CAMS: readonly Cam[] = ['driver', 'chase'];

/** m:ss.s (0.1초 단위) */
function fmt(sec: number): string {
  const tenths = Math.round(Math.max(0, sec) * 10);
  const m = Math.floor(tenths / 600);
  return `${m}:${((tenths - m * 600) / 10).toFixed(1).padStart(4, '0')}`;
}

export class ReplayBar {
  private readonly el: HTMLDivElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly scrub: HTMLInputElement;
  private readonly timeEl: HTMLSpanElement;
  private readonly rateBox: HTMLDivElement;
  private readonly camBox: HTMLDivElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly rateBtns: HTMLButtonElement[];
  private readonly camBtns: HTMLButtonElement[];
  private duration = 0;
  /** 스크럽 막대를 누르고 있는 동안에는 setTime이 막대 값을 덮어쓰지 않는다 */
  private dragging = false;
  /** 매 프레임 같은 값을 DOM에 다시 쓰지 않도록 마지막으로 쓴 값 */
  private shownValue = NaN;
  private shownText = '';
  private shownPlaying: boolean | null = null;

  constructor(host: HTMLElement, cb: ReplayBarCallbacks) {
    const el = document.createElement('div');
    el.id = 'replay-bar';
    el.className = 'panel';
    el.style.display = 'none';
    el.innerHTML =
      '<button class="rb-play"></button>' +
      '<input class="rb-scrub" type="range" min="0" max="0" step="any" value="0">' +
      '<span class="rb-time"></span>' +
      `<div class="rb-rate" role="group">${RATES.map((r) => `<button data-rate="${r}">${r}×</button>`).join('')}</div>` +
      `<div class="rb-cam" role="group">${CAMS.map((c) => `<button data-cam="${c}"></button>`).join('')}</div>` +
      '<button class="rb-close">✕</button>';
    this.el = el;
    this.playBtn = el.querySelector<HTMLButtonElement>('.rb-play')!;
    this.scrub = el.querySelector<HTMLInputElement>('.rb-scrub')!;
    this.timeEl = el.querySelector<HTMLSpanElement>('.rb-time')!;
    this.rateBox = el.querySelector<HTMLDivElement>('.rb-rate')!;
    this.camBox = el.querySelector<HTMLDivElement>('.rb-cam')!;
    this.closeBtn = el.querySelector<HTMLButtonElement>('.rb-close')!;
    this.rateBtns = [...this.rateBox.querySelectorAll<HTMLButtonElement>('button')];
    this.camBtns = [...this.camBox.querySelectorAll<HTMLButtonElement>('button')];

    this.playBtn.addEventListener('click', () => cb.onToggle());
    this.scrub.addEventListener('input', () => cb.onSeek(Number(this.scrub.value)));
    this.scrub.addEventListener('pointerdown', () => (this.dragging = true));
    // 값이 처음과 같아지면 change가 오지 않으므로 손을 뗄 때도 푼다 (막대 밖에서 떼도 잡히게 window에서)
    const release = () => (this.dragging = false);
    this.scrub.addEventListener('change', release);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    for (const b of this.rateBtns) {
      b.addEventListener('click', () => {
        const r = Number(b.dataset.rate) as PlaybackRate;
        this.markRate(r);
        cb.onRate(r);
      });
    }
    for (const b of this.camBtns) {
      b.addEventListener('click', () => {
        const c = b.dataset.cam as Cam;
        this.markCam(c);
        cb.onCamera(c);
      });
    }
    this.closeBtn.addEventListener('click', () => cb.onClose());
    host.appendChild(el);
  }

  /**
   * 막대를 보인다. 콜백은 부르지 않는다. 표시는 1배속(새 Playback의 rate)과 추적 카메라('chase')로 되돌리므로,
   * 리플레이마다 새 Playback을 만들고 3D는 ChaseCam으로 시작한다. 카메라 버튼은 '3d'에서만 보인다.
   * 글자는 relabel()로 t()에서 다시 넣는다.
   */
  show(duration: number, mode: 'top' | '3d'): void {
    this.duration = Math.max(0, duration);
    this.scrub.max = String(this.duration);
    this.camBox.style.display = mode === '3d' ? '' : 'none';
    this.markRate(1);
    this.markCam('chase');
    this.relabel();
    this.dragging = false;
    this.shownValue = NaN;
    this.shownText = '';
    this.setTime(0, false);
    this.el.style.display = '';
  }

  /** 글자를 지금 언어로 다시 넣는다 (show, 그리고 리플레이 중에 언어를 바꿨을 때). 재생 버튼 이름은 다음 setTime에서 바뀐다. */
  relabel(): void {
    this.el.setAttribute('aria-label', t('replay'));
    this.scrub.setAttribute('aria-label', t('replay'));
    this.rateBox.setAttribute('aria-label', t('speed'));
    this.rateBox.title = t('speed');
    this.camBtns[0].textContent = t('camDriver');
    this.camBtns[1].textContent = t('camChase');
    this.closeBtn.title = t('exitReplay');
    this.closeBtn.setAttribute('aria-label', t('exitReplay'));
    this.shownPlaying = null;
  }

  hide(): void {
    this.el.style.display = 'none';
    this.dragging = false;
    // 스크럽(INPUT)에 포커스가 남으면 input.ts가 키를 무시해 운전 키가 먹지 않는다
    const a = document.activeElement;
    if (a instanceof HTMLElement && this.el.contains(a)) a.blur();
  }

  /** 매 프레임 불러도 된다: 바뀐 값만 DOM에 쓴다. */
  setTime(time: number, playing: boolean): void {
    if (!this.dragging && time !== this.shownValue) {
      this.scrub.value = String(time);
      this.shownValue = time;
    }
    const text = `${fmt(time)} / ${fmt(this.duration)}`;
    if (text !== this.shownText) {
      this.timeEl.textContent = text;
      this.shownText = text;
    }
    if (playing !== this.shownPlaying) {
      this.shownPlaying = playing;
      // U+FE0E: 이모지가 아닌 글자 모양으로
      this.playBtn.textContent = playing ? '❚❚' : '▶︎';
      const label = t(playing ? 'pause' : 'play');
      this.playBtn.title = label;
      this.playBtn.setAttribute('aria-label', label);
    }
  }

  private markRate(r: PlaybackRate): void {
    for (const b of this.rateBtns) this.mark(b, Number(b.dataset.rate) === r);
  }

  private markCam(c: Cam): void {
    for (const b of this.camBtns) this.mark(b, b.dataset.cam === c);
  }

  private mark(b: HTMLButtonElement, on: boolean): void {
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}
