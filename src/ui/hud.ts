import { DOOR_CAP, type ScoreItem, type ScoreKey } from '../sim/score';
import type { SensorReadings } from '../sim/sensors';
import type { Gear } from '../sim/vehicle';
import { t, type Key } from './i18n';

function color(d: number): string {
  if (d < 0.3) return '#ff3b30';
  if (d < 0.6) return '#ff9f0a';
  if (d < 1.0) return '#ffd60a';
  return '#8e8e93';
}

const cm = (d: number) => `${Math.round(d * 100)}`;

/** 차 아이콘 주변에 구역별 거리(cm)를 그린다. 흰 숫자 = 장애물, 하늘색 = 주차선. */
export function drawSensors(canvas: HTMLCanvasElement, r: SensorReadings) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const cw = w * 0.3;
  const ch = h * 0.5;
  const x0 = cx - cw / 2;
  const y0 = cy - ch / 2;
  ctx.fillStyle = '#e6e7ea';
  ctx.beginPath();
  ctx.roundRect(x0, y0, cw, ch, 8);
  ctx.fill();
  // 미러
  const my = y0 + ch * 0.24;
  ctx.fillRect(x0 - 5, my, 5, 6);
  ctx.fillRect(x0 + cw, my, 5, 6);
  ctx.fillStyle = '#5ac8fa';
  ctx.fillRect(x0 + 4, y0 + 4, cw - 8, 4); // 앞쪽 표시

  ctx.font = `600 ${Math.round(h * 0.06)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const bar = (x: number, y: number, bw: number, bh: number, d: number | null) => {
    if (d === null) return;
    ctx.fillStyle = color(d);
    ctx.fillRect(x, y, bw, bh);
  };
  const label = (x: number, y: number, d: number | null, col = '#ffffff') => {
    if (d === null) return;
    ctx.fillStyle = col;
    ctx.fillText(cm(d), x, y);
  };
  const z = r.zones;
  const gap = 4;
  const third = cw / 3;
  bar(x0, y0 - gap - 4, third, 4, z.frontLeft);
  bar(x0 + third, y0 - gap - 4, third, 4, z.frontCenter);
  bar(x0 + 2 * third, y0 - gap - 4, third, 4, z.frontRight);
  bar(x0, y0 + ch + gap, third, 4, z.rearLeft);
  bar(x0 + third, y0 + ch + gap, third, 4, z.rearCenter);
  bar(x0 + 2 * third, y0 + ch + gap, third, 4, z.rearRight);
  bar(x0 - gap - 4, y0 + ch * 0.35, 4, ch * 0.55, z.left);
  bar(x0 + cw + gap, y0 + ch * 0.35, 4, ch * 0.55, z.right);
  bar(x0 - gap - 9, my, 4, 6, z.mirrorLeft);
  bar(x0 + cw + gap + 5, my, 4, 6, z.mirrorRight);

  const fy = y0 - h * 0.1;
  const ry = y0 + ch + h * 0.1;
  label(x0 - 2, fy, z.frontLeft);
  label(cx, fy - h * 0.04, z.frontCenter);
  label(x0 + cw + 2, fy, z.frontRight);
  label(x0 - 2, ry, z.rearLeft);
  label(cx, ry + h * 0.04, z.rearCenter);
  label(x0 + cw + 2, ry, z.rearRight);
  const lx = x0 - w * 0.17;
  const rx = x0 + cw + w * 0.17;
  label(lx, my + 3, z.mirrorLeft);
  label(rx, my + 3, z.mirrorRight);
  label(lx, cy + ch * 0.12, z.left);
  label(rx, cy + ch * 0.12, z.right);
  // 주차선까지 (하늘색)
  const lc = '#64d2ff';
  label(lx, my + 3 + h * 0.08, r.lines.leftMirror, lc);
  label(rx, my + 3 + h * 0.08, r.lines.rightMirror, lc);
  label(lx, cy + ch * 0.12 + h * 0.08, r.lines.leftBody, lc);
  label(rx, cy + ch * 0.12 + h * 0.08, r.lines.rightBody, lc);
}

export function updateStatus(el: HTMLElement, gear: Gear, speed: number, wheelDeg: number) {
  const gears = (['P', 'R', 'N', 'D'] as Gear[])
    .map((g) => `<span class="${g === gear ? 'on' : ''}">${g}</span>`)
    .join('');
  el.innerHTML = `<div class="gears">${gears}</div><div class="spd">${Math.round(Math.abs(speed) * 3.6)}<small>km/h</small></div><div class="whl">⟳ ${Math.round(wheelDeg)}°</div>`;
}

let toastTimer = 0;
export function toast(text: string, ms = 1800) {
  const el = document.getElementById('toast')!;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

function hideToast() {
  clearTimeout(toastTimer);
  document.getElementById('toast')!.classList.remove('show');
}

/** 포커스가 버튼·스크럽에 남으면 Space·Enter가 그 버튼을 누르거나 input.ts가 운전 키를 무시한다 */
function blurActive() {
  (document.activeElement as HTMLElement | null)?.blur();
}

export interface OverlayOptions {
  /** 닫기 버튼을 두고 Escape로도 닫는다 */
  dismissable?: boolean;
  /** 다시 시작과 닫기 사이에 놓는 버튼 (리플레이). 누르면 카드를 숨긴 뒤 onClick */
  actions?: { label: string; onClick: () => void }[];
}

/** 지금 떠 있는 카드의 키보드 동작 (Enter = 다시 시작, Escape = 닫기) */
let cardKeys: { restart: () => void; close: (() => void) | null } | null = null;

/** 결과 카드 (계약서 §5.4). 버튼 순서: 다시 시작, actions, 닫기. */
export function showOverlay(html: string, onRestart: () => void, opts: OverlayOptions = {}) {
  const el = document.getElementById('overlay')!;
  const actions = opts.actions ?? [];
  el.innerHTML = `<div class="card">${html}<div class="row"><button id="ov-restart">${t('restart')}</button>${actions
    .map((a, i) => `<button data-action="${i}">${a.label}</button>`)
    .join('')}${opts.dismissable ? `<button id="ov-close" class="ghost">${t('close')}</button>` : ''}</div></div>`;
  const restart = () => {
    hideOverlay();
    onRestart();
  };
  el.querySelector<HTMLButtonElement>('#ov-restart')!.onclick = restart;
  el.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => {
    b.onclick = () => {
      hideOverlay();
      actions[Number(b.dataset.action)].onClick();
    };
  });
  const close = opts.dismissable ? hideOverlay : null;
  if (close) el.querySelector<HTMLButtonElement>('#ov-close')!.onclick = close;
  cardKeys = { restart, close };
  hideToast(); // 재시작 직후 4초 안에 카드가 뜨면 시나리오 안내가 카드 뒤로 비쳤다
  blurActive();
  el.classList.add('show');
}

export function hideOverlay() {
  const el = document.getElementById('overlay')!;
  el.classList.remove('show');
  cardKeys = null;
  if (el.contains(document.activeElement)) blurActive(); // 누른 카드 버튼에 포커스가 남지 않게
}

export function overlayOpen(): boolean {
  return document.getElementById('overlay')!.classList.contains('show');
}

// 결과 카드의 키보드: Enter = 다시 시작, Escape = 닫기 (닫을 수 있는 카드만).
// 캡처 단계라 시트들의 Escape 처리보다 먼저 온다: 시트가 카드 위에 떠 있으면 시트에 맡긴다 (Escape 한 번에 둘 다 닫히지 않게).
// 카드 안 버튼에 포커스가 있으면 Enter는 그 버튼을 누른다 (브라우저 기본 동작).
window.addEventListener(
  'keydown',
  (e) => {
    if (!cardKeys || e.repeat || !overlayOpen()) return;
    if (document.querySelector('#settings-panel.show, #records-panel.show, #situation-panel.show')) return;
    if (e.key === 'Escape' && cardKeys.close) {
      e.preventDefault();
      cardKeys.close();
    } else if (e.key === 'Enter' && !(e.target instanceof Element && e.target.closest('#overlay button'))) {
      e.preventDefault();
      cardKeys.restart();
    }
  },
  true,
);

// ---- 점수 (계약서 §5.4, §6 v3 키) ----
const SCORE_LABEL: Record<ScoreKey, Key> = {
  angle: 'scoreAngle',
  center: 'scoreCenter',
  curbGap: 'scoreCurbGap',
  doorLeft: 'scoreDoorLeft',
  doorRight: 'scoreDoorRight',
  moves: 'scoreMoves',
  time: 'scoreTime',
  curb: 'scoreCurb',
  gap: 'scoreGap',
  reach: 'scoreReach',
  align: 'scoreAlign',
};

/** 횟수: 한국어 '2회', 영어는 단위 없이 '2' (라벨이 Curb touches·Direction changes라 그대로 읽힌다) */
export const countText = (n: number) => `${n}${t('times')}`;
export const secText = (s: number) => `${s.toFixed(1)} ${t('sec')}`;
export const cmText = (v: number) => `${Math.round(v * 100)} ${t('cm')}`;

function valueText(it: ScoreItem): string {
  const v = it.value;
  if (v === null) return '';
  switch (it.key) {
    case 'angle':
      return `${v.toFixed(1)}°`;
    case 'moves':
    case 'curb':
      return countText(v);
    case 'time':
      return secText(v);
    case 'doorLeft':
    case 'doorRight':
      // 상한에 닿은 값은 잰 거리가 아니라 '그 이상'이다 (평행 주차는 양쪽이 늘 1 m 밖이라 '100 cm'로 읽혔다)
      return v >= DOOR_CAP ? `≥ ${cmText(DOOR_CAP)}` : cmText(v);
    default:
      return cmText(v); // center, curbGap (m)
  }
}

const ptsText = (p: number) => (Number.isInteger(p) ? String(p) : p.toFixed(1));

/** 총점과 새 최고 기록 배지 */
export function scoreTotalHtml(total: number, newBest: boolean): string {
  return `<div class="total"><b>${total}</b><small>${t('pts')}</small>${newBest ? `<span class="badge">${t('newBest')}</span>` : ''}</div>`;
}

/** 항목별 점수: 이름 · 원래 값 · 점수/만점 (깎인 항목은 강조) */
export function scoreRowsHtml(items: ScoreItem[]): string {
  const rows = items
    .map(
      (it) =>
        `<div><span>${t(SCORE_LABEL[it.key])}</span><span>${valueText(it)}</span><span class="${it.points < it.max ? 'lost' : 'full'}">${ptsText(it.points)}/${it.max}</span></div>`,
    )
    .join('');
  return `<div class="bd">${rows}</div>`;
}
