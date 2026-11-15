// 국내 판매 차종 프리셋 제원 (조사 결과 데이터). 단위: m.
// 근거·환산·검산은 .dev/presets-research.md 참고.
//
// 원칙
// - 전장·전폭·전고·축거·윤거·타이어는 국내 기본 가솔린 트림 기준(제조사 국내 자료 + 다나와).
// - turningDiameter = 연석 간(curb-to-curb) 최소 회전 직경, 바깥 앞타이어 외곽 기준.
//   국내 자료(제원표·카탈로그·가격표·취급설명서·다나와)에는 최소회전반경이 없었다.
//   해외 공식 값은 모두 현대·기아가 시장 공통으로 쓰는 최소회전반경 R 하나를 반경 그대로 싣거나 2배 해서 실은 것이다.
//   (기아 홍콩 "Min. Turning Radius" 쏘렌토 5.78·K3 5.30, 기아 폴란드 "Minimalny promień skrętu" 모닝 4.7,
//    호주 i30 Sedan 표의 하이브리드 칸 "5.4m"). "curb to curb"·"between kerbs" 표기는 시장별 서식이라 측정 기준의 근거가 못 된다.
// - 국내 법규(자동차규칙 제9조)의 최소회전반경 R은 바깥쪽 앞바퀴 자국의 "중심선" 기준이다.
//   그래서 R을 바퀴 중심 기준으로 보고 turningDiameter = 2 * (R + tireWidth / 2)로 바꿨다 (R = 공표 반경, 또는 공표 직경 / 2).
//   기준은 추정이므로 7종 모두 turningDiameter를 estimated에 넣었다. 한국 사양과 같은지도 확인하지 못했다.
//   R이 사실 타이어 외곽 기준이라면 실제 직경은 tireWidth만큼 작고 δmax는 약 0.8° 크다 (presets-research.md "검증" 절).
// - tireDiameter = 림(inch) * 0.0254 + 2 * 단면폭 * 편평비.
// - 인치·피트 값은 1 in = 0.0254 m, 1 ft = 0.3048 m로 환산하고 mm 단위로 반올림했다.
// - estimated: 출처 값을 그대로 쓰지 않고 추정·보정한 필드 이름 목록.
// - 미러 포함 폭 추정 규칙(widthMirrors): 차종별 값이 있으면 그 값을 쓴다(제3자 자료라 estimated).
//   없으면 차체 폭 + 0.255 m를 쓴다. 0.255 m는 현대·기아 6차종의 (미러 펼친 폭 − 차체 폭) 평균이다(254.8 mm).
//   Stonic 1,760→2,025 (+265): https://www.automobiledimension.com/model/kia/stonic
//   XCeed 1,826→2,055 (+229): https://www.automobiledimension.com/model/kia/xceed
//   Sportage 1,865→2,080 (+215): https://www.automobiledimension.com/model/kia/sportage
//   Sorento 1,900→2,170 (+270): https://www.automobiledimension.com/model/kia/sorento
//   Tucson IV 1,865→2,130 (+265): https://cararac.com/spec/hyundai/tucson/tucson-iv/
//   Picanto 1,595→1,880 (+285): https://cararac.com/spec/kia/picanto/picanto-iii-facelift-2020/
// - 캐스퍼(AX1)는 최소회전반경 출처를 찾지 못해 제외했다 (presets-research.md 참고).

export interface PresetDims {
  id: string;
  nameKo: string;
  nameEn: string;
  segment: string;
  length: number;
  width: number;
  widthMirrors: number;
  height: number;
  wheelbase: number;
  frontOverhang: number;
  rearOverhang: number;
  trackFront: number;
  trackRear: number;
  groundClearance: number;
  tireWidth: number;
  tireDiameter: number;
  turningDiameter: number;
  estimated: string[];
}

export const PRESET_DIMS: PresetDims[] = [
  {
    // 현대 더 뉴 아반떼 (CN7 F/L, 2023~) 가솔린 1.6 스마트, 195/65 R15
    id: 'avante',
    nameKo: '현대 아반떼 (CN7, 2023~)',
    nameEn: 'Hyundai Avante / Elantra (CN7, 2023-)',
    segment: 'C-sedan',
    length: 4.71, // https://ownersmanual.hyundai.com/full_pdf/CN7/2026/ko_KR (1-13 차량 제원 4,710) / https://auto.danawa.com/auto/?Work=model&Model=4455&Lineup=53911&Tab=spec
    width: 1.825, // https://ownersmanual.hyundai.com/full_pdf/CN7/2026/ko_KR (1,825) / https://auto.danawa.com/auto/?Work=model&Model=4455&Lineup=53911&Tab=spec
    // 추정: 차체 폭 + 0.255 m (파일 머리 규칙). 공식 미러 포함 폭은 찾지 못함
    widthMirrors: 2.08,
    height: 1.42, // https://ownersmanual.hyundai.com/full_pdf/CN7/2026/ko_KR (1,420) / https://auto.danawa.com/auto/?Work=model&Model=4455&Lineup=53911&Tab=spec
    wheelbase: 2.72, // https://ownersmanual.hyundai.com/full_pdf/CN7/2026/ko_KR (2,720) / https://auto.danawa.com/auto/?Work=model&Model=4455&Lineup=53911&Tab=spec
    // 추정: 미국 2026 제원 35.2/41.7 in(894/1,059 mm)은 합이 페이스리프트 전 전장(184.0 in)과 맞음.
    // 그래서 국내 F/L 기준 (4,710 − 2,720 = 1,990 mm)에 비례 배분함. https://www.hyundainews.com/assets/documents/original/67686-2026ElantraSpecsFeatures20250702.pdf
    frontOverhang: 0.911,
    rearOverhang: 1.079, // 추정: 위와 같은 비례 배분
    trackFront: 1.593, // 195/65 R15: https://ownersmanual.hyundai.com/full_pdf/CN7/2026/ko_KR (1,593) / https://auto.danawa.com/auto/?Work=model&Model=4455&Lineup=53911&Tab=spec
    trackRear: 1.604, // 195/65 R15: https://ownersmanual.hyundai.com/full_pdf/CN7/2026/ko_KR (1,604) / https://auto.danawa.com/auto/?Work=model&Model=4455&Lineup=53911&Tab=spec
    groundClearance: 0.14, // 호주 MY25 i30 Sedan 140 mm: https://www.hyundai.com/content/dam/hyundai/au/en/models/i30/2025/i30-sedan-hybrid/Specifications_i30Sedan.pdf
    tireWidth: 0.195, // 195/65 R15 (스마트): https://auto.danawa.com/auto/?Work=model&Model=4455&Lineup=53911&Tab=spec
    tireDiameter: 0.6345, // 195/65 R15: 15*0.0254 + 2*0.195*0.65
    // 추정: R = 5.4 m (바퀴 중심 기준으로 봄) → 2 * (5.4 + 0.195 / 2) = 10.995 m
    // 호주 MY25 i30 Sedan "Minimum turning circle diameter between kerbs / walls" 10.8 m = 2R
    // (G2.0 = 205/55R16·225/45R17, G1.6T N Line = 235/40R18 모두 10.8 m. 같은 칸의 하이브리드는 "5.4m"로 반경 그대로 표기)
    // https://www.hyundai.com/content/dam/hyundai/au/en/models/i30/2025/i30-sedan-hybrid/Specifications_i30Sedan.pdf
    // 교차 확인: 미국 2026 "Minimum turning radius (feet)" 17.7 ft = 5.39 m (위 hyundainews PDF)
    turningDiameter: 10.995,
    estimated: ['widthMirrors', 'frontOverhang', 'rearOverhang', 'turningDiameter'],
  },
  {
    // 기아 더 뉴 K3 (BD F/L, 2021~2024 단종) 가솔린 1.6 트렌디, 195/65 R15
    // kia.com/kr의 K3 제원 페이지는 단종으로 404. 국내 값은 다나와, 교차 확인은 미국 Forte 2024 (같은 BD F/L).
    id: 'k3',
    nameKo: '기아 K3 (BD, 2021~2024)',
    nameEn: 'Kia K3 / Forte (BD, 2021-2024)',
    segment: 'C-sedan',
    length: 4.645, // https://auto.danawa.com/auto/?Work=model&Model=4057&Lineup=51415&Tab=spec (미국 182.7 in = 4,641 mm)
    width: 1.8, // https://auto.danawa.com/auto/?Work=model&Model=4057&Lineup=51415&Tab=spec (미국 70.9 in)
    // 추정: 차체 폭 + 0.255 m (파일 머리 규칙)
    widthMirrors: 2.055,
    height: 1.44, // https://auto.danawa.com/auto/?Work=model&Model=4057&Lineup=51415&Tab=spec
    wheelbase: 2.7, // https://auto.danawa.com/auto/?Work=model&Model=4057&Lineup=51415&Tab=spec / https://kiamedia.com/us/en/models/forte/2024/specifications (106.3 in)
    // 추정: 미국 Forte 2024 35.4/40.9 in(899/1,039 mm, 합 1,938)을 국내 1,945 mm (4,645 − 2,700)에 비례 배분
    // https://kiamedia.com/us/en/models/forte/2024/specifications
    frontOverhang: 0.902,
    rearOverhang: 1.043, // 추정: 위와 같은 비례 배분
    trackFront: 1.563, // 195/65 R15: https://auto.danawa.com/auto/?Work=model&Model=4057&Lineup=51415&Tab=spec (미국 LX P195/65R15 61.5 in = 1,562)
    trackRear: 1.572, // 195/65 R15: https://auto.danawa.com/auto/?Work=model&Model=4057&Lineup=51415&Tab=spec (미국 61.9 in = 1,572)
    groundClearance: 0.135, // 미국 5.3 in: https://kiamedia.com/us/en/models/forte/2024/specifications
    tireWidth: 0.195, // 195/65 R15 (트렌디): https://auto.danawa.com/auto/?Work=model&Model=4057&Lineup=51415&Tab=spec
    tireDiameter: 0.6345, // 195/65 R15: 15*0.0254 + 2*0.195*0.65
    // 추정: R = 10.607 / 2 = 5.30 m (바퀴 중심 기준으로 봄) → 10.607 + 0.195 = 10.802 m
    // 미국 Forte 2024 "Turning circle, curb-to-curb (ft.)" 34.8 ft = 10.607 m = 2R (전 트림 동일)
    // https://kiamedia.com/us/en/models/forte/2024/specifications
    // 교차 확인: 기아 홍콩 Cerato(BD) "Min. Turning Radius (m)" 5.30: https://www.kia.com/hk/en/showroom/cerato/specification.html
    turningDiameter: 10.802,
    estimated: ['widthMirrors', 'frontOverhang', 'rearOverhang', 'turningDiameter'],
  },
  {
    // 기아 더 뉴 K5 (DL3 F/L, 2023~) 2.0 가솔린 스마트 셀렉션, 205/65 R16
    id: 'k5',
    nameKo: '기아 K5 (DL3, 2023~)',
    nameEn: 'Kia K5 (DL3, 2023-)',
    segment: 'D-sedan',
    length: 4.905, // https://www.kia.com/kr/vehicles/k5/specification (2.0 가솔린 4,905)
    width: 1.86, // https://www.kia.com/kr/vehicles/k5/specification (1,860)
    // 추정: 차체 폭 + 0.255 m (파일 머리 규칙)
    widthMirrors: 2.115,
    height: 1.445, // https://www.kia.com/kr/vehicles/k5/specification (1,445)
    wheelbase: 2.85, // https://www.kia.com/kr/vehicles/k5/specification (2,850)
    frontOverhang: 0.945, // 미국 K5 37.2 in: https://kiamedia.com/us/en/models/k5/2026/specifications
    rearOverhang: 1.11, // 미국 K5 43.7 in: https://kiamedia.com/us/en/models/k5/2026/specifications
    trackFront: 1.633, // 16": https://www.kia.com/kr/vehicles/k5/specification (2.0 가솔린 1,633(16”)) (미국 LXS 64.3 in)
    trackRear: 1.64, // 16": https://www.kia.com/kr/vehicles/k5/specification (1,640(16”))
    groundClearance: 0.135, // 미국 5.3 in: https://kiamedia.com/us/en/models/k5/2026/specifications
    tireWidth: 0.205, // 205/65 R16 (스마트 셀렉션): https://www.kia.com/content/dam/kwp/kr/ko/vehicles/pdf/price/price_k5.pdf
    tireDiameter: 0.6729, // 205/65 R16: 16*0.0254 + 2*0.205*0.65
    // 추정: R = 10.973 / 2 = 5.49 m (바퀴 중심 기준으로 봄) → 10.973 + 0.205 = 11.178 m
    // 미국 K5 "Turning circle, curb-to-curb (ft.)" 36.0 ft = 10.973 m = 2R (LXS P205/65R16 포함 전 트림)
    // https://kiamedia.com/us/en/models/k5/2026/specifications (2025년형 페이지도 같은 값)
    turningDiameter: 11.178,
    estimated: ['widthMirrors', 'turningDiameter'],
  },
  {
    // 현대 쏘나타 디 엣지 (DN8 F/L, 2023~) 2.0 가솔린 프리미엄, 215/55 R17
    id: 'sonata',
    nameKo: '현대 쏘나타 디 엣지 (DN8, 2023~)',
    nameEn: 'Hyundai Sonata The Edge (DN8, 2023-)',
    segment: 'D-sedan',
    length: 4.91, // https://www.hyundai.com/contents/repn-car/catalog/sonata-the-edge_catalog.pdf (4,910) / https://auto.danawa.com/auto/?Work=model&Model=4466&Lineup=54854&Tab=spec
    width: 1.86, // https://www.hyundai.com/contents/repn-car/catalog/sonata-the-edge_catalog.pdf (1,860)
    // 추정: 차체 폭 + 0.255 m (파일 머리 규칙)
    widthMirrors: 2.115,
    height: 1.445, // https://www.hyundai.com/contents/repn-car/catalog/sonata-the-edge_catalog.pdf (1,445)
    wheelbase: 2.84, // https://www.hyundai.com/contents/repn-car/catalog/sonata-the-edge_catalog.pdf (축간거리 2,840)
    // 추정: 공개 오버행 없음. 같은 플랫폼 K5의 미국 공식 앞/뒤 비율(945:1,110)로 국내 2,070 mm (4,910 − 2,840)를 배분
    // https://kiamedia.com/us/en/models/k5/2026/specifications
    frontOverhang: 0.952,
    rearOverhang: 1.118, // 추정: 위와 같은 비율 배분
    trackFront: 1.623, // 17": https://www.hyundai.com/contents/repn-car/catalog/sonata-the-edge_catalog.pdf (가솔린 2.0 1,623(17″)) / https://auto.danawa.com/auto/?Work=model&Model=4466&Lineup=54854&Tab=spec
    trackRear: 1.63, // 17": https://www.hyundai.com/contents/repn-car/catalog/sonata-the-edge_catalog.pdf (1,630(17″)) / https://auto.danawa.com/auto/?Work=model&Model=4466&Lineup=54854&Tab=spec
    groundClearance: 0.135, // 미국 5.3 in: https://www.hyundainews.com/assets/documents/original/68169-2026SonataSpecsFeatures20250722A.pdf
    tireWidth: 0.215, // 215/55 R17 (프리미엄): https://auto.danawa.com/auto/?Work=model&Model=4466&Lineup=54854&Tab=spec
    tireDiameter: 0.6683, // 215/55 R17: 17*0.0254 + 2*0.215*0.55
    // 추정: R = 10.942 / 2 = 5.47 m (바퀴 중심 기준으로 봄) → 10.942 + 0.215 = 11.157 m
    // 미국 2026 "Turning Diameter (curb to curb, in feet)" 35.9 ft = 10.942 m = 2R (16~19인치 전 파워트레인 동일)
    // https://www.hyundainews.com/assets/documents/original/68169-2026SonataSpecsFeatures20250722A.pdf
    turningDiameter: 11.157,
    estimated: ['widthMirrors', 'frontOverhang', 'rearOverhang', 'turningDiameter'],
  },
  {
    // 현대 더 뉴 투싼 (NX4 F/L, 2023~) 1.6 가솔린 터보 모던 2WD, 235/65 R17 (국내 롱휠베이스 2,755)
    id: 'tucson',
    nameKo: '현대 투싼 (NX4, 2023~)',
    nameEn: 'Hyundai Tucson (NX4, 2023-)',
    segment: 'C-SUV',
    length: 4.64, // https://www.hyundai.com/contents/repn-car/catalog/the-new-tucson-catalog.pdf (4,640) / https://auto.danawa.com/auto/?Work=model&Model=4592&Lineup=53920&Tab=spec
    width: 1.865, // https://www.hyundai.com/contents/repn-car/catalog/the-new-tucson-catalog.pdf (1,865)
    // 추정: Tucson IV 미러 포함 폭 2,130 mm (제3자 자료): https://cararac.com/spec/hyundai/tucson/tucson-iv/
    widthMirrors: 2.13,
    height: 1.665, // https://www.hyundai.com/contents/repn-car/catalog/the-new-tucson-catalog.pdf (1,665)
    wheelbase: 2.755, // https://www.hyundai.com/contents/repn-car/catalog/the-new-tucson-catalog.pdf (축간거리 2,755)
    frontOverhang: 0.904, // 미국 2026 35.6 in: https://www.hyundainews.com/assets/documents/original/68163-2026TucsonSpecsFeatures20250722A.pdf
    rearOverhang: 0.98, // 미국 2026 38.6 in: https://www.hyundainews.com/assets/documents/original/68163-2026TucsonSpecsFeatures20250722A.pdf
    trackFront: 1.62, // 17": https://www.hyundai.com/contents/repn-car/catalog/the-new-tucson-catalog.pdf (1,615(1,620), 괄호=17인치) / https://auto.danawa.com/auto/?Work=model&Model=4592&Lineup=53920&Tab=spec
    trackRear: 1.627, // 17": https://www.hyundai.com/contents/repn-car/catalog/the-new-tucson-catalog.pdf (1,627(17″)) / https://auto.danawa.com/auto/?Work=model&Model=4592&Lineup=53920&Tab=spec
    groundClearance: 0.181, // 호주 MY26 181 mm: https://www.hyundai.com/content/dam/hyundai/au/en/models/my26-tucson/MY26-TUCSON-Specification.pdf
    tireWidth: 0.235, // 235/65 R17 (모던): https://auto.danawa.com/auto/?Work=model&Model=4592&Lineup=53920&Tab=spec
    tireDiameter: 0.7373, // 235/65 R17: 17*0.0254 + 2*0.235*0.65
    // 추정: R = 11.765 / 2 = 5.88 m (바퀴 중심 기준으로 봄) → 11.765 + 0.235 = 12.000 m
    // 미국 2026 "Turning Diameter (curb to curb, in feet)" 38.6 ft = 11.765 m = 2R
    // https://www.hyundainews.com/assets/documents/original/68163-2026TucsonSpecsFeatures20250722A.pdf
    // 교차 확인: 호주 MY26 "between kerbs / walls" 11.8 m (위 호주 PDF)
    turningDiameter: 12.0,
    estimated: ['widthMirrors', 'turningDiameter'],
  },
  {
    // 기아 더 뉴 쏘렌토 (MQ4 F/L, 2023~) 2.5 가솔린 터보 2WD 프레스티지, 235/60 R18
    id: 'sorento',
    nameKo: '기아 쏘렌토 (MQ4, 2023~)',
    nameEn: 'Kia Sorento (MQ4, 2023-)',
    segment: 'D-SUV',
    length: 4.815, // https://www.kia.com/kr/vehicles/sorento/specification (2.5 가솔린 터보 4,815)
    width: 1.9, // https://www.kia.com/kr/vehicles/sorento/specification (1,900)
    // 추정: Sorento 미러 펼친 폭 2,170 mm (제3자 자료): https://www.automobiledimension.com/model/kia/sorento
    widthMirrors: 2.17,
    height: 1.695, // https://www.kia.com/kr/vehicles/sorento/specification (1,695, 루프랙 장착 시 1,700)
    wheelbase: 2.815, // https://www.kia.com/kr/vehicles/sorento/specification (2,815)
    frontOverhang: 0.925, // 미국 36.4 in: https://kiamedia.com/us/en/models/sorento/2026/specifications
    rearOverhang: 1.074, // 미국 42.3 in: https://kiamedia.com/us/en/models/sorento/2026/specifications
    trackFront: 1.646, // 18": https://www.kia.com/kr/vehicles/sorento/specification (1,646(18”)) (미국 S 235/60R18 64.8 in)
    trackRear: 1.656, // 18": https://www.kia.com/kr/vehicles/sorento/specification (1,656(18”))
    groundClearance: 0.176, // 호주 MY26 176 mm: https://www.kia.com/content/dam/kwcms/au/en/images/pdf/sorento/kia-sorento-combined-brochure.pdf
    tireWidth: 0.235, // 235/60 R18 (프레스티지): https://www.kia.com/content/dam/kwp/kr/ko/vehicles/pdf/price/price_sorento.pdf
    tireDiameter: 0.7392, // 235/60 R18: 18*0.0254 + 2*0.235*0.60
    // 추정: R = 5.78 m (바퀴 중심 기준으로 봄) → 11.558 + 0.235 = 11.793 m
    // 미국 "Turning radius, curb-to-curb (ft.)" 18.96 ft = 5.779 m (반경) → 2R = 37.92 ft = 11.558 m
    // https://kiamedia.com/us/en/models/sorento/2026/specifications
    // 교차 확인: 호주 MY26 "Minimum Turning Circle (m)" 11.6 (위 호주 PDF),
    // 기아 홍콩 "Min. Turning Radius (m)" 5.78: https://www.kia.com/hk/en/showroom/sorento/specification.html
    turningDiameter: 11.793,
    estimated: ['widthMirrors', 'turningDiameter'],
  },
  {
    // 기아 더 뉴 모닝 (JA F/L, 2023~) 1.0 가솔린 트렌디, 175/65 R14
    id: 'morning',
    nameKo: '기아 모닝 (JA, 2023~)',
    nameEn: 'Kia Morning / Picanto (JA, 2023-)',
    segment: 'A-hatch',
    length: 3.595, // https://www.kia.com/kr/vehicles/morning/specification (3,595)
    width: 1.595, // https://www.kia.com/kr/vehicles/morning/specification (1,595)
    // 추정: Picanto 미러 포함 폭 1,880 mm (제3자 자료): https://cararac.com/spec/kia/picanto/picanto-iii-facelift-2020/
    widthMirrors: 1.88,
    height: 1.485, // https://www.kia.com/kr/vehicles/morning/specification (1,485)
    wheelbase: 2.4, // https://www.kia.com/kr/vehicles/morning/specification (2,400)
    // 추정: Picanto 675/520 mm (제3자 자료, 합 = 3,595 − 2,400): https://cararac.com/spec/kia/picanto/picanto-iii-facelift-2020/
    // 교차 확인: 기아 폴란드 Picanto(전장 3,605) 공식 685/520. 뒤 520은 같고, 앞은 국내 전장에서 빼면 675.
    // https://www.kia.com/pl/dealers/marvel/modele/picanto-ja/dane-techniczne/
    frontOverhang: 0.675,
    rearOverhang: 0.52, // 추정: 위와 같은 출처
    trackFront: 1.406, // 14": https://www.kia.com/kr/vehicles/morning/specification (1,406(14"))
    trackRear: 1.415, // 14": https://www.kia.com/kr/vehicles/morning/specification (1,415(14"))
    groundClearance: 0.141, // 호주 MY27 Picanto 141 mm: https://www.kia.com/content/dam/kwcms/au/en/images/pdf/picanto/kia-picanto-brochure.pdf
    tireWidth: 0.175, // 175/65 R14 (트렌디): https://www.kia.com/content/dam/kwp/kr/ko/vehicles/pdf/price/price_morning.pdf
    tireDiameter: 0.5831, // 175/65 R14: 14*0.0254 + 2*0.175*0.65
    // 추정: R = 4.7 m (바퀴 중심 기준으로 봄) → 2 * (4.7 + 0.175 / 2) = 9.575 m
    // 호주 MY27 Picanto "Minimum Turning Circle (m)" 9.4 = 2R. 전장·전폭·전고·축거와 기본 타이어 175/65 R14가 국내와 같음.
    // https://www.kia.com/content/dam/kwcms/au/en/images/pdf/picanto/kia-picanto-brochure.pdf
    // 교차 확인: 기아 폴란드 "Minimalny promień skrętu [m]" 4,7 (위 폴란드 페이지)
    turningDiameter: 9.575,
    estimated: ['widthMirrors', 'frontOverhang', 'rearOverhang', 'turningDiameter'],
  },
];
