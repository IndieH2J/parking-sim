import type { Settings } from './settings';
import { t, type Key } from './i18n';
import type { ScenarioKind, SituationGroup, TargetKind } from '../scenarios/types';
import {
  PARALLEL_LENGTH_PRESETS,
  PARALLEL_LENGTH_RANGE,
  PERP_SLOT_PRESETS,
  PERP_SLOT_RANGE,
  RAMP_RADIUS_OPTIONS,
  SITUATION_GROUPS,
} from '../scenarios/types';

// 상황 선택 시트 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C5): 위쪽 ☰ 버튼으로 연다.
// 주차하기 / 출차하기 / 주행 연습 묶음에서 상황을 고르고, 고른 상황의 옵션을 바꾼다 (⚙의 '주차장' 항목을 옮겼다).
// 고르거나 옵션을 바꾸면 시트를 열어 둔 채 다시 그린다. 시나리오를 다시 만드는 일은 main.ts가 한다 (onChange).

export const SC_LABEL: Record<ScenarioKind, Key> = {
  rearPerp: 'scRearPerp',
  frontPerp: 'scFrontPerp',
  parallel: 'scParallel',
  ramp: 'scRamp',
  rearPerpOut: 'scRearPerpOut',
  frontPerpOut: 'scFrontPerpOut',
  parallelOut: 'scParallelOut',
  alley: 'scAlley',
  uturn: 'scUturn',
  kiosk: 'scKiosk',
};

const GROUP_LABEL: Record<SituationGroup, Key> = { park: 'grpPark', pullOut: 'grpPullOut', drive: 'grpDrive' };

const on = (b: boolean) => (b ? 'on' : '');
const clamp = (v: number, r: { min: number; max: number }) => Math.max(r.min, Math.min(r.max, v));

/** 상황 선택 시트를 그리고 변경을 콜백으로 알린다. 열 때마다 다시 그린다 (⚙에서 바꾼 언어). */
export class SituationPanel {
  private readonly el: HTMLElement;

  constructor(
    private readonly s: Settings,
    /** 상황이나 옵션이 바뀐 뒤 (main.ts: 저장 → 시나리오 다시 만들기 → 다시 시작) */
    private readonly onChange: () => void,
    /** 시트를 닫은 뒤 (main.ts: 시트가 열린 동안 미룬 시나리오 안내를 띄운다) */
    private readonly onClose: () => void = () => {},
  ) {
    this.el = document.getElementById('situation-panel')!;
    document.getElementById('btn-situation')!.addEventListener('click', () => this.toggle());
    // 설정 시트처럼 Escape(버블 단계)·바깥 누르기로 닫는다
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.toggle(false);
    });
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.toggle(false);
    });
  }

  get isOpen(): boolean {
    return this.el.classList.contains('show');
  }

  toggle(show = !this.isOpen) {
    const wasOpen = this.isOpen;
    if (show && !wasOpen) this.render();
    this.el.classList.toggle('show', show);
    // 닫을 때 포커스를 푼다: input.ts는 INPUT·SELECT에 포커스가 있으면 키를 무시하고, ☰에 남으면 Space·Enter가 다시 연다.
    if (!show) {
      (document.activeElement as HTMLElement | null)?.blur();
      if (wasOpen) this.onClose();
    }
  }

  render() {
    const s = this.s;
    // 다시 그려도 시트 스크롤 위치를 유지한다 (옵션을 바꿀 때마다 맨 위로 돌아가지 않게)
    const scrollTop = this.el.querySelector('.sheet')?.scrollTop ?? 0;
    this.el.innerHTML = `
      <div class="sheet">
        <div class="sheet-head"><b>${t('situations')}</b><button id="sit-close" class="ghost" aria-label="${t('close')}" title="${t('close')}">✕</button></div>
        ${SITUATION_GROUPS.map(
          ({ group, kinds }) => `<section><h3>${t(GROUP_LABEL[group])}</h3>
          <div class="seg">
            ${kinds.map((k) => `<button data-scenario="${k}" class="${on(s.scenario === k)}">${t(SC_LABEL[k])}</button>`).join('')}
          </div>
        </section>`,
        ).join('')}
        <section id="sit-options"><h3>${t(SC_LABEL[s.scenario])}</h3>${this.options()}</section>
      </div>`;
    this.el.querySelector('.sheet')!.scrollTop = scrollTop;
    this.bind();
  }

  /** 지금 고른 상황의 옵션. 골목·유턴·발권기는 옵션 없이 설명만 */
  private options(): string {
    const s = this.s;
    switch (s.scenario) {
      case 'rearPerp':
      case 'frontPerp':
      case 'rearPerpOut':
      case 'frontPerpOut': {
        const w = s.perp.slotWidth;
        const preset = PERP_SLOT_PRESETS.includes(w);
        const r = PERP_SLOT_RANGE;
        // 출차에서 그 칸은 목표가 아니라 출발 자리다 (목표는 초록 출구 구역)
        const bayLabel = s.scenario === 'rearPerpOut' || s.scenario === 'frontPerpOut' ? 'bayPosition' : 'target';
        return `
          <div class="field"><span>${t('slotWidth')}</span>
            <div class="seg">
              ${PERP_SLOT_PRESETS.map((p) => `<button data-slot="${p}" class="${on(w === p)}">${p.toFixed(1)} m</button>`).join('')}
              <button data-slot="custom" class="${on(!preset)}">${t('slotCustom')}</button>
            </div>
            <input type="number" id="slot-custom" inputmode="decimal" min="${r.min}" max="${r.max}" step="${r.step}" value="${w}" ${preset ? 'hidden' : ''}>
            <small id="slot-custom-unit" class="unit" ${preset ? 'hidden' : ''}>m (${r.min}–${r.max})</small>
          </div>
          <div class="field"><span>${t(bayLabel)}</span>
            <div class="seg">
              <button data-target="between" class="${on(s.perp.target === 'between')}">${t('targetBetween')}</button>
              <button data-target="pillar" class="${on(s.perp.target === 'pillar')}">${t('targetPillar')}</button>
            </div>
          </div>
          <label class="chk"><input type="checkbox" id="sit-crooked" ${s.perp.crooked ? 'checked' : ''}> ${t('crooked')}</label>
          <p class="note">${t('crookedNote')}</p>`;
      }
      case 'parallel':
      case 'parallelOut': {
        const len = s.parallel.slotLength;
        const preset = PARALLEL_LENGTH_PRESETS.includes(len);
        const r = PARALLEL_LENGTH_RANGE;
        return `
          <div class="field"><span>${t('slotLength')}</span>
            <div class="seg">
              ${PARALLEL_LENGTH_PRESETS.map(
                (p) => `<button data-len="${p}" class="${on(len === p)}">${p.toFixed(1)} m${p === 6 ? ` (${t('lawStd')})` : ''}</button>`,
              ).join('')}
              <button data-len="custom" class="${on(!preset)}">${t('slotCustom')}</button>
            </div>
            <input type="number" id="len-custom" inputmode="decimal" min="${r.min}" max="${r.max}" step="${r.step}" value="${len}" ${preset ? 'hidden' : ''}>
            <small id="len-custom-unit" class="unit" ${preset ? 'hidden' : ''}>m (${r.min}–${r.max})</small>
          </div>`;
      }
      case 'ramp':
        return `
          <div class="field"><span>${t('rampRadius')}</span>
            <div class="seg">
              ${RAMP_RADIUS_OPTIONS.map(
                (r) => `<button data-radius="${r}" class="${on(s.ramp.innerRadius === r)}">${r === 6 ? t('rampR6') : r === 5 ? t('rampR5') : `${r} m`}</button>`,
              ).join('')}
            </div>
          </div>
          <p class="note">${t('rampNote')}</p>`;
      case 'alley':
        return `<p class="note">${t('alleyNote')}</p>`;
      case 'uturn':
        return `<p class="note">${t('uturnNote')}</p>`;
      case 'kiosk':
        return `<p class="note">${t('kioskNote')}</p>`;
    }
  }

  private bind() {
    const s = this.s;
    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector<T>(sel);
    const all = <T extends HTMLElement>(sel: string) => this.el.querySelectorAll<T>(sel);
    q('#sit-close')!.onclick = () => this.toggle(false);
    // 바꾸면 시나리오를 다시 만들고, 시트는 열어 둔 채 다시 그린다 (안내 토스트는 시트를 닫을 때)
    const change = () => {
      this.onChange();
      this.render();
    };
    all<HTMLButtonElement>('[data-scenario]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.scenario as ScenarioKind;
        if (k !== s.scenario) {
          s.scenario = k;
          change();
        }
        // 폰에서는 옵션 영역이 세 묶음 아래 화면 밖에 있다: 고른 상황의 옵션·설명이 보이게 스크롤한다 (이미 보이면 그대로)
        q('#sit-options')!.scrollIntoView({ block: 'nearest' });
      };
    });
    // 숫자 직접 입력: 버튼을 누르면 입력칸을 보이고, 값이 바뀌면 범위로 잘라 적용한다.
    const bindPresets = (
      attr: string,
      inputId: string,
      set: (v: number) => void,
      r: { min: number; max: number },
      presets: readonly number[],
    ) => {
      all<HTMLButtonElement>(`[data-${attr}]`).forEach((b) => {
        b.onclick = () => {
          const v = b.dataset[attr]!;
          if (v === 'custom') {
            const input = q<HTMLInputElement>(`#${inputId}`)!;
            input.hidden = false;
            q(`#${inputId}-unit`)!.hidden = false;
            all(`[data-${attr}]`).forEach((x) => x.classList.toggle('on', x === b));
            input.focus();
            return;
          }
          set(Number(v));
          change();
        };
      });
      const input = q<HTMLInputElement>(`#${inputId}`);
      if (input) {
        input.onchange = () => {
          const v = Number(input.value);
          if (input.value.trim() === '' || !Number.isFinite(v)) return;
          const cv = clamp(v, r);
          set(cv);
          // 실제로 적용한 값(범위로 자른 값)을 입력칸에 보이고, 프리셋과 같으면 그 버튼을 켠다.
          // 여기서 시트를 다시 그리지 않는다: change는 다른 버튼을 누르는 순간(blur)에도 와서, 누르던 버튼이 바뀌어 버린다.
          input.value = String(cv);
          all<HTMLButtonElement>(`[data-${attr}]`).forEach((x) => {
            const d = x.dataset[attr]!;
            x.classList.toggle('on', d === 'custom' ? !presets.includes(cv) : Number(d) === cv);
          });
          this.onChange();
        };
      }
    };
    bindPresets('slot', 'slot-custom', (v) => (s.perp.slotWidth = v), PERP_SLOT_RANGE, PERP_SLOT_PRESETS);
    bindPresets('len', 'len-custom', (v) => (s.parallel.slotLength = v), PARALLEL_LENGTH_RANGE, PARALLEL_LENGTH_PRESETS);
    all<HTMLButtonElement>('[data-target]').forEach((b) => {
      b.onclick = () => {
        s.perp.target = b.dataset.target as TargetKind;
        change();
      };
    });
    all<HTMLButtonElement>('[data-radius]').forEach((b) => {
      b.onclick = () => {
        s.ramp.innerRadius = Number(b.dataset.radius);
        change();
      };
    });
    const crooked = q<HTMLInputElement>('#sit-crooked');
    if (crooked) {
      crooked.onchange = () => {
        s.perp.crooked = crooked.checked;
        change();
      };
    }
  }
}
