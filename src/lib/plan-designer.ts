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
};

export const LIBRARY = library as PlanLibrary;

/** 当前窗口期使用的课程库（默认内置寒假库；页面可导入覆盖）。 */
let ACTIVE_LIBRARY: PlanLibrary = LIBRARY;
export function setActiveLibrary(next: PlanLibrary): void { ACTIVE_LIBRARY = next; }
export function getActiveLibrary(): PlanLibrary { return ACTIVE_LIBRARY; }

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
    text: `辅导时间：${startText}—${endText}（${w.label}，共${sessions}次课，每次2课时）；周课时：${weeklyHours}课时/周`,
    weeks, sessions, weeklyHours, startText, endText,
  };
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

export function buildRows(form: PlanForm, moduleNames: string[], selectedCourses: Record<string, number[]>): PlanRow[] {
  const modules = moduleNames
    .map((name) => ACTIVE_LIBRARY.modules.find((m) => m.name === name))
    .filter((m): m is PlanModule => !!m);
  const courseIdsByModule = modules.map((m) => selectedCourses[m.name] ?? defaultCourseIds(m.name, form.level));
  const weights = courseIdsByModule.map((ids) => {
    const courses = ACTIVE_LIBRARY.courses.filter((c) => ids.includes(c.id));
    return Math.max(2, courses.reduce((a, c) => a + c.hours, 0));
  });
  const hours = allocateHours(form.totalHours, modules, weights);
  return modules.map((m, i) => {
    const ids = courseIdsByModule[i];
    const courses = ACTIVE_LIBRARY.courses.filter((c) => ids.includes(c.id));
    const points = [...new Set(courses.flatMap((c) => c.points.split(/[；;]/).map((s) => s.trim()).filter(Boolean)))].join("；");
    return {
      id: `m-${i}-${Date.now()}`,
      module: m.name,
      points: points || courses.map((c) => c.points).join("；"),
      examScore: m.scoreText,
      hours: hours[i] ?? 0,
      goal: goalFor(m, form),
      effect: "—",
      adjustment: "—",
      courseIds: ids,
    };
  });
}

export function defaultModules(form: PlanForm): string[] {
  if (form.level === "预科衔接") {
    // 预科默认只给最前面的概念模块，老师自己勾选
    return ["集合、复数与常用逻辑用语", "函数"];
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
  return `由当前${form.current}分提升至${form.target}分（提升${gain}分）；基础题正确率≥${accuracy}%，运算准确率≥${Math.min(98, accNum + 7)}%；通过${form.totalHours}课时（${cycle.sessions}次课）的模块化辅导，重点补齐${weak}，构建完整知识体系、规范解题步骤，使成绩稳定在${form.target}分以上。`;
}
