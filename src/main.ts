import './style.css';
import * as THREE from 'three';
import type { VehicleSpec } from './sim/specs';
import { buildFootprint, type Footprint } from './sim/footprint';
import type { Pose } from './sim/geometry';
import {
  approachSteer,
  canShift,
  initialState,
  integratePose,
  maxSteerAngle,
  maxWheelAngle,
  updateSpeed,
  type Gear,
  type VehicleState,
} from './sim/vehicle';
import type { Collision } from './sim/world';
import { readSensors } from './sim/sensors';
import { eyeLocal } from './sim/driver';
import { evaluateGoal, type GoalEval } from './sim/goal';
import { canSteer, checkMove, motionCtx } from './sim/motion';
import { AttemptTracker } from './sim/attempt';
import { getSpec, validateCustomDims, vehicleKey, type CustomDims, type GhostAlign } from './sim/vehicles';
import { ghostPose } from './sim/ghost';
import { doorClearances, scoreAttempt } from './sim/score';
import {
  addAttempt,
  clearEntry,
  emptyRecords,
  parseRecords,
  RECORDS_KEY,
  recordKey,
  saveRecords,
  type AttemptSummary,
  type RecordsFile,
} from './sim/records';
import { cumulativeDistance, distanceAt, frameAt, Playback, Recorder } from './sim/replay';
import { buildScenario } from './scenarios/index';
import type { ParallelOptions, PerpOptions, RampOptions, Scenario, ScenarioKind } from './scenarios/types';
import { addLights, buildStatic, CHASE_HIDDEN } from './render/scene';
import { buildCar, type CarRig } from './render/carMesh';
import { DriverView, MirrorView, RearCamView, type LookTarget } from './render/cameras';
import { GUIDE_LAYER, GuideLines, predictPath } from './render/guideLines';
import { buildCalibMarks, CALIB_LAYER } from './render/calibMarks';
import { Minimap } from './render/minimap';
import { GhostView } from './render/ghost';
import { ChaseCam } from './render/chaseCam';
import { TopReplayView } from './render/replayTop';
import { disposeObject, L } from './render/util';
import { Input, type InputCallbacks } from './input/input';
import { detectLang, setLang, t, type Key } from './ui/i18n';
import { loadSettings, optionsFor, sanitizeSettings, saveSettings } from './ui/settings';
import { SettingsPanel } from './ui/settingsPanel';
import {
  cmText,
  drawSensors,
  hideOverlay,
  overlayOpen,
  scoreRowsHtml,
  scoreTotalHtml,
  secText,
  showOverlay,
  toast,
  updateStatus,
} from './ui/hud';
import { ReplayBar } from './ui/replayBar';
import { RecordsPanel, setupLabel } from './ui/recordsPanel';

const DT = 1 / 60;
const KEY_STEER_RATE = 0.9; // 정규화 조향/초 (중앙→끝 약 1.1초)
const STEER_TOAST_MS = 2000; // steerBlocked 안내는 2초에 한 번까지
const HINT_MS = 4000; // 시나리오 안내는 두 줄이라 기본 1.8초로는 짧다
const TOPBAR_GAP = 6; // 탑뷰(리플레이·운전 중)에서 위쪽 상태 표시줄 아래 여백 (px)
const coarse = matchMedia('(pointer: coarse)').matches;

const settings = loadSettings();
setLang(settings.lang ?? detectLang());

// ---- 차량별 값: 차량을 바꾸면 applyVehicle이 모두 다시 만든다 (계약서 §3.1) ----
let spec: VehicleSpec = getSpec(settings.vehicle, settings.customDims);
let fp: Footprint = buildFootprint(spec);
let maxSteer = maxSteerAngle(spec);
let maxWheel = maxWheelAngle(spec);

// ---- 렌더러·씬 ----
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
const scene = new THREE.Scene();
addLights(scene);

function makeScenario(): Scenario {
  const o = optionsFor(settings);
  return buildScenario(o.kind, o.opts, spec);
}
let sc = makeScenario();
let ctx = motionCtx(spec, sc.elements);
let staticGroup = buildStatic(sc);
scene.add(staticGroup);
/** 시나리오를 다시 만든다 (옵션·차량이 바뀔 때). 이동 판정(ctx)도 매번 새 요소로 다시 만든다. */
function buildWorld() {
  sc = makeScenario();
  scene.remove(staticGroup);
  disposeObject(staticGroup);
  staticGroup = buildStatic(sc);
  scene.add(staticGroup);
  ctx = motionCtx(spec, sc.elements);
}

let car: CarRig = buildCar(spec);
scene.add(car.group);

const driver = new DriverView();
driver.camera.layers.enable(CALIB_LAYER);
car.group.add(driver.camera);

// 사이드미러 조준: 유리 안쪽 가장자리에 자기 차 옆면이 15~20% 보이는 통상적인 조정 (추정값)
function buildMirrors(rig: CarRig) {
  const m = {
    left: new MirrorView(rig.mirrorGlassSize.side, [256, 160], 1, L(-1, 0.1, -0.08)),
    // 조수석 쪽은 볼록거울: 시야를 넓혀 근사
    right: new MirrorView(rig.mirrorGlassSize.side, [256, 160], 1.7, L(-1, -0.1, -0.08)),
    rear: new MirrorView(rig.mirrorGlassSize.rear, [384, 100], 1, L(-1, 0, -0.03)),
  };
  for (const v of Object.values(m)) {
    rig.group.add(v.mesh);
    v.setEnabled(settings.aids.mirrors);
  }
  return m;
}
let mirrors = buildMirrors(car);
// 후진 연동 하향 (설정 mirrorTiltReverse, 기본 꺼짐, 숙임 정도는 추정값): 켜면 R에서 양쪽 사이드미러를 아래로 숙인다
// (보는 방향 약 7.8°, 유리 약 3.9°). 테슬라 Mirror Auto-Tilt처럼 양쪽을 숙이고 룸미러는 그대로다. 꺼져 있으면 모든 기어에서 v1 조준.
// 통상 조정으로는 연석에 10 cm 남짓 붙은 차의 연석이 자기 차 옆면에 가려 거울에 보이지 않는다.
// 숙임 정도: 시험한 -0.18·-0.22·-0.25 중 평행 주차 칸 가운데(연석까지 7.75 cm)에서 연석 띠가 또렷한 가장 얕은 값.
// (-0.18은 연석이 가는 선으로만, -0.25는 직각 주차 후진에서 옆 차가 거의 안 보였다.)
// 기본이 꺼짐인 이유: 켜면 후면 직각 진입 중 우미러가 대부분 바닥이고 옆 차는 가는 띠로만 보인다.
const LEFT_MIRROR_REVERSE = L(-1, 0.1, -0.22);
const RIGHT_MIRROR_REVERSE = L(-1, -0.1, -0.22);
const mirrorEye = new THREE.Vector3(); // 미러 조준 눈 (applyDriver)
let mirrorsReverse = false; // 지금 양쪽 사이드미러가 후진 하향 조준인지 (프레임 루프가 설정·기어에 맞춘다)
function aimMirrors() {
  mirrors.left.aim(car.mirrorAnchors.left, mirrorEye, mirrorsReverse ? LEFT_MIRROR_REVERSE : undefined);
  mirrors.right.aim(car.mirrorAnchors.right, mirrorEye, mirrorsReverse ? RIGHT_MIRROR_REVERSE : undefined);
  mirrors.rear.aim(car.mirrorAnchors.rear, mirrorEye);
}

const REAR_CAM_FOV = 70; // 세로 시야각 (°)
const rearCam = new THREE.PerspectiveCamera(REAR_CAM_FOV, 16 / 9, 0.01, 100);
rearCam.layers.enable(GUIDE_LAYER);
car.group.add(rearCam);
/**
 * 뒷면 바로 바깥 (안쪽에 두면 차체 안감에 가려진다). 범퍼 뒤 약 0.4 m부터 보이도록 숙인다 (v1: 0.55 rad).
 * 카메라 높이는 전고에 비례하므로 키 큰 직접 입력 차(전고 약 1.71 m 초과)는 더 숙여, 화면 아래 끝이 카메라에서 0.45 m
 * (범퍼 뒤 0.47 m) 안쪽 바닥에 닿게 한다. 그래야 0.5 m 빨간 표시선(0.475~0.525 m)이 화면에 들어온다.
 * 모델 Y와 프리셋 7종은 0.55 그대로다 (가장 높은 쏘렌토도 계산값 0.548).
 */
function placeRearCam(s: VehicleSpec) {
  const camH = 0.62 * s.height - 0.02;
  rearCam.position.copy(L(-s.rearOverhang - 0.02, 0, camH));
  rearCam.rotation.order = 'YXZ';
  const pitch = Math.max(0.55, Math.atan2(camH, 0.45) - (REAR_CAM_FOV / 2) * (Math.PI / 180));
  rearCam.rotation.set(-pitch, Math.PI / 2, 0);
}
placeRearCam(spec);
const rearView = new RearCamView(rearCam);

const guides = new GuideLines();
scene.add(guides.group);

let calib = buildCalibMarks(spec);
car.group.add(calib);

// 고스트 비교 (계약서 §4): 씬에 한 번 추가하고, 비교할 차가 바뀌면 setSpec
const ghostView = new GhostView();
scene.add(ghostView.group);
let ghostSpec: VehicleSpec | null = null;
let ghostFp: Footprint | null = null;
let ghostNow: Pose | null = null;

// ---- HUD 요소 ----
const minimapEl = document.getElementById('minimap') as HTMLCanvasElement;
const sensorsEl = document.getElementById('sensors') as HTMLCanvasElement;
const statusEl = document.getElementById('status')!;
const rearcamEl = document.getElementById('rearcam')!;
const wheelEl = document.getElementById('wheel-img')!;
const minimap = new Minimap(minimapEl);

// ---- 상태 ----
let state: VehicleState = initialState(sc.start.x, sc.start.y, sc.start.heading);
let crashed: Collision | null = null;
let throttle = 0;
let brake = 0;
let wheelRoll = 0;
let lastSteerToast = -Infinity;
let lastGearHint = -Infinity;
const tracker = new AttemptTracker();
/** 마지막 시도의 리플레이 (메모리에만, 계약서 §5.4) */
const recorder = new Recorder();
/**
 * 이 시도의 결과 카드를 다시 띄운다 (리플레이를 닫을 때). 첫 성공·충돌에서 점수를 매기고 기록하면서 정해진다.
 * null = 아직 기록하지 않은 시도. 점수 창 (계약서 §5.1): 시도마다 첫 성공·충돌만 기록하고, 그 뒤의 P는 점수 없는 v2 카드.
 */
let scoredCard: (() => void) | null = null;

/** 새 시도: 사건 집계, 리플레이 기록, 점수 창을 비운다 */
function newAttempt() {
  tracker.reset();
  recorder.reset();
  scoredCard = null;
}

const HINT: Record<ScenarioKind, Key> = {
  rearPerp: 'hintRearPerp',
  frontPerp: 'hintFrontPerp',
  parallel: 'hintParallel',
  ramp: 'hintRamp',
};
/** 설정 시트가 열린 동안 다시 시작했으면 시트를 닫을 때 안내를 띄운다 (시트에 반쯤 가렸다) */
let hintOnClose = false;
const showHint = () => toast(t(HINT[sc.kind]), HINT_MS);

function restart() {
  leaveReplay(); // 리플레이 중이면 운전 모드로: 다시 만든 차·시나리오가 옛 기록을 재생하지 않게
  state = initialState(sc.start.x, sc.start.y, sc.start.heading);
  crashed = null;
  throttle = 0;
  brake = 0;
  newAttempt();
  hideOverlay();
  driver.look('F');
  if (panel.isOpen) hintOnClose = true;
  else showHint();
}

// 렌더 눈 높이 하한 = 보닛 면(카울 뒤로 늘린 면) + 3.5 cm (추정값).
// 눈 추정(driver.ts)대로면 키 150 cm·시트 -6의 눈(1.02 m)이 이 면보다 8 cm 낮아, 앞이 대시에 막혀 보닛도 앞 바닥도 안 보인다.
// 키 175 cm·시트 0 이상(시트 전후 ±12 포함)에서는 작동하지 않는다. 시트 전후 0에서 작동 범위: 키 150 cm는 시트 +5.5 이하,
// 160 cm는 +1 이하, 175 cm는 -5 이하. 이 범위에서는 시트 높이 슬라이더를 내려도 화면이 그대로다. (모델 Y 기준. hoodLine은 차종마다 따라간다)
const EYE_OVER_HOOD = 0.035;
function seatedEye(heightCm: number, seatHeightCm: number, seatForeCm: number) {
  const e = eyeLocal(spec, heightCm, seatHeightCm, seatForeCm);
  return { ...e, h: Math.max(e.h, car.hoodLine(e.x) + EYE_OVER_HOOD) };
}

function applyDriver() {
  const e = seatedEye(settings.driverHeightCm, settings.seatHeightCm, settings.seatForeCm);
  const eye = L(e.x, e.y, e.h);
  driver.setEye(eye);
  driver.setFov(settings.fov);
  driver.setMirrorAnchors(car.mirrorAnchors.left, car.mirrorAnchors.right);
  // 미러는 키·시트 높이에 맞춘 자세(시트 전후 0)로 조준하고, 시트 전후 이동에는 다시 맞추지 않는다.
  // 그래서 시트를 앞뒤로 옮기면 실제 차처럼 미러 상이 달라진다(계획서: 눈 위치를 바꾸면 미러 화면이 따라 바뀐다).
  const n = seatedEye(settings.driverHeightCm, settings.seatHeightCm, 0);
  mirrorEye.copy(L(n.x, n.y, n.h));
  // 핸들 칼럼: 눈이 기준(키 175 cm·시트 0)보다 낮으면 그만큼 내려 림 윗변이 눈보다 약 10 cm 아래에 오게 한다(올리지는 않음).
  car.steeringRig.position.y = Math.min(0, n.h - eyeLocal(spec, 175, 0, 0).h);
  aimMirrors();
  calib.visible = settings.calibMarks;
}

function applyAids() {
  const a = settings.aids;
  minimapEl.hidden = !a.minimap;
  sensorsEl.hidden = !a.distance;
  for (const m of Object.values(mirrors)) m.setEnabled(a.mirrors);
  // 운전 중 탑뷰는 미니맵 보조가 켜져 있을 때만 쓴다 (감각 모드는 미니맵을 끈다): 꺼지면 운전석 화면으로 돌아간다
  if (!a.minimap) topViewOn = false;
  syncTopView();
}

/** 고스트만 다시 만든다 ('ghost' 변경). 감각 모드는 고스트를 건드리지 않는다. */
function applyGhost() {
  const g = settings.ghost;
  ghostSpec = g.enabled ? getSpec(g.vehicle, settings.customDims) : null;
  ghostFp = ghostSpec ? buildFootprint(ghostSpec) : null;
  ghostNow = null;
  ghostView.setSpec(ghostSpec);
  ghostView.setVisible(g.enabled);
}

/** 차량 전환 (계약서 §3.1): 차량별 값, 차체, 미러, 후방카메라, 보정 눈금, 눈, 고스트, 시나리오를 차례로 다시 만든다. */
function applyVehicle(newSpec: VehicleSpec) {
  // 1. 차량별 값. Input은 cb.maxWheel을 쓸 때마다 읽으므로 넘긴 객체를 고친다.
  spec = newSpec;
  fp = buildFootprint(spec);
  ctx = motionCtx(spec, sc.elements);
  maxSteer = maxSteerAngle(spec);
  maxWheel = maxWheelAngle(spec);
  inputCallbacks.maxWheel = maxWheel;
  // 2. 계속 쓰는 자식(운전석 카메라, 후방카메라)을 옛 차에서 뗀다.
  car.group.remove(driver.camera, rearCam);
  // 3. 옛 미러 해제
  for (const m of Object.values(mirrors)) {
    car.group.remove(m.mesh);
    m.dispose();
  }
  // 4. 옛 보정 눈금과 차체 해제 (mat() 공유 재질은 남긴다)
  car.group.remove(calib);
  disposeObject(calib);
  scene.remove(car.group);
  disposeObject(car.group);
  // 5. 새 차체
  car = buildCar(spec);
  scene.add(car.group);
  car.group.add(driver.camera, rearCam);
  // 6. 새 미러 (해상도·볼록·조준 방향·레이어는 시작할 때와 같다)
  mirrors = buildMirrors(car);
  // 7. 후방카메라 위치
  placeRearCam(spec);
  // 8. 보정 눈금
  calib = buildCalibMarks(spec);
  car.group.add(calib);
  // 9. 눈 위치·미러 조준 (calib.visible도 여기서)
  applyDriver();
  // 10. 고스트 (자세는 두 차 제원에 따라 매 프레임 계산)
  applyGhost();
  // 11. 시나리오 (램프는 차에 따라 폭이 달라진다)
  buildWorld();
  restart();
}

const partKey: Record<Collision['part'], Key> = {
  body: 'crashBody',
  mirrorLeft: 'crashMirrorLeft',
  mirrorRight: 'crashMirrorRight',
};
const tagKey: Record<string, Key> = { wall: 'tagWall', pillar: 'tagPillar', car: 'tagCar' };

// ---- 기록 (계약서 §5.2): 조건마다 최고 기록과 최근 10개, localStorage ----
/** localStorage는 접근만 해도 예외가 날 수 있다 (Safari 쿠키 차단 등) */
function recordsStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
/** 저장소를 쓸 수 없으면 이 세션 동안만 메모리에 둔다 */
let memRecords: RecordsFile = emptyRecords();
/** 마지막 저장이 실패했다 (용량 초과, 사생활 보호 모드): 그동안은 메모리(실패한 기록 포함)를 읽고, 다음 저장 때 다시 시도한다 */
let saveFailed = false;
/** 저장소 읽기가 실패했다: 읽지 못한 다른 조건의 기록을 덮어쓰지 않도록 이 세션은 저장소에 쓰지 않는다 */
let readFailed = false;
function readRecords(): RecordsFile {
  const st = recordsStorage();
  if (!st || saveFailed || readFailed) return memRecords;
  // loadRecords는 읽기 실패를 빈 파일로 숨기므로 여기서 직접 읽어 구분한다
  try {
    return parseRecords(st.getItem(RECORDS_KEY));
  } catch {
    readFailed = true;
    return memRecords;
  }
}
function writeRecords(f: RecordsFile) {
  memRecords = f;
  if (!readFailed) saveFailed = !saveRecords(recordsStorage(), f);
}
/** 지금 설정의 조건 키 (주차 유형 + 옵션 + 실제로 쓰이는 차) */
function recordKeyNow(): string {
  const o = optionsFor(settings);
  return recordKey(o.kind, o.opts, vehicleKey(settings.vehicle, settings.customDims));
}
/** 시도 요약을 지금 조건에 더해 저장한다. 새 최고 기록이면 true */
function recordAttempt(a: AttemptSummary): boolean {
  const { file, newBest } = addAttempt(readRecords(), recordKeyNow(), a);
  writeRecords(file);
  return newBest;
}

/** 결과 카드의 리플레이 버튼 (글자는 카드를 띄울 때의 언어) */
const replayActions = () => [
  { label: t('replayTop'), onClick: () => enterReplay('replayTop') },
  { label: t('replay3d'), onClick: () => enterReplay('replay3d') },
];

function onCrash(c: Collision) {
  // 글자는 카드를 띄울 때마다 만든다 (리플레이 중에 언어를 바꾸고 닫아도 카드가 새 언어로)
  const html = () => `<h2 class="bad">${t('crash')}</h2><p>${t(partKey[c.part])} ↔ ${c.element.tag ? t(tagKey[c.element.tag]) : ''}</p>`;
  // 성공한 뒤 같은 시도에서 부딪힌 것은 기록하지 않고, 리플레이(성공에서 끝남)도 그대로 둔다: v1 충돌 카드만
  if (scoredCard) {
    showOverlay(html(), restart);
    return;
  }
  const e = tracker.events;
  recorder.finish(e.elapsed, state);
  recordAttempt({
    at: Date.now(),
    outcome: 'crash',
    score: 0,
    time: e.elapsed,
    moves: e.dirChanges,
    curb: e.curbTouches,
    angleErrDeg: null,
  });
  scoredCard = () => showOverlay(html(), restart, { actions: replayActions() });
  scoredCard();
}

/** v2 주차 완료 카드의 표: 좌우 여유와 미러 여유 (평행 주차는 오른쪽이 '연석까지'), 각도 오차, 소요 시간 */
function marginsHtml(ev: GoalEval): string {
  const rightLabel = sc.kind === 'parallel' ? t('curbGap') : t('gapRight');
  return `<table>
       <tr><td>${t('gapLeft')}</td><td>${cmText(ev.margin.left)}</td><td class="dim">${t('mirrorShort')} ${cmText(ev.mirrorMargin.left)}</td></tr>
       <tr><td>${rightLabel}</td><td>${cmText(ev.margin.right)}</td><td class="dim">${t('mirrorShort')} ${cmText(ev.mirrorMargin.right)}</td></tr>
       <tr><td>${t('angleErr')}</td><td>${ev.angleErrDeg.toFixed(1)}°</td><td></td></tr>
       <tr><td>${t('elapsed')}</td><td>${secText(tracker.events.elapsed)}</td><td></td></tr>
     </table>`;
}

/**
 * 이 시도의 첫 성공 (칸에서 P, 출구 도착): 리플레이를 마무리하고, 점수를 매겨 기록하고, 점수 카드를 띄운다 (계약서 §5.4).
 * 칸 카드는 v2 정보(좌우 여유·미러 여유·각도 오차·소요 시간)를 그대로 두고 그 아래에 항목별 점수 (계약 개정 2026-11-15).
 */
function concludeSuccess(ev: GoalEval) {
  const e = tracker.events;
  recorder.finish(e.elapsed, state);
  const slot = sc.goal.kind === 'slot';
  const res = scoreAttempt({ kind: sc.kind, ev, doors: slot ? doorClearances(spec, state, sc.elements) : null, events: e });
  const newBest = recordAttempt({
    at: Date.now(),
    outcome: 'success',
    score: res.total,
    time: e.elapsed,
    moves: e.dirChanges,
    curb: e.curbTouches,
    angleErrDeg: ev.angleErrDeg,
  });
  // 글자는 카드를 띄울 때마다 만든다 (리플레이 중에 언어를 바꾸고 닫아도 카드가 새 언어로)
  const html = () =>
    `<h2 class="good">${t(slot ? 'parked' : 'rampDone')}</h2>${scoreTotalHtml(res.total, newBest)}${
      slot ? marginsHtml(ev) : ''
    }${scoreRowsHtml(res.items)}`;
  scoredCard = () => showOverlay(html(), restart, { dismissable: true, actions: replayActions() });
  scoredCard();
}

/** 칸 목표: P로 바꿀 때 판정 (계약서 §3.5) */
function checkParked() {
  const ev = evaluateGoal(sc.goal, fp, state);
  if (ev.success) {
    tracker.finish(); // 첫 성공에서 시도를 끝낸다 (v3 점수는 이 시도만 센다)
    // 점수 창 밖(이미 기록한 시도)의 P는 점수 없는 v2 카드
    if (scoredCard) showOverlay(`<h2 class="good">${t('parked')}</h2>${marginsHtml(ev)}`, restart, { dismissable: true });
    else concludeSuccess(ev);
  } else if (ev.inside && !ev.headingOk) {
    // 반대 방향(오차 90° 초과)만 "방향이 반대입니다". 바른 방향인데 허용 각도보다 비뚤면 각도 오차를 알려 준다.
    // (작은 차·넓은 칸에서는 16~30° 비뚤어도 칸 안에 들어간다. 한 자리 소수: 15.4°를 반올림하면 "15° > 15°"가 된다)
    toast(
      ev.angleErrDeg > 90
        ? t('wrongDirection')
        : `${t('angleErr')} ${ev.angleErrDeg.toFixed(1)}° > ${sc.goal.maxAngleDeg}°`,
    );
  } else if (Math.hypot(state.x - sc.goal.rect.cx, state.y - sc.goal.rect.cy) < 6) {
    // 가장 많이 벗어난 쪽 (칸 기준 앞·뒤·왼쪽·오른쪽)
    const m = ev.margin;
    const sides: [Key, number][] = [
      ['sideFront', m.front],
      ['sideBack', m.back],
      ['sideLeft', m.left],
      ['sideRight', m.right],
    ];
    const [side, v] = sides.reduce((a, b) => (b[1] < a[1] ? b : a));
    // 벗어난 거리는 최소 1 cm로 보인다 (휠스톱에 닿은 채 조금 비뚤면 −0.4 cm가 '0 cm'로 반올림됐다).
    // 앞·뒤로 벗어났는데 비뚤어져 있으면 각도도 알린다: 휠스톱에 닿은 차는 더 물러날 수 없어 각도를 바로잡아야 들어간다.
    const out = `${Math.max(1, Math.round(Math.abs(v) * 100))} ${t('cm')}`;
    const crooked = (side === 'sideFront' || side === 'sideBack') && ev.angleErrDeg > 1.5;
    toast(`${t('notInSlot')} · ${t(side)} ${out}${crooked ? ` · ${t('angleErr')} ${ev.angleErrDeg.toFixed(1)}°` : ''}`);
  }
}

function requestGear(g: Gear) {
  // 시뮬레이션이 멈춘 동안(결과 카드·리플레이·설정·기록 시트)에는 운전 입력을 받지 않는다
  // (카드 중 P가 checkParked를 다시 부르지 않게, 시트 아래에 카드가 뜨지 않게)
  if (crashed || simPaused() || g === state.gear) return;
  if (!canShift(state)) {
    toast(t('shiftStop'));
    return;
  }
  state.gear = g;
  if (g === 'P') {
    state.speed = 0;
    if (sc.goal.kind === 'slot') checkParked();
  }
}

/**
 * 운전석 카메라가 화면에 보이는지. 운전 중 탑뷰, 탑뷰·추적 카메라 리플레이에서 시선을 바꾸면 운전석 화면으로 돌아온 뒤에야
 * 드러나므로 받지 않는다 (운전 중 탑뷰를 켜기 전에 시작한 드래그도 #view가 포인터를 잡고 있어 여기로 온다).
 */
const driverShown = () => (mode === 'drive' && !topViewShown()) || (mode === 'replay3d' && replayCam === 'driver');

const inputCallbacks: InputCallbacks = {
  onGear: requestGear,
  onLook: (l) => {
    // 운전 중 탑뷰에서 시선 키를 누르면 운전석 화면으로 돌아가 그 시선을 본다
    if (topViewShown()) setTopView(false);
    if (driverShown()) driver.look(l);
  },
  onLookDrag: (dx, dy) => {
    if (driverShown()) driver.drag(dx, dy);
  },
  onTopView: () => {
    // 리플레이·결과 카드·설정·기록 시트 중에는 바꾸지 않는다. 미니맵 보조가 꺼져 있으면(감각 모드) 쓸 수 없다
    if (simPaused() || !settings.aids.minimap) return;
    setTopView(!topViewOn);
  },
  getSteer: () => state.steer,
  maxWheel,
};
const input = new Input(inputCallbacks);

const panel = new SettingsPanel(
  settings,
  (kind) => {
    saveSettings(settings);
    if (kind === 'lang') {
      setLang(settings.lang!);
      document.getElementById('toast')!.classList.remove('show'); // 떠 있는 토스트는 이전 언어 문장이라 숨긴다
      if (mode !== 'drive') replayBar.relabel(); // 리플레이 중이면 막대 글자도 새 언어로
    }
    if (kind === 'aids') applyAids();
    if (kind === 'driver') applyDriver();
    if (kind === 'world') {
      buildWorld();
      restart();
    }
    if (kind === 'vehicle') applyVehicle(getSpec(settings.vehicle, settings.customDims));
    if (kind === 'ghost') applyGhost();
  },
  () => {
    if (!hintOnClose) return;
    hintOnClose = false;
    showHint();
  },
);
document.getElementById('btn-restart')!.addEventListener('click', (e) => {
  restart();
  (e.currentTarget as HTMLElement).blur(); // 포커스가 남으면 나중에 누른 Enter가 다시 시작을 또 누른다
});

const records = new RecordsPanel({
  label: () => setupLabel(settings, spec),
  entry: () => readRecords().entries[recordKeyNow()] ?? null,
  clear: () => writeRecords(clearEntry(readRecords(), recordKeyNow())),
});

// ---- 리플레이 (계약서 §5.3·§5.4): 모드 운전 / 탑뷰 리플레이 / 3D 리플레이 ----
type Mode = 'drive' | 'replayTop' | 'replay3d';
let mode: Mode = 'drive';
let playback = new Playback(0);
/** 프레임마다 누적 거리 (3D 리플레이의 바퀴 굴림) */
let replayDist: number[] = [];
let replayCam: 'driver' | 'chase' = 'chase';
const chase = new ChaseCam();
const topCanvas = document.getElementById('replay-top') as HTMLCanvasElement;
const topbarEl = document.getElementById('topbar')!;
const topView = new TopReplayView(topCanvas);
const replayBar = new ReplayBar(document.getElementById('replay-ui')!, {
  onToggle: () => playback.toggle(),
  onSeek: (tt) => {
    // range 값은 끝보다 아주 조금 작게 직렬화될 수 있다 (3.29999999999999 < 3.299999999999993): 끝에 붙여 마지막 프레임(기어)을 보인다
    playback.seek(tt >= playback.duration - 1e-6 ? playback.duration : tt);
    resetChase();
  },
  onRate: (r) => playback.setRate(r),
  onCamera: (c) => {
    replayCam = c;
    resetChase();
  },
  onClose: closeReplay,
});

function setMode(m: Mode) {
  mode = m;
  // 리플레이 동안 터치 조작·시선 버튼·후방카메라·센서를 숨기고, 탑뷰에서는 미니맵도 숨긴다 (style.css)
  document.body.classList.toggle('replaying', m !== 'drive');
  document.body.classList.toggle('replay-top', m === 'replayTop');
  syncTopView(); // 운전 중 탑뷰는 리플레이 동안 그리지 않고, 운전 모드로 돌아오면 다시 보인다
}

/**
 * 시뮬레이션을 멈추는 동안: 리플레이, 결과 카드, 설정·기록 시트. step을 건너뛰고 기어 입력도 받지 않는다.
 * 시트가 열린 동안 차가 움직이고(굴러가던 차, 눌린 가속 페달) 시간이 흐르면, 기록을 보거나 설정을 바꾸는 사이에 충돌·감점이 생길 수 있다.
 */
function simPaused(): boolean {
  return mode !== 'drive' || overlayOpen() || panel.isOpen || records.isOpen;
}

/** 추적 카메라를 지금 재생 위치로 바로 옮긴다 (시작, 탐색, 추적 카메라로 바꿀 때) */
function resetChase() {
  if (mode === 'replay3d' && replayCam === 'chase') chase.reset(frameAt(recorder.frames, playback.t));
}

/**
 * 마지막 시도의 리플레이를 처음부터 1배속으로 재생한다. 이 시도를 기록한 뒤(첫 성공·충돌)에만 된다.
 * 3D는 추적 카메라로 시작한다 (ReplayBar.show가 표시를 추적으로 되돌린다).
 */
function enterReplay(m: 'replayTop' | 'replay3d'): boolean {
  if (!scoredCard || recorder.frames.length === 0) return false;
  hideOverlay();
  playback = new Playback(recorder.duration);
  playback.play();
  replayDist = cumulativeDistance(recorder.frames);
  replayCam = 'chase';
  setMode(m);
  if (m === 'replay3d') {
    // 녹화한 차·시나리오 그대로다 (차량·주차장을 바꾸면 restart()가 기록을 비운다)
    chase.setSpec(spec);
    chase.setWorld(sc.elements);
    resetChase();
  }
  replayBar.show(playback.duration, m === 'replayTop' ? 'top' : '3d');
  return true;
}

/** 리플레이 UI를 닫고 운전 모드로 (결과 카드는 띄우지 않는다: restart·teleport가 쓴다) */
function leaveReplay() {
  if (mode === 'drive') return;
  replayBar.hide();
  setMode('drive');
}

/** 리플레이 닫기(✕): 결과 카드로 돌아간다 */
function closeReplay() {
  leaveReplay();
  scoredCard?.();
}

// ---- 운전 중 탑뷰 (계약서 개정 2026-11-16 top-view): 주차장 전체 2D 지도. 이 세션에만 두고 설정에 저장하지 않는다 ----
/** 탑뷰를 골랐는지. 리플레이 동안에도 남아 운전 모드로 돌아오면 다시 보이고, 다시 시작(↺)해도 그대로다 */
let topViewOn = false;
const topViewCanvas = document.getElementById('topview') as HTMLCanvasElement;
const topViewBtn = document.getElementById('btn-topview')!;
const lotMap = new Minimap(topViewCanvas);

/** 지금 탑뷰를 그리는지 (미니맵 보조가 꺼지면 applyAids가 topViewOn을 지운다) */
function topViewShown(): boolean {
  return mode === 'drive' && topViewOn;
}

/** body 클래스(style.css)와 탑뷰 버튼을 지금 상태에 맞춘다. 버튼은 미니맵 보조가 꺼져 있거나(감각 모드) 리플레이 중이면 숨긴다 */
function syncTopView() {
  const on = topViewShown();
  document.body.classList.toggle('topview', on);
  topViewBtn.hidden = !settings.aids.minimap || mode !== 'drive';
  topViewBtn.classList.toggle('on', on);
  topViewBtn.setAttribute('aria-pressed', String(on));
}

function setTopView(on: boolean) {
  topViewOn = on;
  syncTopView();
}

const approach = (v: number, target: number, rate: number, dt: number) =>
  v < target ? Math.min(target, v + rate * dt) : Math.max(target, v - rate * dt);

/** 시뮬레이션 한 스텝 (계약서 §1.5 순서) */
function step(dt: number) {
  // 0. 구역 목표: 정지·순간이동한 차도 잡도록 어떤 조기 반환보다 먼저
  if (sc.goal.kind === 'zone' && !tracker.finished && !crashed) {
    const ev = evaluateGoal(sc.goal, fp, state);
    if (ev.success) {
      state.speed = 0;
      state.gear = 'P';
      tracker.finish();
      concludeSuccess(ev); // 출구 도착 카드 (점수)
    }
  }

  // 1. 페달과 조향. 바퀴를 연석·휠스톱 안으로 돌리는 조향은 거부한다.
  // 가속 키를 떼면 가속 값은 바로 0 (no-creep): 서서히 줄이면 뗀 뒤에도 잠깐 더 가속하고,
  // 떼자마자 D·R로 바꾸면 남은 가속 값으로 키 없이 움직였다 (최대 약 5.5 cm)
  throttle = input.accel ? approach(throttle, 1, 0.8, dt) : 0;
  brake = approach(brake, input.brake ? 1 : 0, input.brake ? 3 : 6, dt);
  // 데스크톱: P·N인 채 가속 키를 누르면 기어 키를 알려 준다 (첫 화면에 조작 안내가 없고, 기어 버튼은 터치 기기에만 있다)
  if (!coarse && input.accel && (state.gear === 'P' || state.gear === 'N')) {
    const now = performance.now();
    if (now - lastGearHint >= HINT_MS) {
      toast(t('gearHint'), HINT_MS);
      lastGearHint = now;
    }
  }
  let steer = state.steer;
  const ts = input.takeTouchSteer();
  if (ts !== null) {
    steer = ts;
    input.centerRequested = false;
  } else if (input.steerDir !== 0) {
    steer = Math.max(-1, Math.min(1, state.steer + input.steerDir * KEY_STEER_RATE * dt));
    input.centerRequested = false;
  } else if (input.centerRequested) {
    steer = approachSteer(state.steer, 0, KEY_STEER_RATE * 1.5, dt);
    if (steer === 0) input.centerRequested = false;
  }
  if (steer !== state.steer) {
    if (canSteer(ctx, state, state.steer, steer)) {
      state.steer = steer;
    } else {
      const now = performance.now();
      if (now - lastSteerToast >= STEER_TOAST_MS) {
        toast(t('steerBlocked'));
        lastSteerToast = now;
      }
    }
  }
  // 2. 충돌하면 움직이지 않는다 (v1은 충돌 뒤에도 조향이 됐지만, v3는 충돌 카드가 떠 있는 동안 step 자체를 건너뛴다)
  if (crashed) return;

  // 3. 속도
  const speed = updateSpeed(state, { throttle, brake, steer: state.steer }, dt);
  if (speed === 0) {
    state.speed = 0;
    tracker.step(dt, 0, null);
    return;
  }
  // 4. 이동 판정 (게임과 해결 가능성 테스트가 같은 규칙)
  const to = integratePose(state, spec, state.steer, speed, dt);
  const r = checkMove(ctx, state, to, state.steer);
  // 5.
  if (r.kind === 'wheel') {
    // 바퀴가 휠스톱·연석에 새로 닿으면 멈춘다 (이미 걸친 상태에서 빠져나가는 것은 허용)
    state.speed = 0;
    if (tracker.step(dt, 0, r).newCurbTouch) toast(t('curbTouch'));
    return;
  }
  if (r.kind === 'collision') {
    crashed = r.hit;
    state.speed = 0;
    tracker.crash();
    onCrash(r.hit);
    return;
  }
  wheelRoll += speed * dt;
  state.x = to.x;
  state.y = to.y;
  state.heading = to.heading;
  state.speed = speed;
  tracker.step(dt, speed, r);
}

applyDriver();
applyAids();
applyGhost();
restart();

// ---- 루프 ----
const size = new THREE.Vector2();
const eyeWorld = new THREE.Vector3();
let last = performance.now();
let acc = 0;
let frame = 0;
let lastDrawCalls = 0;

function frameLoop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt;
  let n = 0;
  while (acc >= DT && n < 6) {
    // 리플레이 중이거나 결과 카드·시트가 떠 있으면 시뮬레이션을 멈춘다 (운전 입력 무시, 쌓인 시간은 버린다)
    if (!simPaused()) {
      step(DT);
      // 리플레이 기록 (계약서 §5.4): 시도가 시작됐고 끝나기 전에만 (step의 tracker.step 뒤)
      if (tracker.started && !tracker.finished) recorder.sample(tracker.events.elapsed, state);
    } else {
      // 멈춘 동안 터치 핸들을 돌린 값은 버린다 (다시 시작한 첫 스텝에 핸들이 꺾인 채로 출발하지 않게)
      input.takeTouchSteer();
    }
    acc -= DT;
    n++;
  }
  if (n === 6) acc = 0;

  // 이 프레임에 그릴 차: 운전 모드는 시뮬레이션 상태, 리플레이는 기록의 재생 위치 (state는 바꾸지 않는다)
  let view: VehicleState = state;
  let roll = wheelRoll;
  if (mode !== 'drive') {
    const tt = playback.tick(dt);
    replayBar.setTime(tt, playback.playing);
    view = frameAt(recorder.frames, tt);
    roll = distanceAt(recorder.frames, replayDist, tt);
  }

  car.group.position.copy(L(view.x, view.y, 0));
  car.group.rotation.y = view.heading;
  for (const w of car.frontWheels) w.rotation.y = view.steer * maxSteer;
  for (const w of car.wheels) w.rotation.z = -roll / (spec.tireDiameter / 2);
  car.steeringWheel.rotation.z = view.steer * maxWheel;
  if (ghostSpec) {
    ghostNow = ghostPose(spec, ghostSpec, view, settings.ghost.align);
    ghostView.update(ghostNow);
  }

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.getSize(size);
  if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
  driver.update(dt, w / h);
  // 설정을 바꿔도 이 프레임의 미러 렌더 전에 다시 조준한다 (다시 시작 없음). 리플레이는 기록의 기어를 따른다.
  const tilt = settings.mirrorTiltReverse && view.gear === 'R';
  if (tilt !== mirrorsReverse) {
    mirrorsReverse = tilt;
    aimMirrors();
  }
  scene.updateMatrixWorld();

  const a = settings.aids;
  const ghostLayer = ghostFp && ghostNow ? { fp: ghostFp, pose: ghostNow } : null;
  const topShown = topViewShown();
  if (mode === 'replayTop') {
    // 탑뷰 리플레이: 위쪽 캔버스가 3D 화면을 덮으므로 3D는 그리지 않는다.
    // 위쪽 상태 표시줄이 캔버스 위에 떠 있으므로 그 아래 영역에 맞춘다 (폰에서 램프 출구가 상태 표시 밑에 들어갔다)
    const inset = topbarEl.getBoundingClientRect().bottom - topCanvas.getBoundingClientRect().top + TOPBAR_GAP;
    topView.draw(sc, fp, recorder.frames, playback.t, ghostLayer, inset);
  } else if (!topShown) {
    // (운전 중 탑뷰는 지도가 화면을 덮으므로 3D 화면과 미러를 그리지 않는다. 지도는 아래 미니맵 자리에서 그린다)
    const chaseView = mode === 'replay3d' && replayCam === 'chase';
    // 미러는 운전석 카메라로 그릴 때만
    if (!chaseView && a.mirrors && (!coarse || frame % 2 === 0)) {
      driver.camera.getWorldPosition(eyeWorld);
      mirrors.left.render(renderer, scene, eyeWorld);
      mirrors.right.render(renderer, scene, eyeWorld);
      mirrors.rear.render(renderer, scene, eyeWorld);
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    if (chaseView) {
      chase.update(view, dt, w / h);
      // 천장 조명 상자는 천장보다 높은 추적 카메라에서 허공에 뜬 흰 막대로 보이므로 이 화면에서만 숨긴다
      const lamps = staticGroup.getObjectByName(CHASE_HIDDEN);
      if (lamps) lamps.visible = false;
      renderer.render(scene, chase.camera);
      if (lamps) lamps.visible = true;
    } else {
      renderer.render(scene, driver.camera);
      lastDrawCalls = renderer.info.render.calls; // render()마다 초기화되므로 운전석 화면 직후에 읽는다
    }
  }

  // 미러 확대 시선(좌/우 미러)에서는 후방카메라 화면을 숨긴다: 화면 가운데 위쪽에 떠서 확대한 미러를 가린다. 리플레이에서도 숨긴다.
  // 운전 중 탑뷰에서도 숨긴다: 후방카메라는 지도가 덮은 3D 캔버스에 그린다.
  const showRear = mode === 'drive' && !topShown && a.rearCam && state.gear === 'R' && !driver.mirrorLook;
  rearcamEl.classList.toggle('show', showRear);
  if (showRear) {
    guides.group.visible = a.guides;
    if (a.guides) guides.update(state, spec);
    const r = rearcamEl.getBoundingClientRect();
    rearView.render(renderer, scene, r.left, h - r.bottom, r.width, r.height);
  }

  // 미니맵: 3D 리플레이에서는 재생 위치를 보이고, 탑뷰 리플레이에서는 숨긴다.
  // 운전 중 탑뷰는 같은 층을 주차장 전체로, 상태 표시줄 아래 영역에 맞춰 그린다 (미니맵은 숨는다)
  if (a.minimap && mode !== 'replayTop') {
    const moving = mode === 'drive' && (state.gear === 'D' || state.gear === 'R');
    const layers = {
      sc,
      car: { fp, pose: view },
      path: a.guides && moving ? predictPath(state, spec, state.gear === 'R' ? -1 : 1) : null,
      ghost: ghostLayer,
    };
    if (topShown) lotMap.draw(layers, topbarEl.getBoundingClientRect().bottom - topViewCanvas.getBoundingClientRect().top + TOPBAR_GAP);
    else minimap.draw(layers);
  }
  if (a.distance && mode === 'drive' && frame % 3 === 0) drawSensors(sensorsEl, readSensors(fp, state, sc.elements));
  if (frame % 4 === 0) updateStatus(statusEl, view.gear, view.speed, (view.steer * maxWheel * 180) / Math.PI);
  wheelEl.style.transform = `rotate(${-view.steer * maxWheel}rad)`;

  frame++;
  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);

/** 디버그 훅에서 바꾼 설정을 정리(범위·id 검사)하고 저장한다. */
function commitSettings() {
  Object.assign(settings, sanitizeSettings(settings));
  saveSettings(settings);
}

// 디버그/검증용 (브라우저 콘솔, 게이트 스크린샷). 값은 모두 getter·함수라 오래된 값을 돌려주지 않는다.
const sim = {
  get state() {
    return state;
  },
  get spec() {
    return spec;
  },
  get settings() {
    return settings;
  },
  sc: () => sc,
  setScenario(kind: ScenarioKind, opts: Partial<PerpOptions & ParallelOptions & RampOptions> = {}) {
    settings.scenario = kind;
    if (opts.slotWidth !== undefined) settings.perp.slotWidth = opts.slotWidth;
    if (opts.target !== undefined) settings.perp.target = opts.target;
    if (opts.slotLength !== undefined) settings.parallel.slotLength = opts.slotLength;
    if (opts.innerRadius !== undefined) settings.ramp.innerRadius = opts.innerRadius;
    commitSettings();
    buildWorld();
    restart();
    panel.render();
  },
  /** custom은 유효할 때만 settings.customDims에 들어간다 (설정 패널의 적용과 같음). */
  setVehicle(id: string, custom?: CustomDims) {
    if (custom && validateCustomDims(custom).length === 0) settings.customDims = { ...custom };
    settings.vehicle = id;
    commitSettings();
    applyVehicle(getSpec(settings.vehicle, settings.customDims));
    panel.render();
  },
  setGhost(enabled: boolean, id?: string, align?: GhostAlign) {
    settings.ghost.enabled = enabled;
    if (id !== undefined) settings.ghost.vehicle = id;
    if (align !== undefined) settings.ghost.align = align;
    commitSettings();
    applyGhost();
    panel.render();
  },
  /**
   * 속도 0, 기어 N (그다음 shift('P')가 P 판정을 한다). 충돌 검사는 하지 않는다. 리플레이 중이면 운전 모드로.
   * 충돌을 지우면 새 시도(사건·리플레이·점수 창 초기화), 아니면 진행 중인 시도를 이어 간다.
   */
  teleport(pose: Pose, steer = 0) {
    leaveReplay();
    if (crashed) newAttempt();
    crashed = null;
    hideOverlay();
    state.x = pose.x;
    state.y = pose.y;
    state.heading = pose.heading;
    state.steer = steer;
    state.speed = 0;
    state.gear = 'N';
  },
  /** 차체 중심을 목표 사각형 중심에, 방향 = rect.angle. 스크린샷 전용 (타이어가 휠스톱에 걸칠 수 있다). */
  goalPose(): Pose {
    const r = sc.goal.rect;
    const bc = (spec.wheelbase + spec.frontOverhang - spec.rearOverhang) / 2; // 뒤축 → 차체 중심
    return { x: r.cx - bc * Math.cos(r.angle), y: r.cy - bc * Math.sin(r.angle), heading: r.angle };
  },
  shift: (g: Gear) => requestGear(g),
  look: (l: LookTarget) => driver.look(l),
  /** 운전 중 탑뷰가 지금 보이는지 (읽기 전용, 계약서 개정 2026-11-16 top-view) */
  topView: () => topViewShown(),
  evaluate: (): GoalEval => evaluateGoal(sc.goal, fp, state),
  /** 마지막 운전석 화면의 드로우콜 수 */
  drawCalls: () => lastDrawCalls,
  /** GPU 자원 수 (차량 전환 뒤 해제 확인용, 계약서 §9 v2 게이트 5) */
  memory: () => ({ ...renderer.info.memory }),
  /** 마지막 시도의 리플레이를 연다 (결과 카드의 버튼과 같음, 계약서 §5.4). 기록한 시도(첫 성공·충돌)가 없으면 false */
  replay: (m: 'top' | '3d') => enterReplay(m === 'top' ? 'replayTop' : 'replay3d'),
  /** 지금 조건의 기록 키·항목과 저장된 기록 전체 (복사본, 계약서 §5.4) */
  records: () => {
    const file = readRecords();
    const key = recordKeyNow();
    return JSON.parse(JSON.stringify({ key, entry: file.entries[key] ?? null, file }));
  },
  /** 리플레이 기록 요약 (계약 밖 추가, 게이트 X1·X2용): 모드, 프레임 수, 길이, 마지막 프레임, 이 시도를 기록했는지 */
  replayInfo: () => {
    const f = recorder.frames;
    return { mode, frames: f.length, duration: recorder.duration, last: f.length ? { ...f[f.length - 1] } : null, scored: scoredCard !== null };
  },
};
Object.assign(window, { __sim: sim });
