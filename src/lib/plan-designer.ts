import library from "@/lib/plan-designer-library.json";

export type PlanCourse = {
  id: number;
  module: string;
  name: string;
  stage: string;
  points: string;
  hours: number;
  goal: string;
  levels: string[];
  students: string[];
};

export type PlanModule = {
  name: string;
  scoreText: string;
  score: number | null;
  courses: string[];
  note: string | null;
};

export type PlanLibrary = {
  courses: PlanCourse[];
  modules: PlanModule[];
  students: Array<{
    name: string;
    grade: string;
    campus: string;
    level: string;
    current: number;
    target: number;
    gain: number;
    totalHours: number;
    weak: string;
    accuracy: string;
    factor: number;
  }>;
  mathModules?: Array<{ id: string; name: string; topic: string; g: string; lv: number; base: string; mid: string; hard: string; target: string; tags: string[] }>;
};

export const LIBRARY = library as PlanLibrary;

/** 当前窗口期使用的课程库（默认内置寒假库；页面可导入覆盖）。 */
let ACTIVE_LIBRARY: PlanLibrary = LIBRARY;
export function setActiveLibrary(next: PlanLibrary): void { ACTIVE_LIBRARY = next; }
export function getActiveLibrary(): PlanLibrary { return ACTIVE_LIBRARY; }

export type ExamFocus = {
  id: string;
  name: string;
  scoreText: string;
  score: number | null;
  position: string;
  points: string;
  defaultOn?: boolean;
};

/** 高考考向细分：不是每个学生都平均用力，而是按“题位 + 分值”拆。
 *  数据参考新高考 I 卷常见分布与老师给的 2027 寒假样例；分值是可调整的估算。 */
export const EXAM_FOCUS: Record<string, ExamFocus[]> = {
  "集合、复数与常用逻辑用语": [
    { id: "set", name: "集合运算", scoreText: "约5分", score: 5, position: "小题（第1题）", points: "元素与集合、交并补、子集个数", defaultOn: false },
    { id: "complex", name: "复数运算", scoreText: "约5分", score: 5, position: "小题（前3题）", points: "复数概念、四则运算、共轭与模", defaultOn: false },
    { id: "logic", name: "充要条件与量词", scoreText: "约5分", score: 5, position: "小题", points: "充分必要条件、全称与存在量词", defaultOn: false },
  ],
  "平面向量": [
    { id: "vector", name: "向量基本运算", scoreText: "约5分", score: 5, position: "小题", points: "线性运算、坐标运算、数量积与模长夹角", defaultOn: false },
  ],
  "不等式与最值": [
    { id: "ineq", name: "不等式与基本最值", scoreText: "约5分", score: 5, position: "小题", points: "不等式性质、比较大小、基本不等式", defaultOn: false },
  ],
  "函数": [
    { id: "func-basic", name: "函数基本量", scoreText: "约5分", score: 5, position: "小题", points: "定义域、值域、解析式、分段函数", defaultOn: false },
    { id: "func-prop", name: "性质与图像", scoreText: "约5分", score: 5, position: "小题", points: "单调性、奇偶性、周期性、图像变换", defaultOn: false },
    { id: "func-zero", name: "零点与参数", scoreText: "约5分", score: 5, position: "小题压轴", points: "零点存在性、零点个数、含参讨论", defaultOn: false },
  ],
  "导数": [
    { id: "deriv-basic", name: "导数运算与切线", scoreText: "约5分", score: 5, position: "小题/大题第一问", points: "求导公式、复合函数、切线方程", defaultOn: false },
    { id: "deriv-mono", name: "单调性与极值", scoreText: "约5分", score: 5, position: "大题第一问", points: "单调区间、极值最值、含参分类讨论", defaultOn: false },
    { id: "deriv-hard", name: "导数压轴", scoreText: "约10分", score: 10, position: "大题第二问", points: "恒成立、零点、隐零点、双变量与不等式证明", defaultOn: false },
  ],
  "三角函数与解三角形": [
    { id: "trig", name: "三角恒等与图像", scoreText: "约5分", score: 5, position: "小题", points: "诱导公式、恒等变换、图像与性质", defaultOn: false },
    { id: "triangle", name: "解三角形", scoreText: "约10分", score: 10, position: "大题", points: "正余弦定理、面积、边角互化、最值范围", defaultOn: false },
  ],
  "数列": [
    { id: "seq-basic", name: "数列基本量", scoreText: "约5分", score: 5, position: "小题（固定题位）", points: "等差等比基本量、通项与性质、前n项和公式", defaultOn: true },
    { id: "seq-sum", name: "通项与求和", scoreText: "约10分", score: 10, position: "大题", points: "构造求通项、分组/裂项/错位相减、数列不等式", defaultOn: true },
  ],
  "立体几何": [
    { id: "solid-basic", name: "基本量与位置关系", scoreText: "约5分", score: 5, position: "小题", points: "三视图、表面积体积、平行垂直判定", defaultOn: false },
    { id: "solid-vector", name: "空间向量与证明", scoreText: "约15分", score: 15, position: "大题", points: "建系、法向量、线面角/二面角、证明规范", defaultOn: false },
  ],
  "解析几何": [
    { id: "line-circle", name: "直线与圆", scoreText: "约5分", score: 5, position: "小题", points: "直线方程、圆的方程、位置关系、弦长切线", defaultOn: false },
    { id: "conic-basic", name: "圆锥曲线基本量", scoreText: "约10分", score: 10, position: "小题 + 大题第一问", points: "定义、标准方程、离心率、渐近线、焦点三角形", defaultOn: true },
    { id: "conic-hard", name: "圆锥曲线综合", scoreText: "约10分", score: 10, position: "大题第二问", points: "联立、韦达、弦长面积、定点定值、范围最值", defaultOn: true },
  ],
  "概率与统计": [
    { id: "prob", name: "概率基础", scoreText: "约5分", score: 5, position: "小题", points: "古典概型、互斥独立、条件概率", defaultOn: false },
    { id: "stat", name: "统计图表", scoreText: "约5分", score: 5, position: "小题", points: "抽样、频率分布直方图、数字特征、回归", defaultOn: false },
    { id: "dist", name: "分布列与期望", scoreText: "约10分", score: 10, position: "大题", points: "分布列、二项/超几何、期望方差、决策", defaultOn: false },
  ],
  "计数原理与二项式定理": [
    { id: "count", name: "排列组合", scoreText: "约5分", score: 5, position: "小题", points: "分类分步、排列组合、分组分配", defaultOn: false },
    { id: "binomial", name: "二项式定理", scoreText: "约5分", score: 5, position: "小题", points: "通项、特定项、系数和", defaultOn: false },
  ],
  "选填压轴与创新题": [
    { id: "innov", name: "新定义与压轴选填", scoreText: "约10分", score: 10, position: "小题压轴", points: "新定义转化、函数性质综合、多结论判断", defaultOn: false },
  ],
  "计算与应试专项": [
    { id: "calc", name: "计算与应试", scoreText: "贯穿全卷", score: null, position: "全卷", points: "计算准确率、时间分配、步骤规范、取舍", defaultOn: false },
  ],
  "高考真题精讲": [
    { id: "real", name: "真题精讲", scoreText: "综合检测", score: null, position: "套卷", points: "近五年真题基础/中档题、命题角度、解法入口", defaultOn: false },
  ],
  "错题清零": [
    { id: "wrong", name: "错题清零", scoreText: "综合检测", score: null, position: "课后", points: "错题重做、错因归类、同类变式", defaultOn: false },
  ],
  "综合模拟与查漏": [
    { id: "mock", name: "综合模拟", scoreText: "150分", score: 150, position: "整卷", points: "限时套卷、考场节奏、查漏补缺", defaultOn: false },
  ],
};

export function examFocusFor(moduleName: string): ExamFocus[] {
  return EXAM_FOCUS[moduleName] ?? [];
}

export function defaultFocusIds(moduleName: string): string[] {
  return examFocusFor(moduleName).filter((f) => f.defaultOn).map((f) => f.id);
}

export type WindowKey = "spring" | "summer" | "autumn" | "winter";

export type WindowSpec = {
  key: WindowKey;
  month: number;
  label: string;
  short: string;
  startMonth: string;
  endMonth: string;
  weeks: number;
  goalLead: string;
};

/** 四个窗口期：3 月春季 / 7 月暑期 / 8 月秋季 / 12 月寒假 */
export const WINDOWS: WindowSpec[] = [
  {
    key: "spring", month: 3, label: "春季学期", short: "春季",
    startMonth: "3月", endMonth: "6月", weeks: 16,
    goalLead: "以校内同步巩固为主线，补齐上学期欠账并提前建立本学期优势",
  },
  {
    key: "summer", month: 7, label: "暑期集训", short: "暑期",
    startMonth: "7月", endMonth: "8月", weeks: 6,
    goalLead: "利用假期集中补短板、抢先修完新学期核心模块",
  },
  {
    key: "autumn", month: 8, label: "秋季学期", short: "秋季",
    startMonth: "9月", endMonth: "次年1月", weeks: 20,
    goalLead: "跟随校内进度做同步强化，期中期末前完成两轮查漏",
  },
  {
    key: "winter", month: 12, label: "寒假集训", short: "寒假",
    startMonth: "1月", endMonth: "2月", weeks: 6,
    goalLead: "用寒假集中突破薄弱模块，为下学期一轮复习抢占先机",
  },
];

export function windowByKey(key: string): WindowSpec {
  return WINDOWS.find((w) => w.key === key) ?? WINDOWS[3];
}

export type CycleInfo = {
  text: string;
  weeks: number;
  sessions: number;
  weeklyHours: number;
  startText: string;
  endText: string;
};

export function cycleForWindow(key: string, year: number, totalHours: number): CycleInfo {
  const w = windowByKey(key);
  const y = Number.isFinite(year) ? Math.round(year) : new Date().getFullYear();
  const endYear = w.key === "autumn" ? y + 1 : y;
  // 寒假：年份按“寒假所属年份”理解（2027 寒假=2027 年 1—2 月）
  const startText = `${y}年${w.startMonth}`;
  const endText = w.key === "autumn"
    ? `${endYear}年${w.endMonth.replace("次年", "")}`
    : `${y}年${w.endMonth}`;
  const weeks = w.weeks;
  const sessions = Math.max(1, Math.round(Number(totalHours) / 2));
  const weeklyHours = Math.max(2, Math.round((Number(totalHours) / weeks) / 2) * 2);
  return {
    text: `辅导时间：${startText}—${endText}（${w.label}，共${sessions}次课，每次2h）；周课时：${weeklyHours}h/周`,
    weeks, sessions, weeklyHours, startText, endText,
  };
}

export type PlanMode = "window" | "midterm" | "fulltime";

export type PhaseSpec = {
  key: string;
  label: string;
  year: number;
  totalHours: number;
};

/** 连续窗口期：秋→寒假跨年；寒假→春季同年；其它同一年。 */
function nextPhase(key: string, year: number): { key: string; year: number } {
  const order = WINDOWS.map((w) => w.key);
  const i = order.indexOf(key as WindowKey);
  const next = order[(i + 1) % order.length];
  return { key: next, year: next === "winter" && key === "autumn" ? year + 1 : year };
}

/**
 * 一次出几个阶段：
 * - window：窗口期报名 → 连续两个阶段（12 月=寒假+春季；3 月=春季+暑期…）
 * - midterm：学期中途插班 → 只出当前阶段（4 月=春季）
 * - fulltime：全托 → 从当前窗口起连续四个阶段
 */
export function phaseSpecs(
  mode: PlanMode,
  startKey: string,
  year: number,
  totalHours: number,
  customHours?: number[],
): PhaseSpec[] {
  const count = mode === "midterm" ? 1 : mode === "fulltime" ? 4 : 2;
  const keys: Array<{ key: string; year: number }> = [{ key: startKey, year }];
  for (let i = 1; i < count; i++) keys.push(nextPhase(keys[keys.length - 1].key, keys[keys.length - 1].year));
  const total = Math.max(0, Math.round(Number(totalHours) || 0));
  const defaultRatios = count === 1 ? [1] : count === 2 ? [0.4, 0.6] : [0.25, 0.25, 0.25, 0.25];
  const raw = keys.map((_, i) => Math.max(0, Math.round(Number(customHours?.[i]) || total * defaultRatios[i])));
  let diff = total - raw.reduce((a, b) => a + b, 0);
  if (diff !== 0 && raw.length) raw[raw.length - 1] += diff;
  return keys.map((k, i) => {
    const w = windowByKey(k.key);
    return {
      key: k.key,
      label: `${w.label}（${k.year}）`,
      year: k.year,
      totalHours: Math.max(0, raw[i]),
    };
  });
}

export type PlanForm = {
  name: string;
  grade: string;
  school: string;
  teacher: string;
  teacherLevel: string;
  subject: string;
  level: string;
  current: number;
  target: number;
  totalHours: number;
  usedHours: number;
  accuracy: string;
  weakModules: string[];
  keywords: string;
  family: string;
  schoolEnv: string;
  windowKey: string;
  year: number;
  planMode: PlanMode;
};

export type PlanRow = {
  id: string;
  module: string;
  points: string;
  examScore: string;
  hours: number;
  goal: string;
  effect: string;
  adjustment: string;
  courseIds: number[];
  focusId?: string;
  focusName?: string;
};

export type AnalysisDimensions = {
  knowledge: string;
  ability: string;
  method: string;
  habit: string;
  attitude: string;
  family: string;
  school: string;
};

export const LEVELS = [
  { key: "基础重建", label: "基础重建", note: "先补概念与计算，重在及格线" },
  { key: "一轮强化提升", label: "一轮强化提升", note: "基础+中档，构建完整体系" },
  { key: "拔高冲刺", label: "拔高冲刺", note: "跳过重复基础，主攻中档与压轴" },
  { key: "预科衔接", label: "预科衔接", note: "只选需要提前学的新课模块" },
];

const MATH_MODULE_MAP: Record<string, string[]> = {
  "集合、复数与常用逻辑用语": ["m01", "m12", "m30"],
  "平面向量": ["m10"],
  "不等式与最值": ["m02", "m03", "m31"],
  "函数": ["m04", "m05", "m06", "m07", "m32"],
  "导数": ["m23", "m24", "m25", "m38"],
  "三角函数与解三角形": ["m08", "m09", "m11", "m33"],
  "数列": ["m21", "m22", "m34"],
  "立体几何": ["m13", "m16", "m36"],
  "解析几何": ["m17", "m18", "m19", "m20", "m37"],
  "概率与统计": ["m14", "m15", "m28", "m29", "m35"],
  "计数原理与二项式定理": ["m26", "m27"],
  "选填压轴与创新题": ["m32", "m39"],
  "计算与应试专项": ["m41", "m42", "m40"],
  "高考真题精讲": ["m43"],
  "错题清零": ["m44"],
  "综合模拟与查漏": ["m45"],
};

/** 第一个工具（math-plan）里的教材级模块明细：基础/中档/压轴/目标。 */
export function mathDetailsFor(moduleName: string) {
  const ids = MATH_MODULE_MAP[moduleName] ?? [];
  return (ACTIVE_LIBRARY.mathModules ?? []).filter((m) => ids.includes(m.id));
}

export function moduleCourses(moduleName: string): PlanCourse[] {
  const m = ACTIVE_LIBRARY.modules.find((x) => x.name === moduleName);
  if (!m) return [];
  const names = new Set(m.courses);
  return ACTIVE_LIBRARY.courses.filter((c) => names.has(c.module));
}

/** 默认选课：基础层全选；拔高层跳过纯概念课（若该模块还有别的课）。预科只选概念/基础。 */
export function defaultCourseIds(moduleName: string, level: string): number[] {
  const all = moduleCourses(moduleName);
  if (level === "预科衔接") {
    const prep = all.filter((c) => c.stage === "概念" || c.stage === "基础");
    return (prep.length ? prep : all).map((c) => c.id);
  }
  if (level === "拔高冲刺") {
    const nonConcept = all.filter((c) => c.stage !== "概念");
    return (nonConcept.length >= 2 ? nonConcept : all).map((c) => c.id);
  }
  return all.map((c) => c.id);
}

export function scoresText(score: number | null): string {
  if (score == null) return "—";
  return `约${score}分`;
}

function targetScoreFor(module: PlanModule, targetScore: number): number | null {
  if (!module.score) return null;
  // 模块目标分：按目标总分/150 的得分率折算到该模块，再向上取整，最低 1 分
  const rate = Math.max(0, Math.min(1, targetScore / 150));
  return Math.max(1, Math.round(module.score * rate));
}

export function normalizeAccuracy(v: string): string {
  const digits = String(v ?? "").replace(/[^0-9.]/g, "");
  return digits || "85";
}

export function goalFor(module: PlanModule, form: PlanForm): string {
  const acc = normalizeAccuracy(form.accuracy);
  const ts = targetScoreFor(module, form.target);
  const scoreLine = module.score && ts != null
    ? `本模块高考约${module.score}分，目标得分≥${ts}分（得分率≥${Math.round((ts / module.score) * 100)}%）；`
    : "";
  const levelLine = form.level === "基础重建"
    ? "核心概念与公式全部过关，基础题正确率"
    : form.level === "拔高冲刺"
      ? "掌握中档题标准解法，压轴题拿到前两问步骤分，"
      : "掌握基础题型标准解法，解题步骤完整规范，";
  return `${scoreLine}${levelLine}≥${acc}%，错题二次正确率≥90%。`;
}

/** 把总课时按模块权重分配，保证整数且总和精确等于 totalHours。 */
export function allocateHours(total: number, modules: PlanModule[], weights?: number[]): number[] {
  const n = modules.length;
  const totalInt = Math.max(0, Math.round(Number(total) || 0));
  if (!n) return [];
  const minEach = totalInt >= n * 2 ? 2 : totalInt >= n ? 1 : 0;
  if (minEach === 0) return modules.map(() => 0);
  const remain = totalInt - minEach * n;
  if (remain <= 0) return modules.map(() => minEach);
  const rows = modules.map((m, i) => Math.max(1, Number(weights?.[i]) || m.score || 8));
  const wsum = rows.reduce((a, b) => a + b, 0);
  const raw = rows.map((w) => (remain * w) / wsum);
  const base = raw.map((x) => Math.floor(x));
  let used = base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; used < remain; k = (k + 1) % n) {
    base[order[k % n].i] += 1;
    used += 1;
  }
  let out = base.map((x) => x + minEach);
  // 优先偶数：把奇数行调成偶数，同时从另一奇数行扣/补，保持总和
  if (totalInt % 2 === 0) {
    for (let i = 0; i < n; i++) {
      if (out[i] % 2 === 1) {
        const j = out.findIndex((v, k) => k !== i && v % 2 === 1 && v > minEach);
        if (j >= 0) { out[i] += 1; out[j] -= 1; }
      }
    }
  }
  // 保险：修正到精确总课时
  let diff = totalInt - out.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (diff !== 0 && guard++ < 10000) {
    if (diff > 0) {
      const i = out.indexOf(Math.max(...out));
      out[i] += 1; diff -= 1;
    } else {
      const candidates = out.map((v, i) => ({ v, i })).filter((x) => x.v > minEach);
      if (!candidates.length) break;
      candidates.sort((a, b) => b.v - a.v);
      out[candidates[0].i] -= 1; diff += 1;
    }
  }
  return out;
}

export function buildRows(
  form: PlanForm,
  moduleNames: string[],
  selectedCourses: Record<string, number[]>,
  selectedFocus: Record<string, string[]> = {},
): PlanRow[] {
  const modules = moduleNames
    .map((name) => ACTIVE_LIBRARY.modules.find((m) => m.name === name))
    .filter((m): m is PlanModule => !!m);
  const defs: Array<{ module: PlanModule; focus?: ExamFocus }> = [];
  for (const m of modules) {
    const focusIds = selectedFocus[m.name] ?? defaultFocusIds(m.name);
    const focuses = examFocusFor(m.name).filter((f) => focusIds.includes(f.id));
    if (focuses.length) focuses.forEach((focus) => defs.push({ module: m, focus }));
    else defs.push({ module: m });
  }
  const weights = defs.map(({ module, focus }) => {
    if (focus?.score != null) return Math.max(2, focus.score);
    const ids = selectedCourses[module.name] ?? defaultCourseIds(module.name, form.level);
    const courses = ACTIVE_LIBRARY.courses.filter((c) => ids.includes(c.id));
    return Math.max(2, courses.reduce((a, c) => a + c.hours, 0));
  });
  const hours = allocateHours(form.totalHours, defs.map((d) => d.module), weights);
  return defs.map(({ module: m, focus }, i) => {
    const ids = selectedCourses[m.name] ?? defaultCourseIds(m.name, form.level);
    const courses = ACTIVE_LIBRARY.courses.filter((c) => ids.includes(c.id));
    const coursePoints = [...new Set(courses.flatMap((c) => c.points.split(/[；;]/).map((s) => s.trim()).filter(Boolean)))].join("；");
    const targetModule: PlanModule = focus
      ? { ...m, score: focus.score, scoreText: focus.scoreText }
      : m;
    return {
      id: `m-${i}-${Date.now()}`,
      module: focus ? `${m.name}·${focus.name}` : m.name,
      points: focus?.points || coursePoints || courses.map((c) => c.points).join("；"),
      examScore: focus?.scoreText || m.scoreText,
      hours: hours[i] ?? 0,
      goal: goalFor(targetModule, form),
      effect: "—",
      adjustment: "—",
      courseIds: ids,
      focusId: focus?.id,
      focusName: focus?.name,
    };
  });
}

/** 把选中的模块分配到不同阶段：前一阶段先补弱/基础，后一阶段接剩余与收尾。 */
export function splitModulesForPhases(form: PlanForm, moduleNames: string[], specs: PhaseSpec[]): string[][] {
  if (specs.length <= 1) return [moduleNames];
  const tailNames = ["高考真题精讲", "错题清零", "综合模拟与查漏", "计算与应试专项"];
  const weak = new Set(form.weakModules);
  const core = moduleNames.filter((n) => !tailNames.includes(n));
  const tails = moduleNames.filter((n) => tailNames.includes(n));
  const ranked = core.slice().sort((a, b) => {
    const aw = weak.has(a) ? 0 : 1, bw = weak.has(b) ? 0 : 1;
    if (aw !== bw) return aw - bw;
    const am = ACTIVE_LIBRARY.modules.find((m) => m.name === a);
    const bm = ACTIVE_LIBRARY.modules.find((m) => m.name === b);
    return (am?.score ?? 8) - (bm?.score ?? 8);
  });
  if (!core.length) {
    const per = Math.max(1, Math.ceil(tails.length / specs.length));
    return specs.map((_, i) => tails.slice(i * per, (i + 1) * per));
  }
  if (specs.length === 2) {
    const ratio = specs[0].totalHours / Math.max(1, specs[0].totalHours + specs[1].totalHours);
    const n1 = Math.max(1, Math.min(core.length, Math.round(core.length * ratio)));
    return [ranked.slice(0, n1), [...ranked.slice(n1), ...tails]];
  }
  // 全托四阶段：基础/弱项 → 核心 → 核心剩余 → 收尾
  const per = Math.max(1, Math.ceil(core.length / 3));
  const groups = [ranked.slice(0, per), ranked.slice(per, per * 2), ranked.slice(per * 2), tails];
  if (!groups[3].length) groups[3] = groups[2].splice(-1);
  return groups;
}

export function defaultModules(form: PlanForm): string[] {
  if (form.level === "预科衔接") {
    // 预科默认给“新课起步”模块，老师再按教材进度增删；课程默认只勾概念/基础课
    return ["集合、复数与常用逻辑用语", "函数", "三角函数与解三角形", "平面向量", "数列"];
  }
  const weak = new Set(form.weakModules);
  const scored = ACTIVE_LIBRARY.modules
    .filter((m) => m.score != null)
    .slice()
    .sort((a, b) => {
      const aw = a.name === "函数" || [...weak].some((x) => a.name.includes(x)) ? 1 : 0;
      const bw = b.name === "函数" || [...weak].some((x) => b.name.includes(x)) ? 1 : 0;
      return bw - aw || (b.score ?? 0) - (a.score ?? 0);
    });
  const tail = ["高考真题精讲", "错题清零", "综合模拟与查漏", "计算与应试专项"];
  const core = scored.map((m) => m.name).filter((n) => !tail.includes(n));
  const n = form.totalHours <= 30 ? 7 : form.totalHours <= 60 ? 10 : form.totalHours <= 80 ? 13 : 16;
  const tailCount = form.totalHours <= 60 ? 3 : 4;
  const picked = core.slice(0, Math.max(1, n - tailCount));
  return [...picked, ...tail.slice(0, tailCount)];
}

export function analysisDefaults(form: PlanForm): AnalysisDimensions {
  const weak = form.weakModules.length ? form.weakModules.join("、") : "暂无明显集中失分模块";
  const level = form.level;
  const base = level === "基础重建";
  const high = level === "拔高冲刺";
  return {
    knowledge: `${base ? "基础知识存在明显断层" : high ? "基础扎实、知识无明显漏洞" : "具备基础数学知识框架，但知识点掌握不扎实、体系零散"}；主要失分模块为${weak}。${form.keywords ? `关键词：${form.keywords}。` : ""}`,
    ability: high
      ? "中档题速度与准确率较好，综合题思路不全面，压轴题难以突破；答题步骤不够严谨，容易丢步骤分。"
      : base
        ? "基本概念与公式掌握不牢，计算失误较多，中档题缺少稳定解法，综合题无从下手。"
        : "中档题解题思路欠缺，计算偶有失误，综合题难以入手；考试分数不稳定，成绩波动较大。",
    method: high
      ? "刷题量较大但归纳总结不足；缺少限时套卷训练与错因归类，方法迁移能力有待加强。"
      : "有笔记但缺少体系化整理；错题本使用不规范；限时训练不足，做题节奏偏慢。",
    habit: high
      ? "自主学习能力强，作业完成度高；需强化限时训练、规范书写与步骤完整度。"
      : "能完成作业但订正不到位；课堂参与度尚可，需强化当堂过关与课后闭环。",
    attitude: high
      ? "目标高、动力足，自我要求严格；需稳定心态、优化取舍策略，避免因压轴题受挫。"
      : "目标明确、愿意配合；面对压轴题信心不足，需要持续的成就感反馈。",
    family: form.family || "待补充：需与家长沟通后填写（家长配合度、家庭学习环境、日常监督情况）。",
    school: form.schoolEnv || (base
      ? "校内教学进度较快，基础薄弱导致课堂吸收不充分，需要课外同步补基础。"
      : "校内一轮复习吸收不透彻，班级统一进度与个体掌握度不完全匹配。"),
  };
}

export function totalGoal(form: PlanForm, cycle: CycleInfo): string {
  const gain = Math.max(0, form.target - form.current);
  const weak = form.weakModules.length ? form.weakModules.join("、") : "薄弱模块";
  const accuracy = normalizeAccuracy(form.accuracy);
  const accNum = Number(accuracy) || 85;
  return `由当前${form.current}分提升至${form.target}分（提升${gain}分）；基础题正确率≥${accuracy}%，运算准确率≥${Math.min(98, accNum + 7)}%；通过${form.totalHours}h（${cycle.sessions}次课）的模块化辅导，重点补齐${weak}，构建完整知识体系、规范解题步骤，使成绩稳定在${form.target}分以上。`;
}
