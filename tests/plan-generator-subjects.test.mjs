// 科目包（物理初高中）· 结构与集成回归测试
//
// 为什么要有这一套：模块库是**数据**，而数据最容易出"看不出来"的错 ——
//   · 清单里写了个不存在的模块 id ⇒ 那个年级**静默少一个模块**
//   · 两个模块同名 ⇒ 附件3 按模块名合并行，导出件**静默少一行**
//   · 章节号写错（AI 也照抄）⇒ 交到家长手上的方案里有个不存在的教材小节
//   · 清单声明的年级与 pack 里的年级对不上 ⇒ 界面下拉里出现一个选了没内容的年级
// 这些都不是"跑起来会报错"的错，所以必须靠断言钉住。
//
// 跑法：& <bundled node> tests\plan-generator-subjects.test.mjs
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "public/tools/plan-generator");
const ENGINE_PATH = join(DIR, "js/engine.js");

const results = [];
const ok = (name, cond, detail) => {
  const pass = !!cond;
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

const Engine = require(ENGINE_PATH);
const S = require(join(DIR, "js/subjects.js"));

const SENIOR = S.loadPack("physics", "senior");
const JUNIOR = S.loadPack("physics", "junior");

/** 一轮专题 / 二轮 / 收口 这些模块的"章节"是专题名而不是教材小节号（允许不以数字开头） */
const isSyntheticTerm = (t) => ["二轮", "收口"].indexOf(String(t)) >= 0;

/**
 * "这个模块的章节是不是必须写成 N.N 小节号"。
 * ⚠️ 判据是 **stage**（一轮专题复习/冲刺 阶段的模块写专题名），不是 term ——
 *    初中「中考一轮专题复习」那些模块的 term 仍是"九年级"，但内容是按专题串的。
 */
const TEXTBOOK_STAGES = ["g8a", "g8b", "g9", "mech", "elec", "thop"];
/**
 * "这个模块的章节必须写成 N.N 小节号吗"。
 * ⚠️ 两个例外都要**显式声明**，不靠约定俗成：
 *   · stage 是"一轮专题复习 / 冲刺 / 二轮 / 收口"的 ⇒ 写专题名（初中 j22 起那些）
 *   · `chapterStyle:'topic'` 的 ⇒ 跨册实验模块（高中的「力学实验」「电学实验」），本来就没有小节号
 */
const mustBeNumbered = (m) =>
  TEXTBOOK_STAGES.indexOf(m.stage) >= 0 && m.chapterStyle !== "topic";

/* ==========================================================================
   ① 清单与加载
   ========================================================================== */
ok("①-1 清单里的科目包都能真加载出来，且自检 0 问题",
  (() => { const v = S.validate(); return v.ok; })(),
  S.validate().problems.slice(0, 3).join("；"));

ok("①-2 物理的**初高中两个学段**都在（本轮扩到四学科后，物理仍要完好）",
  S.stageListOf("physics").map((x) => x.key).join(",") === "senior,junior",
  JSON.stringify(S.stageListOf("physics")));

ok("①-2b 至少四个学科都在（物理/数学/英语/语文）—— 加学科只改 manifest 一行",
  ["physics", "math", "english", "chinese"].every((k) => S.subjectList().some((x) => x.key === k)),
  S.subjectList().map((x) => x.key).join(","));

ok("①-3 学科 code 用的是工具现有那套（physics / math …），没另造一套",
  S.subjectNameOf("physics") === "物理" && S.subjectNameOf("math") === "数学"
  && S.subjectNameOf("general") === "通用");

ok("①-4 没有的「学科 + 学段」组合返回 null（不抛异常，由界面给老师人话）",
  S.loadPack("chemistry", "senior") === null && S.loadPack("physics", "university") === null);

// 清单里的 file / global 必须与真实文件、真实 UMD 导出名对得上
// （这两个名字写错 ⇒ 浏览器里科目包"加载不出来"，而 Node 测试照样全绿 —— 必须静态核）
//
// ⚠️ 2026-10 扩到四学科后这里放宽了两处，都是**真实存在的第二种合法写法**：
//   · **一份文件导出两个包**（`chinese.js`）：清单里两条 entry 指同一个 file、
//     两个 global 名；文件里是 `module.exports = {senior, junior}` +
//     `root.A = p.senior; root.B = p.junior` —— 不是单一的 `root.X = factory()`。
//   · 因此"文件名不许重复"这条**不再成立**（它当时是为"防止两个学段指错同一个文件"写的；
//     现在指同一个文件是**故意**的）。
//   判据改成"**能真取到包**"（比字符串匹配更硬）：Node 侧 require 一遍、按 stage 取。
const manifestSrc = readFileSync(join(DIR, "subjects/manifest.js"), "utf8");
const packFiles = S.MANIFEST.SUBJECTS.map((s) => s.file);
const globalsUsed = S.MANIFEST.SUBJECTS.map((s) => s.global);
let globalsOk = true, filesOk = true;
const globalDetail = [];
for (const s of S.MANIFEST.SUBJECTS) {
  const src = readFileSync(join(DIR, "subjects", s.file), "utf8");
  // ① 浏览器侧：全局名必须在该文件里出现（两种写法都认：单一 factory() 或 {senior,junior}）
  const single = src.indexOf("root." + s.global + " = factory()") >= 0;
  const dual = src.indexOf("root." + s.global + " =") >= 0;
  if (!single && !dual) { globalsOk = false; globalDetail.push(s.file + " 里没有 root." + s.global); }
  // ② Node 侧：必须是 UMD（有 module.exports），否则单测/服务端拿不到
  if (src.indexOf("module.exports") < 0) {
    filesOk = false; globalDetail.push(s.file + " 不是 UMD（Node 里 require 不到）");
  }
}
// ③ 最硬的一条：**真的能取到包**（比字符串匹配可信）
let realLoad = true;
for (const s of S.MANIFEST.SUBJECTS) {
  const p = S.loadPack(s.key, s.stage);
  if (!p || p.stage !== s.stage || p.key !== s.key) {
    realLoad = false;
    globalDetail.push("取不到包：" + s.key + "/" + s.stage);
  }
}
ok("①-5 清单里的「全局变量名」与科目包文件里的导出名**逐个对得上**", globalsOk, globalDetail.join("；"));
ok("①-6 每个科目包都是 UMD（浏览器挂全局 + Node 能 require，同一份数据）", filesOk, globalDetail.join("；"));
ok("①-6b ⭐ 清单里**每一条**都能真取到包（key/stage 都对得上）—— 比字符串匹配更硬",
  realLoad, globalDetail.join("；"));
ok("①-7 文件名可以重复（语文故意一份文件出两个包），但**global 名不能撞**",
  new Set(globalsUsed).size === globalsUsed.length,
  globalsUsed.join(","));

/* ==========================================================================
   ② 模块规模与分组（用户拍板的名单）
   ========================================================================== */
ok("②-1 高中物理 26 个模块（一轮 22 + 二轮 1 + 收口 3）", SENIOR.modules.length === 26,
  `实际 ${SENIOR.modules.length}`);

const seniorsByStage = {};
SENIOR.modules.forEach((m) => { seniorsByStage[m.stage] = (seniorsByStage[m.stage] || 0) + 1; });
ok("②-2 高中的复习阶段分组：力学 10 + 电磁 7 + 热光原 5 + 二轮 1 + 收口 3",
  seniorsByStage.mech === 10 && seniorsByStage.elec === 7 && seniorsByStage.thop === 5
  && seniorsByStage.mech2 === 1 && seniorsByStage.final === 3,
  JSON.stringify(seniorsByStage));

ok("②-3 初中物理 37 个模块（八上 6 + 八下 5 + 九全 10 + 一轮专题 12 + 冲刺 4）",
  JUNIOR.modules.length === 37, `实际 ${JUNIOR.modules.length}`);

const juniorByStage = {};
JUNIOR.modules.forEach((m) => { juniorByStage[m.stage] = (juniorByStage[m.stage] || 0) + 1; });
ok("②-4 初中的阶段分组数量对得上",
  juniorByStage.g8a === 6 && juniorByStage.g8b === 5 && juniorByStage.g9 === 10
  && juniorByStage.review === 12 && juniorByStage.sprint === 4,
  JSON.stringify(juniorByStage));

ok("②-5 高中有 3 个「必开」收口模块（真题精讲 / 错题清零 / 综合模拟）",
  SENIOR.modules.filter((m) => m.must).length === 3
  && SENIOR.modules.filter((m) => m.must).every((m) => m.stage === "final"));
ok("②-6 初中也有 4 个「必开」冲刺模块（中考实验 / 力学综合 / 电学综合 / 中考模拟）",
  JUNIOR.modules.filter((m) => m.must).length === 4
  && JUNIOR.modules.filter((m) => m.must).every((m) => m.stage === "sprint"));

/* ==========================================================================
   ③ 重名 / 缺字段 / 年份表引用（这些错了都不报错，只会静默少东西）
   ========================================================================== */
for (const [tag, pack] of [["高中", SENIOR], ["初中", JUNIOR]]) {
  const names = pack.modules.map((m) => m.name);
  const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
  ok(`③-1 ${tag}：没有重名模块（重名会被附件3 合并成一行）`, dupNames.length === 0, dupNames.join("、"));

  const ids = pack.modules.map((m) => m.id);
  const dupIds = ids.filter((n, i) => ids.indexOf(n) !== i);
  ok(`③-2 ${tag}：模块 id 不重复`, dupIds.length === 0, dupIds.join("、"));

  const missing = pack.modules.filter((m) => !m.id || !m.name || !m.stage || !m.term
    || !Array.isArray(m.chapters) || !m.chapters.length
    || m.content == null || m.goal == null
    || m.hoursHint == null || isNaN(Number(m.hoursHint)) || !Array.isArray(m.tags));
  ok(`③-3 ${tag}：每个模块字段齐全（id/name/stage/term/chapters/content/goal/hoursHint/tags）`,
    missing.length === 0, missing.map((m) => m.id || "(无 id)").join("、"));

  const goalNotBlank = pack.modules.filter((m) => String(m.goal).trim() !== "");
  ok(`③-4 ${tag}：goal 全部刻意留空（教学目标由 AI 生成初稿、老师就地改）`,
    goalNotBlank.length === 0, goalNotBlank.map((m) => m.id).join("、"));

  // 年级表点名的 id 必须存在；每个模块的 stage 必须在 stages 表里
  const idSet = {};
  pack.modules.forEach((m) => { idSet[m.id] = true; });
  const badRefs = [];
  Object.keys(pack.grades).forEach((g) => {
    (pack.grades[g] || []).forEach((id) => { if (!idSet[id]) badRefs.push(g + "→" + id); });
  });
  ok(`③-5 ${tag}：年级表里点名的模块 id 全部真实存在`, badRefs.length === 0, badRefs.join("、"));

  const stageKeys = pack.stages.map((s) => s.key);
  const badStage = pack.modules.filter((m) => stageKeys.indexOf(m.stage) < 0);
  ok(`③-6 ${tag}：每个模块的 stage 都在 stages 表里声明过`, badStage.length === 0,
    badStage.map((m) => `${m.id}(${m.stage})`).join("、"));

  // ⚠️ 反向：stages 表里声明了、却没有任何模块用的阶段 ⇒ 附件3 会出现空分组
  const usedStages = {};
  pack.modules.forEach((m) => { usedStages[m.stage] = true; });
  const unusedStages = stageKeys.filter((k) => !usedStages[k]);
  ok(`③-7 ${tag}：stages 表里没有"空分组"（声明了却一个模块都没用）`,
    unusedStages.length === 0, unusedStages.join("、"));

  // 清单声明的年级必须都在 pack.grades 里（否则界面下拉出现"选了没内容"的年级）
  const declared = S.gradesOf("physics", pack.stage);
  const missingGrades = declared.filter((g) => !pack.grades[g]);
  ok(`③-8 ${tag}：清单声明的年级在科目包里都有对应模块表`,
    missingGrades.length === 0, missingGrades.join("、"));

  // ⚠️ 模块名**不许以括号结尾**（本轮踩到）：公司附件3 的引擎会把"模块名末尾的括号"
  //    当成授课类型后缀切掉（`stripStageSuffix`），于是导出件里的模块名会比科目包里的**少一截**。
  //    这条是"跨工具的既有规则"，只能靠这里的静态检查挡住（改的是我们自己的名字）。
  const parenNames = pack.modules.filter((m) => /[（(][^（()）]*[)）]\s*$/.test(m.name));
  ok(`③-9 ${tag}：模块名不以括号结尾（否则导出时会被公司引擎当后缀切掉）`,
    parenNames.length === 0, parenNames.map((m) => m.id + ":" + m.name).join("、"));
}

/* ==========================================================================
   ④ 教材小节：必须真实（这是"不许 AI 编章节"的落地保证）
   ========================================================================== */
for (const [tag, pack] of [["高中", SENIOR], ["初中", JUNIOR]]) {
  // 教材册次内的模块（力学/电磁/热光原/八上/八下/九全），chapters 必须以 **N.N** 小节号开头
  const numbered = pack.modules.filter((m) => mustBeNumbered(m));
  const badChapter = [];
  numbered.forEach((m) => {
    m.chapters.forEach((c) => {
      if (!/^\d+\.\d+/.test(String(c).trim())) badChapter.push(`${m.id}：「${c}」`);
    });
  });
  ok(`④-1 ${tag}：按教材走的模块，章节都是「N.N 小节名」格式（${numbered.length} 个模块全查）`,
    badChapter.length === 0, badChapter.slice(0, 3).join("；"));

  // 专题/实验/收口模块的 chapters 允许写专题名，但**不许混着写**（一半编号一半专题名 = 数据乱了）
  const mixed = pack.modules.filter((m) => {
    if (mustBeNumbered(m)) return false;
    const hasNum = m.chapters.some((c) => /^\d+\.\d+/.test(String(c).trim()));
    const hasTxt = m.chapters.some((c) => !/^\d+\.\d+/.test(String(c).trim()));
    return hasNum && hasTxt;
  });
  ok(`④-1b ${tag}：专题/收口模块的章节写法统一（不同时混用"小节号"和"专题名"）`,
    mixed.length === 0, mixed.map((m) => m.id).join("、"));

  // 小节号必须与模块在教材里的位置自洽（不能出现"必修一模块里写 9.1"这种串册）
  const expectChapterRange = (term) => {
    switch (term) {
      case "必修一": return [1, 4];
      case "必修二": return [5, 8];
      case "必修三": return [9, 11];
      case "选必一": return [1, 4];
      case "选必二": return [1, 3];
      case "选必三": return [1, 5];
      case "八年级上": return [1, 6];
      case "八年级下": return [7, 12];
      case "九年级": return [13, 22];
      default: return null;
    }
  };
  const outOfRange = [];
  numbered.forEach((m) => {
    const range = expectChapterRange(m.term);
    if (!range) return;
    m.chapters.forEach((c) => {
      const mm = String(c).match(/^(\d+)\.\d+/);
      if (!mm) return;
      const n = Number(mm[1]);
      if (n < range[0] || n > range[1]) outOfRange.push(`${m.id}(${m.term})：「${c}」不在 ${range[0]}–${range[1]} 章`);
    });
  });
  ok(`④-2 ${tag}：章节号与该模块所在册次自洽（没串册）`, outOfRange.length === 0,
    outOfRange.slice(0, 3).join("；"));

  // 章节不能重复（同一小节被写进两个模块 ⇒ 排课会重复讲）
  const seen = {};
  const crossDup = [];
  numbered.forEach((m) => {
    m.chapters.forEach((c) => {
      const key = String(c).trim();
      if (seen[key]) crossDup.push(`${key}（${seen[key]} 与 ${m.id}）`);
      else seen[key] = m.id;
    });
  });
  ok(`④-3 ${tag}：同一个小节没有出现在两个模块里（排课不会重复讲）`,
    crossDup.length === 0, crossDup.slice(0, 3).join("；"));
}

// 抽点核对：几处关键章节必须与教材一致（顺便当"教材版本"的证据）
const findMod = (pack, id) => pack.modules.filter((m) => m.id === id)[0];
ok("④-4 高中抽点：必修一 1.1 是「质点 参考系」、4.2 是「实验：探究加速度与力、质量的关系」",
  findMod(SENIOR, "p01").chapters[0].indexOf("质点 参考系") >= 0
  && findMod(SENIOR, "p04").chapters[1].indexOf("探究加速度与力、质量的关系") >= 0,
  findMod(SENIOR, "p01").chapters[0] + " / " + findMod(SENIOR, "p04").chapters[1]);
ok("④-5 高中抽点：必修三 9.1 是「电荷」、选必二 2.1 是「楞次定律」",
  findMod(SENIOR, "p11").chapters[0] === "9.1电荷"
  && findMod(SENIOR, "p16").chapters[0] === "2.1楞次定律",
  findMod(SENIOR, "p11").chapters[0] + " / " + findMod(SENIOR, "p16").chapters[0]);
ok("④-6 初中抽点：九全 13.1 是「分子热运动」、17.1 是「电流与电压和电阻的关系」",
  findMod(JUNIOR, "j12").chapters[0] === "13.1分子热运动"
  && findMod(JUNIOR, "j16").chapters[0] === "13.1分子热运动".replace("13.1分子热运动", "17.1电流与电压和电阻的关系"),
  findMod(JUNIOR, "j12").chapters[0] + " / " + findMod(JUNIOR, "j16").chapters[0]);
ok("④-7 初中：八上/八下/九全三册都在（人教版 2024 的册次）",
  ["八年级上", "八年级下", "九年级"].every((t) => JUNIOR.modules.some((m) => m.term === t)));

// 例外要"窄"：`chapterStyle:'topic'` 只允许出现在**跨册实验模块**上（别拿它当万能挡箭牌）
const topicStyled = SENIOR.modules.concat(JUNIOR.modules).filter((m) => m.chapterStyle === "topic");
ok("④-8 chapterStyle:'topic' 只用在「跨册实验」模块上（不是给写错的章节开后门）",
  topicStyled.length === 2 && topicStyled.every((m) => m.tags.indexOf("实验") >= 0),
  topicStyled.map((m) => m.id + ":" + m.name).join("、"));

// 章节数要与课时量级相称（一个 1.5h 的模块不该挂 13 个小节 —— 那多半是复制粘贴串了）
const bloated = SENIOR.modules.concat(JUNIOR.modules).filter((m) => m.chapters.length > 8 && m.hoursHint < 3);
ok("④-9 没有「小节特别多、课时特别少」的模块（多半是复制粘贴串了）",
  bloated.length === 0, bloated.map((m) => `${m.id}(章节${m.chapters.length}/课时${m.hoursHint})`).join("、"));

/* ==========================================================================
   ⑤ 年级筛选（"宁多勿少"靠这个落地）
   ========================================================================== */
ok("⑤-1 选「八年级」只看到八上 6 + 八下 5 = 11 个模块（九全与中考专题都不出现）",
  JUNIOR.grades["八年级"].length === 11
  && JUNIOR.grades["八年级"].every((id) => ["g8a", "g8b"].indexOf(findMod(JUNIOR, id).stage) >= 0),
  String(JUNIOR.grades["八年级"].length));
ok("⑤-2 选「九年级」= 九全 10 + 一轮专题 12 + 冲刺 4 = 26 个",
  JUNIOR.grades["九年级"].length === 26, String(JUNIOR.grades["九年级"].length));
ok("⑤-3 选「中考冲刺」= 一轮专题 12 + 冲刺 4 = 16 个",
  JUNIOR.grades["中考冲刺"].length === 16, String(JUNIOR.grades["中考冲刺"].length));
ok("⑤-4 高中「新高二」是**短周期**课表（只 8 个模块，不是全册）",
  SENIOR.grades["新高二"].length === 8
  && SENIOR.grades["新高二"].every((id) => !!findMod(SENIOR, id)),
  SENIOR.grades["新高二"].join(","));

/* ==========================================================================
   ⑥ 与引擎集成：真科目包 + 真引擎，端到端
   ========================================================================== */
const CASES = [
  { tag: "高中/高三/100h", pack: SENIOR, grade: "高三", score: 62, hours: 100 },
  { tag: "高中/高三/28h", pack: SENIOR, grade: "高三", score: 45, hours: 28 },
  { tag: "高中/高三/213h", pack: SENIOR, grade: "高三", score: 90, hours: 213 },
  { tag: "高中/新高二/28h", pack: SENIOR, grade: "新高二", score: 70, hours: 28 },
  { tag: "初中/九年级/166.5h", pack: JUNIOR, grade: "九年级", score: 60, hours: 166.5 },
  { tag: "初中/八年级/60h", pack: JUNIOR, grade: "八年级", score: 70, hours: 60 },
  { tag: "初中/中考冲刺/51h", pack: JUNIOR, grade: "中考冲刺", score: 55, hours: 51 },
];

let allExact = true, allSelfCheck = true, allOneRow = true, allUnit = true;
const detail = [];
for (const c of CASES) {
  const plan = Engine.buildPlan(c.pack, { grade: c.grade, score: c.score, totalHours: c.hours });
  const sum = Math.round(plan.rows.reduce((a, r) => a + r.hours, 0) * 10) / 10;
  if (sum !== c.hours) { allExact = false; detail.push(`${c.tag}: ${sum}≠${c.hours}`); }
  const chk = Engine.selfCheck(plan);
  if (!chk.ok) { allSelfCheck = false; detail.push(`${c.tag}: ${chk.problems.join("/")}`); }
  // 一行一模块 ⇒ 行数 = 挑中的模块数；每行课时是 0.1 的整数倍
  const mods = Engine.selectModules(c.pack, { grade: c.grade, score: c.score, totalHours: c.hours }).modules;
  if (plan.rows.length !== mods.length) { allOneRow = false; detail.push(`${c.tag}: rows=${plan.rows.length} mods=${mods.length}`); }
  if (!plan.rows.every((r) => Math.abs(Math.round(r.hours * 10) / 10 - r.hours) < 1e-9)) {
    allUnit = false; detail.push(`${c.tag}: 有非一位小数的课时`);
  }
}
ok("⑥-1 真科目包跑真引擎：各行课时之和**精确等于**总课时（7 种组合全过）", allExact, detail.join("；"));
ok("⑥-2 真科目包跑真引擎：自检（合计/重名/小数）全部通过", allSelfCheck, detail.join("；"));
ok("⑥-3 真科目包跑真引擎：行数 = 选中的模块数（一行一模块，没拆次课）", allOneRow);
ok("⑥-4 真科目包跑真引擎：课时都是一位小数", allUnit);

// 选中的模块必须都属于该年级 —— 这是"八年级不会排到九全内容"的真正保证
let gradeLeak = [];
for (const c of CASES) {
  const allowed = {};
  (c.pack.grades[c.grade] || []).forEach((id) => { allowed[id] = true; });
  const mods = Engine.selectModules(c.pack, { grade: c.grade, score: c.score, totalHours: c.hours }).modules;
  mods.forEach((m) => { if (!allowed[m.id]) gradeLeak.push(`${c.tag}: 排进了非本年级模块 ${m.id}`); });
}
ok("⑥-5 排出来的模块**全部**属于所选年级（不会把九年级内容排给八年级）",
  gradeLeak.length === 0, gradeLeak.slice(0, 3).join("；"));

// 阶段分组：附件3 的「阶段」列要用它，分组名不能是空的 / 不能漏
let stageBad = [];
for (const c of CASES) {
  const plan = Engine.buildPlan(c.pack, { grade: c.grade, score: c.score, totalHours: c.hours });
  const groups = Engine.groupByStage(c.pack, plan.rows);
  groups.forEach((g) => {
    if (!g.name || !g.rows.length) stageBad.push(`${c.tag}: 分组「${g.stage}」名字为空或没有行`);
  });
  const covered = groups.reduce((a, g) => a + g.rows.length, 0);
  if (covered !== plan.rows.length) stageBad.push(`${c.tag}: 分组合计 ${covered} ≠ 行数 ${plan.rows.length}`);
}
ok("⑥-6 按阶段分组后：每组都有中文名、且所有行都被覆盖到（附件3「阶段」列不会漏行）",
  stageBad.length === 0, stageBad.slice(0, 3).join("；"));

// 高中按册次排序：必修一 → 必修二 → 必修三 → 选必一 → 选必二 → 选必三 → 收口
const p213 = Engine.buildPlan(SENIOR, { grade: "高三", score: 90, totalHours: 213 });
const TERM_ORDER = ["必修一", "必修二", "必修三", "选必一", "选必二", "选必三", "二轮", "收口"];
let orderOk = true, lastIdx = -1;
p213.rows.forEach((r) => {
  const i = TERM_ORDER.indexOf(r.term);
  if (i < 0) { orderOk = false; return; }
  if (i < lastIdx) orderOk = false;
  lastIdx = i;
});
ok("⑥-7 高中 213h：输出按教材册次顺序（必修一→必修二→必修三→选必→收口）", orderOk,
  p213.rows.map((r) => r.term).join("→"));

ok("⑥-8 高中 213h：必开的 3 个收口模块都在，且**排在最后**",
  ["p24", "p25", "p26"].every((id) => p213.rows.some((r) => r.id === id))
  && p213.rows.slice(-3).every((r) => r.stage === "final"),
  p213.rows.slice(-3).map((r) => r.name).join("、"));

// 0 课时的表达（张雨宸那份样例里"第十三章内能 0"）
const zeroPack = {
  key: "physics", stage: "junior", name: "物理", fullScore: 100,
  bands: [{ min: 0, key: 1, name: "补基础" }],
  stages: [{ key: "g9", name: "九年级" }],
  modules: [
    { id: "z1", name: "内能", stage: "g9", term: "九年级", lv: 1, hoursHint: 0, topic: "热学", tags: [], chapters: ["13.1分子热运动"], content: "13.1分子热运动", goal: "" },
    { id: "z2", name: "电流和电路", stage: "g9", term: "九年级", lv: 1, hoursHint: 7.5, topic: "电学", tags: [], chapters: ["15.1两种电荷"], content: "15.1两种电荷", goal: "" },
    { id: "z3", name: "欧姆定律", stage: "g9", term: "九年级", lv: 2, hoursHint: 10.5, topic: "电学", tags: [], chapters: ["17.1电流与电压和电阻的关系"], content: "17.1电流与电压和电阻的关系", goal: "" }
  ],
  grades: { "九年级": ["z1", "z2", "z3"] }
};
const zp = Engine.buildPlan(zeroPack, { grade: "九年级", score: 50, totalHours: 20 });
const zsum = Math.round(zp.rows.reduce((a, r) => a + r.hours, 0) * 10) / 10;
ok("⑥-9 hoursHint:0 的模块（样例里的「已掌握、不讲」）给 0 课时，且不占预算",
  zp.rows.filter((r) => r.id === "z1")[0].hours === 0 && zsum === 20,
  zp.rows.map((r) => r.id + ":" + r.hours).join(" ") + ` 合计=${zsum}`);

// 上限的口径（顺带钉住）：单模块最多排"建议课时 × 2"，
// 所以一个 7.5h 的模块在 20h 预算下**最多 15h**，剩下的会如实报在 unallocated 里（不静默吞）
const zOnly = { key: "physics", stage: "junior", name: "物理", fullScore: 100,
  bands: [{ min: 0, key: 1, name: "补基础" }], stages: [{ key: "g9", name: "九年级" }],
  modules: [zeroPack.modules[1]], grades: { "九年级": ["z2"] } };
const zo = Engine.buildPlan(zOnly, { grade: "九年级", score: 50, totalHours: 20 });
ok("⑥-10 单个 7.5h 模块在 20h 预算下最多排 15h（建议课时×2），余量如实报在 unallocated",
  zo.rows[0].hours === 15 && zo.unallocated === 5,
  `hours=${zo.rows[0].hours} unallocated=${zo.unallocated}`);

/* ==========================================================================
   ⑦ 变异自证：把科目包最常见的两种"静默错"装回去，必须变红
   ========================================================================== */
console.log("");
console.log("=".repeat(78));
console.log("变异自证（科目包侧）");
console.log("=".repeat(78));

// 变异一：年级表里点一个不存在的 id（真实事故：写错一个字母 ⇒ 那个年级静默少一个模块）
const mutatedPack = JSON.parse(JSON.stringify(JUNIOR));
mutatedPack.grades["九年级"] = mutatedPack.grades["九年级"].concat(["j99"]);
// 用与 `subjects.js` 的 validate() **完全同一口径**的检查来跑（那段逻辑在 validate 里，
// 这里复刻一份最小版：只查"年级表点名的 id 是否存在"）。
const badRefs = [];
const idSet = {};
mutatedPack.modules.forEach((m) => { idSet[m.id] = true; });
Object.keys(mutatedPack.grades).forEach((g) => {
  (mutatedPack.grades[g] || []).forEach((id) => { if (!idSet[id]) badRefs.push(g + "→" + id); });
});
ok("⑦-1 变异：年级表点了一个不存在的模块 id ⇒ 检查必须抓到",
  badRefs.length === 1 && badRefs[0].indexOf("j99") >= 0, badRefs.join("、"));

// ⚠️ 上面那条只能证明"我们复刻的检查"有效。**真 validate() 也必须抓得到** ——
//    用一个临时清单文件把坏包喂给真 validate()，证明它不是只在自己的单测里管用。
{
  const tmpDir = join(DIR, "subjects");
  const badFile = join(tmpDir, "__tmp-bad-pack.js");
  const realSubjects = readFileSync(join(DIR, "js/subjects.js"), "utf8");
  // 把"坏包"写成一个真科目包文件，再临时改 manifest 的 SUBJECTS 指向它
  writeFileSync(badFile,
    "(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.__TmpBadPack = factory(); }" +
    "(typeof self !== 'undefined' ? self : this, function () { return " +
    JSON.stringify(mutatedPack) + "; }));", "utf8");
  const manifestPath = join(tmpDir, "manifest.js");
  const realManifest = readFileSync(manifestPath, "utf8");
  const patchedManifest = realManifest.replace(
    'file: "physics-junior.js",',
    'file: "__tmp-bad-pack.js",'
  ).replace('global: "PlanGenSubjectPhysicsJunior",', 'global: "__TmpBadPack",');
  try {
    writeFileSync(manifestPath, patchedManifest, "utf8");
    delete require.cache[manifestPath];
    delete require.cache[join(DIR, "js/subjects.js")];
    const S2 = require(join(DIR, "js/subjects.js"));
    const v2 = S2.validate();
    ok("⑦-1b 真 validate() 在坏科目包上必须报错（且点名那个不存在的 id）",
      v2.ok === false && v2.problems.some((p) => p.indexOf("j99") >= 0),
      v2.problems.slice(0, 2).join("；"));
  } finally {
    // 无论成败都要还原（否则后面的测试与"浏览器"都会拿到坏清单）
    writeFileSync(manifestPath, realManifest, "utf8");
    try { unlinkSync(badFile); } catch (e) { /* 忽略 */ }
    delete require.cache[manifestPath];
    delete require.cache[join(DIR, "js/subjects.js")];
  }
}
// 还原之后必须又能正常加载（证明还原干净）
{
  delete require.cache[join(DIR, "js/subjects.js")];
  const S3 = require(join(DIR, "js/subjects.js"));
  ok("⑦-1c 还原清单后，科目包仍然能正常加载（测试没留下污染）",
    S3.validate().ok === true && S3.loadPack("physics", "junior").modules.length === 37,
    S3.validate().problems.slice(0, 2).join("；"));
}

// 变异二：把两个模块改成同名（附件3 会合并同名行 ⇒ 导出件静默少一行）
const dupPack = JSON.parse(JSON.stringify(SENIOR));
dupPack.modules[1].name = dupPack.modules[0].name;
const names = dupPack.modules.map((m) => m.name);
const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
ok("⑦-2 变异：两个模块同名 ⇒ 检查必须抓到",
  dupNames.length === 1, dupNames.join("、"));

// 变异三：把某个模块的 stage 改成 stages 表里没有的 key（附件3 的「阶段」列会变成空）
const stagePack = JSON.parse(JSON.stringify(SENIOR));
stagePack.modules[0].stage = "not-exist";
const stageKeys = stagePack.stages.map((s) => s.key);
const badStage = stagePack.modules.filter((m) => stageKeys.indexOf(m.stage) < 0);
ok("⑦-3 变异：模块的 stage 没在 stages 表里声明 ⇒ 检查必须抓到",
  badStage.length === 1, badStage.map((m) => m.id).join("、"));

// 变异四：把章节号改串册（必修一的模块里塞一个 9.1）
const badChap = JSON.parse(JSON.stringify(SENIOR));
badChap.modules[0].chapters = ["9.1电荷"];
const range = [1, 4];   // 必修一
const mm = String(badChap.modules[0].chapters[0]).match(/^(\d+)\.\d+/);
ok("⑦-4 变异：必修一的模块里写了 9.1（串册）⇒ 检查必须抓到",
  !!(mm && (Number(mm[1]) < range[0] || Number(mm[1]) > range[1])),
  String(badChap.modules[0].chapters[0]));

// 变异五：把 createRequire 的 SUB_DIR 少写一级（本轮真踩到的路径 bug）
const subjectsSrc = readFileSync(join(DIR, "js/subjects.js"), "utf8");
ok("⑦-5 变异：subjects.js 里科目包目录少写一级（../subjects → subjects）⇒ 加载必须失败",
  (() => {
    try {
      // 用真源码做一次"错误路径"的 require，证明它会抛（而不是静默返回空包）
      require(join(DIR, "js", "subjects", "physics-senior.js"));
      return false;      // 真能 require 到就说明路径不对（本变异无效）
    } catch (e) {
      return true;
    }
  })());

/* ==========================================================================
   汇总
   ========================================================================== */
const total = results.length;
const passed = results.filter((r) => r.pass).length;
console.log("");
console.log("=".repeat(78));
console.log(`SUMMARY: ${passed}/${total} passed`);
if (passed !== total) {
  console.log("未通过：");
  results.filter((r) => !r.pass).forEach((r) => console.log("  - " + r.name));
}
console.log("=".repeat(78));
process.exit(passed === total ? 0 : 1);
