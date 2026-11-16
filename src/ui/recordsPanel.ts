import type { RecordEntry } from '../sim/records';
import type { VehicleSpec } from '../sim/specs';
import { CUSTOM_ID } from '../sim/vehicles';
import { secText } from './hud';
import { getLang, t } from './i18n';
import type { Settings } from './settings';
import { SC_LABEL } from './situationPanel';

// 기록 패널 (계약서 §5.4): 위쪽 ★ 버튼으로 연다. 지금 설정(주차 유형 + 옵션 + 차)의 최고 기록과 최근 기록.
// 저장소는 main.ts가 다룬다 (RecordsSource).

export interface RecordsSource {
  /** 지금 조건의 이름 (setupLabel) */
  label(): string;
  /** 지금 조건의 기록. 없으면 null */
  entry(): RecordEntry | null;
  /** 지금 조건의 기록을 지운다 */
  clear(): void;
}

/** 조건 이름: 주차 유형 · 옵션 · 차 (기록 키와 같은 항목). 직접 입력 차는 기록 키를 이루는 치수 8개를 모두 붙인다. */
export function setupLabel(s: Settings, spec: VehicleSpec): string {
  const m = (v: number) => `${Number(v.toFixed(2))} m`;
  const parts = [t(SC_LABEL[s.scenario])];
  switch (s.scenario) {
    case 'rearPerp':
    case 'frontPerp':
    case 'rearPerpOut':
    case 'frontPerpOut':
      parts.push(`${t('slotWidth')} ${m(s.perp.slotWidth)}`, t(s.perp.target === 'between' ? 'targetBetween' : 'targetPillar'));
      // 옆 차 비뚤게: 기록 키처럼 켰을 때만 붙인다 (계약서 개정 2026-11-16 situations)
      if (s.perp.crooked) parts.push(t('crooked'));
      break;
    case 'parallel':
    case 'parallelOut':
      parts.push(`${t('slotLength')} ${m(s.parallel.slotLength)}`);
      break;
    case 'ramp':
      parts.push(`${t('rampRadius')} ${m(s.ramp.innerRadius)}`);
      break;
    // 골목·유턴·발권기는 옵션이 없다 (기록 키도 상황과 차뿐)
    case 'alley':
    case 'uturn':
    case 'kiosk':
      break;
  }
  const name = spec.name[getLang()];
  const mm = (v: number) => Math.round(v * 1000);
  // 직접 입력 차: 치수 하나만 달라도 다른 조건(기록 키)이라, 전장 × 전폭만 보이면 전고 등을 바꿨을 때 기록이 사라진 것처럼 보였다
  parts.push(
    spec.id === CUSTOM_ID
      ? `${name} ${mm(spec.length)} × ${mm(spec.width)} × ${mm(spec.height)} mm · ${t('mirrorShort')} ${mm(spec.widthMirrors)} mm · ` +
          `${t('dimWheelbase')} ${mm(spec.wheelbase)} mm · ${t('dimFrontOverhang')} ${mm(spec.frontOverhang)} mm · ` +
          `${t('dimTrack')} ${mm(spec.trackFront)} mm · ${t('turnCircle')} ${spec.turningDiameter.toFixed(2)} m`
      : name,
  );
  return parts.join(' · ');
}

/** 월/일 시:분 (예: 11. 15. 10:23, 11/15, 10:23) */
function dateText(at: number): string {
  return new Date(at).toLocaleString(getLang() === 'ko' ? 'ko-KR' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export class RecordsPanel {
  private readonly el: HTMLElement;

  constructor(private readonly src: RecordsSource) {
    this.el = document.getElementById('records-panel')!;
    document.getElementById('btn-records')!.addEventListener('click', () => this.open());
    // 설정 시트처럼 Escape·바깥 누르기로 닫는다
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    });
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
  }

  get isOpen(): boolean {
    return this.el.classList.contains('show');
  }

  open(): void {
    this.render();
    this.el.classList.add('show');
  }

  close(): void {
    this.el.classList.remove('show');
    // ★·지우기 버튼에 포커스가 남으면 Space·Enter가 그 버튼을 다시 누른다
    (document.activeElement as HTMLElement | null)?.blur();
  }

  private render(): void {
    const e = this.src.entry();
    const best = e?.best ?? null;
    const recent = e?.recent ?? [];
    const none = `<p class="note">${t('noRecords')}</p>`;
    const rows = recent
      .map(
        (a) =>
          `<tr><td>${dateText(a.at)}</td><td class="${a.outcome === 'success' ? 'good' : 'bad'}">${t(
            a.outcome === 'success' ? 'outcomeSuccess' : 'outcomeCrash',
          )}</td><td>${a.score}</td><td>${secText(a.time)}</td><td>${a.moves}</td><td>${a.curb}</td></tr>`,
      )
      .join('');
    const scrollTop = this.el.querySelector('.sheet')?.scrollTop ?? 0;
    this.el.innerHTML = `
      <div class="sheet">
        <div class="sheet-head"><b>${t('records')}</b><button id="rec-close" class="ghost" aria-label="${t('close')}" title="${t('close')}">✕</button></div>
        <section><h3>${t('setup')}</h3><p class="rec-setup">${this.src.label()}</p></section>
        <section><h3>${t('best')}</h3>${
          // 충돌만 있으면 최근 기록은 있으므로 '아직 기록이 없습니다' 대신 줄표 (충돌은 최고 기록이 되지 않는다)
          best ? `<p class="rec-best"><b>${best.score}</b> ${t('pts')} · ${dateText(best.at)}</p>` : recent.length ? '<p class="note">—</p>' : none
        }</section>
        <section><h3>${t('recent')}</h3>${
          recent.length
            ? `<table class="rec"><thead><tr><th>${t('date')}</th><th>${t('outcome')}</th><th>${t('score')}</th><th>${t(
                'scoreTime',
              )}</th><th>${t('scoreMoves')}</th><th>${t('scoreCurb')}</th></tr></thead><tbody>${rows}</tbody></table>`
            : none
        }</section>
        <section><button id="rec-clear" ${e ? '' : 'disabled'}>${t('clearRecords')}</button></section>
      </div>`;
    this.el.querySelector('.sheet')!.scrollTop = scrollTop;
    this.el.querySelector<HTMLButtonElement>('#rec-close')!.onclick = () => this.close();
    this.el.querySelector<HTMLButtonElement>('#rec-clear')!.onclick = () => {
      if (!confirm(t('confirmClear'))) return;
      this.src.clear();
      this.render();
    };
  }
}
