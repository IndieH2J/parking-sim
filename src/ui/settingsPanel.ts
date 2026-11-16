import type { Settings } from './settings';
import { getLang, t, type Key, type Lang } from './i18n';
import type { ScenarioKind, TargetKind } from '../scenarios/types';
import {
  PARALLEL_LENGTH_PRESETS,
  PARALLEL_LENGTH_RANGE,
  PERP_SLOT_PRESETS,
  PERP_SLOT_RANGE,
  RAMP_RADIUS_OPTIONS,
  SCENARIO_KINDS,
} from '../scenarios/types';
import type { CustomDims, GhostAlign } from '../sim/vehicles';
import { CUSTOM_ID, CUSTOM_LIMITS, getSpec, listVehicles, validateCustomDims } from '../sim/vehicles';

export type ChangeKind = 'aids' | 'driver' | 'world' | 'lang' | 'vehicle' | 'ghost' | 'controls';

export const SC_LABEL: Record<ScenarioKind, Key> = {
  rearPerp: 'scRearPerp',
  frontPerp: 'scFrontPerp',
  parallel: 'scParallel',
  ramp: 'scRamp',
};

/** 추정값 필드 이름 → 표시 이름 (계약서 §6) */
const DIM_LABEL: Record<string, Key> = {
  length: 'dimLength',
  width: 'dimWidth',
  widthMirrors: 'dimMirrors',
  height: 'dimHeight',
  wheelbase: 'dimWheelbase',
  frontOverhang: 'dimFrontOverhang',
  rearOverhang: 'dimRearOverhang',
  trackFront: 'dimTrack',
  trackRear: 'dimTrack',
  turningDiameter: 'dimTurning',
  groundClearance: 'dimGround',
  tireWidth: 'dimTire',
  tireDiameter: 'dimTire',
};
/** 직접 입력에서 입력받지 않고 추정하는 치수 (vehicles.ts customToPrimary) */
const CUSTOM_ESTIMATED = ['groundClearance', 'tireWidth', 'tireDiameter'];

const CUSTOM_FIELDS: { f: keyof CustomDims; label: Key; unit: 'mm' | 'm' }[] = [
  { f: 'lengthMm', label: 'dimLength', unit: 'mm' },
  { f: 'widthMm', label: 'dimWidth', unit: 'mm' },
  { f: 'widthMirrorsMm', label: 'dimMirrors', unit: 'mm' },
  { f: 'heightMm', label: 'dimHeight', unit: 'mm' },
  { f: 'wheelbaseMm', label: 'dimWheelbase', unit: 'mm' },
  { f: 'frontOverhangMm', label: 'dimFrontOverhang', unit: 'mm' },
  { f: 'trackMm', label: 'dimTrack', unit: 'mm' },
  { f: 'turningDiameterM', label: 'dimTurning', unit: 'm' },
];

const on = (b: boolean) => (b ? 'on' : '');
const clamp = (v: number, r: { min: number; max: number }) => Math.max(r.min, Math.min(r.max, v));

/** 설정 패널을 그리고 변경을 콜백으로 알린다. 언어가 바뀌면 다시 그린다. */
export class SettingsPanel {
  private readonly el: HTMLElement;

  constructor(
    private readonly s: Settings,
    private readonly onChange: (kind: ChangeKind) => void,
    /** 시트를 닫은 뒤 (main.ts: 시트가 열린 동안 미룬 시나리오 안내를 띄운다) */
    private readonly onClose: () => void = () => {},
  ) {
    this.el = document.getElementById('settings-panel')!;
    document.getElementById('btn-settings')!.addEventListener('click', () => this.toggle());
    // Escape로 시트를 닫는다 (닫을 때 포커스도 풀린다)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.el.classList.contains('show')) this.toggle(false);
    });
    this.render();
  }

  get isOpen(): boolean {
    return this.el.classList.contains('show');
  }

  toggle(show?: boolean) {
    const wasOpen = this.isOpen;
    this.el.classList.toggle('show', show);
    // 닫을 때 포커스를 푼다: input.ts는 INPUT·SELECT에 포커스가 있으면 키를 무시한다 (계약서 §3.4).
    if (!this.isOpen) {
      (document.activeElement as HTMLElement | null)?.blur();
      if (wasOpen) this.onClose();
    }
  }

  render() {
    const s = this.s;
    const a = s.aids;
    const lang = getLang();
    const coarse = matchMedia('(pointer: coarse)').matches;
    const chk = (id: string, checked: boolean, label: string) =>
      `<label class="chk"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}> ${label}</label>`;
    const range = (id: string, label: string, min: number, max: number, step: number, v: number, unit: string) =>
      `<label class="rng"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}"><output id="${id}-o">${v}${unit}</output></label>`;
    const vehicles = listVehicles();
    const vehOptions = (sel: string) =>
      [
        ...vehicles.map((v) => `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${v.name[lang]}</option>`),
        `<option value="${CUSTOM_ID}" ${sel === CUSTOM_ID ? 'selected' : ''}>${t('vehicleCustom')}</option>`,
      ].join('');
    // 다시 그려도 시트 스크롤 위치를 유지한다 (옵션을 바꿀 때마다 맨 위로 돌아가지 않게)
    const scrollTop = this.el.querySelector('.sheet')?.scrollTop ?? 0;
    this.el.innerHTML = `
      <div class="sheet">
        <div class="sheet-head"><b>${t('settings')}</b><button id="set-close" class="ghost" aria-label="${t('close')}" title="${t('close')}">✕</button></div>
        <section><h3>${t('language')}</h3>
          <div class="seg">
            <button data-lang="ko" class="${on(lang === 'ko')}">한국어</button>
            <button data-lang="en" class="${on(lang === 'en')}">English</button>
          </div>
        </section>
        <section><h3>${t('aids')}</h3>
          ${chk('aid-mirrors', a.mirrors, t('mirrors'))}
          ${chk('aid-minimap', a.minimap, t('minimap'))}
          ${chk('aid-distance', a.distance, t('distance'))}
          ${chk('aid-rearCam', a.rearCam, t('rearCam'))}
          ${chk('aid-guides', a.guides, t('guides'))}
          <div class="seg"><button id="feel">${t('feelMode')}</button><button id="allaids">${t('allAids')}</button></div>
        </section>
        <section><h3>${t('driver')}</h3>
          <p class="note">${t('estimateNote')}</p>
          ${range('drv-h', t('driverHeight'), 150, 195, 1, s.driverHeightCm, ' cm')}
          ${range('drv-sh', t('seatHeight'), -6, 6, 1, s.seatHeightCm, ' cm')}
          ${range('drv-sf', t('seatFore'), -12, 12, 1, s.seatForeCm, ' cm')}
          ${range('drv-fov', t('fov'), 45, 75, 1, s.fov, '°')}
          ${chk('calib', s.calibMarks, t('calibMarks'))}
          ${chk('mirror-tilt', s.mirrorTiltReverse, t('mirrorTilt'))}
          <p class="note">${t('mirrorTiltNote')}</p>
        </section>
        <section><h3>${t('lot')}</h3>
          <div class="field"><span>${t('scenario')}</span>
            <div class="seg">
              ${SCENARIO_KINDS.map((k) => `<button data-scenario="${k}" class="${on(s.scenario === k)}">${t(SC_LABEL[k])}</button>`).join('')}
            </div>
          </div>
          ${this.scenarioOptions()}
        </section>
        <section><h3>${t('vehicle')}</h3>
          <select id="veh-select">${vehOptions(s.vehicle)}</select>
          <p class="note">${this.vehicleInfo()}</p>
          ${s.vehicle === CUSTOM_ID ? this.customForm() : ''}
        </section>
        <section><h3>${t('ghost')}</h3>
          ${chk('ghost-on', s.ghost.enabled, t('ghostShow'))}
          <div class="field"><span>${t('ghostVehicle')}</span>
            <select id="ghost-veh">${vehOptions(s.ghost.vehicle)}</select>
          </div>
          <div class="field"><span>${t('ghostAlign')}</span>
            <div class="seg">
              <button data-align="driver" class="${on(s.ghost.align === 'driver')}">${t('alignDriver')}</button>
              <button data-align="rearAxle" class="${on(s.ghost.align === 'rearAxle')}">${t('alignRearAxle')}</button>
            </div>
          </div>
          <p class="note">${t('ghostNote')}</p>
        </section>
        <section><h3>${t('controls')}</h3>
          ${coarse ? '' : chk('auto-shift', s.autoShift, t('autoShift'))}
          <p class="note">${coarse ? t('touchHelp') : s.autoShift ? t('keysHelpAuto') : t('keysHelp')}</p>
        </section>
      </div>`;
    this.el.querySelector('.sheet')!.scrollTop = scrollTop;
    this.bind();
  }

  /** 지금 고른 주차 유형의 옵션 */
  private scenarioOptions(): string {
    const s = this.s;
    switch (s.scenario) {
      case 'rearPerp':
      case 'frontPerp': {
        const w = s.perp.slotWidth;
        const preset = PERP_SLOT_PRESETS.includes(w);
        const r = PERP_SLOT_RANGE;
        return `
          <div class="field"><span>${t('slotWidth')}</span>
            <div class="seg">
              ${PERP_SLOT_PRESETS.map((p) => `<button data-slot="${p}" class="${on(w === p)}">${p.toFixed(1)} m</button>`).join('')}
              <button data-slot="custom" class="${on(!preset)}">${t('slotCustom')}</button>
            </div>
            <input type="number" id="slot-custom" inputmode="decimal" min="${r.min}" max="${r.max}" step="${r.step}" value="${w}" ${preset ? 'hidden' : ''}>
            <small id="slot-custom-unit" class="unit" ${preset ? 'hidden' : ''}>m (${r.min}–${r.max})</small>
          </div>
          <div class="field"><span>${t('target')}</span>
            <div class="seg">
              <button data-target="between" class="${on(s.perp.target === 'between')}">${t('targetBetween')}</button>
              <button data-target="pillar" class="${on(s.perp.target === 'pillar')}">${t('targetPillar')}</button>
            </div>
          </div>`;
      }
      case 'parallel': {
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
    }
  }

  /** 전장 × 전폭 mm · 미러 mm · 회전 직경 m (+ 추정값 포함: 항목) */
  private vehicleInfo(): string {
    const s = this.s;
    const spec = getSpec(s.vehicle, s.customDims);
    const mm = (m: number) => Math.round(m * 1000);
    const est = s.vehicle === CUSTOM_ID ? CUSTOM_ESTIMATED : (listVehicles().find((v) => v.id === s.vehicle)?.estimated ?? []);
    const labels = [...new Set(est.map((f) => DIM_LABEL[f]).filter((k): k is Key => k !== undefined))].map((k) => t(k));
    const line = `${mm(spec.length)} × ${mm(spec.width)} mm · ${t('mirrorShort')} ${mm(spec.widthMirrors)} mm · ${t('turnCircle')} ${spec.turningDiameter.toFixed(2)} m`;
    return labels.length ? `${line}<br>${t('estimatedDims')}: ${labels.join(', ')}` : line;
  }

  /** 직접 입력 8칸 + 적용. 입력값은 적용하기 전까지 이 폼에만 있다 (잘못된 값은 설정에 들어가지 않는다). */
  private customForm(): string {
    const c = this.s.customDims;
    return `
      <div class="dims">
        <h4>${t('dimsTitle')}</h4>
        ${CUSTOM_FIELDS.map(({ f, label, unit }) => {
          const lim = CUSTOM_LIMITS[f];
          return `<label class="dim"><span>${t(label)}</span><input type="number" id="cd-${f}" inputmode="${unit === 'mm' ? 'numeric' : 'decimal'}" min="${lim.min}" max="${lim.max}" step="${lim.step}" value="${c[f]}"><small>${unit}</small></label><div class="err" id="cd-${f}-err"></div>`;
        }).join('')}
        <p class="note">${t('dimTurningHint')}</p>
        <button id="cd-apply">${t('dimsApply')}</button>
      </div>`;
  }

  private bind() {
    const s = this.s;
    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector<T>(sel);
    const all = <T extends HTMLElement>(sel: string) => this.el.querySelectorAll<T>(sel);
    q('#set-close')!.onclick = () => this.toggle(false);
    this.el.onclick = (e) => {
      if (e.target === this.el) this.toggle(false);
    };
    all<HTMLButtonElement>('[data-lang]').forEach((b) => {
      b.onclick = () => {
        s.lang = b.dataset.lang as Lang;
        this.onChange('lang');
        this.render();
      };
    });
    for (const k of ['mirrors', 'minimap', 'distance', 'rearCam', 'guides'] as const) {
      q<HTMLInputElement>(`#aid-${k}`)!.onchange = (e) => {
        s.aids[k] = (e.target as HTMLInputElement).checked;
        this.onChange('aids');
      };
    }
    q('#feel')!.onclick = () => {
      // 감각 모드: 실제 차에도 있는 거울만 남기고 보조 정보는 끈다. 고스트는 건드리지 않는다.
      Object.assign(s.aids, { mirrors: true, minimap: false, distance: false, rearCam: false, guides: false });
      this.onChange('aids');
      this.render();
    };
    q('#allaids')!.onclick = () => {
      Object.assign(s.aids, { mirrors: true, minimap: true, distance: true, rearCam: true, guides: true });
      this.onChange('aids');
      this.render();
    };
    const bindRange = (id: string, unit: string, apply: (v: number) => void) => {
      const input = q<HTMLInputElement>(`#${id}`)!;
      input.oninput = () => {
        const v = Number(input.value);
        q(`#${id}-o`)!.textContent = `${v}${unit}`;
        apply(v);
        this.onChange('driver');
      };
    };
    bindRange('drv-h', ' cm', (v) => (s.driverHeightCm = v));
    bindRange('drv-sh', ' cm', (v) => (s.seatHeightCm = v));
    bindRange('drv-sf', ' cm', (v) => (s.seatForeCm = v));
    bindRange('drv-fov', '°', (v) => (s.fov = v));
    q<HTMLInputElement>('#calib')!.onchange = (e) => {
      s.calibMarks = (e.target as HTMLInputElement).checked;
      this.onChange('driver');
    };
    q<HTMLInputElement>('#mirror-tilt')!.onchange = (e) => {
      s.mirrorTiltReverse = (e.target as HTMLInputElement).checked;
      this.onChange('driver'); // 저장. 조준은 main.ts 프레임 루프가 바로 다음 프레임에 바꾼다 (다시 시작 없음)
    };

    // ---- 주차장 ----
    const world = () => {
      this.onChange('world');
      this.render();
    };
    all<HTMLButtonElement>('[data-scenario]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.scenario as ScenarioKind;
        if (k === s.scenario) return;
        s.scenario = k;
        world();
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
          world();
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
          this.onChange('world');
        };
      }
    };
    bindPresets('slot', 'slot-custom', (v) => (s.perp.slotWidth = v), PERP_SLOT_RANGE, PERP_SLOT_PRESETS);
    bindPresets('len', 'len-custom', (v) => (s.parallel.slotLength = v), PARALLEL_LENGTH_RANGE, PARALLEL_LENGTH_PRESETS);
    all<HTMLButtonElement>('[data-target]').forEach((b) => {
      b.onclick = () => {
        s.perp.target = b.dataset.target as TargetKind;
        world();
      };
    });
    all<HTMLButtonElement>('[data-radius]').forEach((b) => {
      b.onclick = () => {
        s.ramp.innerRadius = Number(b.dataset.radius);
        world();
      };
    });

    // ---- 차량 ----
    const veh = q<HTMLSelectElement>('#veh-select')!;
    veh.onchange = () => {
      veh.blur(); // 포커스가 남으면 ↑/↓가 차종을 바꾸고 운전 키가 먹지 않는다
      s.vehicle = veh.value;
      this.onChange('vehicle');
      this.render();
    };
    const apply = q<HTMLButtonElement>('#cd-apply');
    if (apply) {
      apply.onclick = () => {
        const c = {} as CustomDims;
        for (const { f } of CUSTOM_FIELDS) {
          const raw = q<HTMLInputElement>(`#cd-${f}`)!.value.trim();
          c[f] = raw === '' ? NaN : Number(raw);
        }
        const errs = validateCustomDims(c);
        for (const { f, unit } of CUSTOM_FIELDS) {
          const e = errs.find((x) => x.field === f);
          // 범위 오류에는 허용 범위를 붙인다 (min·max는 입력칸 속성에만 있어 화면에 보이지 않는다)
          const lim = CUSTOM_LIMITS[f];
          const text = e ? (e.key === 'errRange' ? `${t('errRange')} (${lim.min}–${lim.max} ${unit})` : t(e.key)) : '';
          q(`#cd-${f}-err`)!.textContent = text;
          q(`#cd-${f}`)!.classList.toggle('bad', !!e);
        }
        if (errs.length > 0) return; // 차는 그대로
        s.customDims = c;
        s.vehicle = CUSTOM_ID;
        (document.activeElement as HTMLElement | null)?.blur();
        this.onChange('vehicle');
        this.render();
      };
    }

    // ---- 고스트 ----
    q<HTMLInputElement>('#ghost-on')!.onchange = (e) => {
      s.ghost.enabled = (e.target as HTMLInputElement).checked;
      this.onChange('ghost');
    };
    const gv = q<HTMLSelectElement>('#ghost-veh')!;
    gv.onchange = () => {
      gv.blur();
      s.ghost.vehicle = gv.value;
      this.onChange('ghost');
    };
    all<HTMLButtonElement>('[data-align]').forEach((b) => {
      b.onclick = () => {
        s.ghost.align = b.dataset.align as GhostAlign;
        this.onChange('ghost');
        this.render();
      };
    });

    // ---- 조작법: 키보드 자동 변속 (계약서 개정 2026-11-16 controls). 체크박스는 데스크톱(포인터가 coarse가 아님)에만 있다 ----
    const autoShift = q<HTMLInputElement>('#auto-shift');
    if (autoShift) {
      autoShift.onchange = () => {
        s.autoShift = autoShift.checked;
        this.onChange('controls');
        this.render(); // 조작법 안내 문구를 모드에 맞춰 바꾼다
      };
    }
  }
}
