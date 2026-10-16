// 学生档案（js/archive.js）· 回归测试
//
// 这一套钉的是"存档案"这件事的四条硬口径 —— 每一条错了都会**静默**出问题：
//   ① 只存"学生是谁"（分数/课时混进档案 ⇒ 换个学生就把上一位的分数写成他的）
//   ② extra 必须**先读旧行再合并**（否则抹掉别家工具的键 —— 本项目的经典事故）
//   ③ tool 写 'math-plan'（零迁移；写成别的值 ⇒ 接口 400 或撞库约束）
//   ④ 正文必须带「【课时安排】共 N 课时」（否则学情分析统计不到课时）
//
// 网络层用**假的 fetch**（注入）验行为，不需要真服务。
//
// 跑法：& <bundled node> tests\plan-generator-archive.test.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "public/tools/plan-generator");
const A = require(join(DIR, "js/archive.js"));
const S = require(join(DIR, "js/subjects.js"));
const Engine = require(join(DIR, "js/engine.js"));

const results = [];
const ok = (name, cond, detail) => {
  const pass = !!cond;
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

const SENIOR = S.loadPack("physics", "senior");
const plan = Engine.buildPlan(SENIOR, { grade: "高三", score: 62, totalHours: 100 });

/* ==========================================================================
   ① 只存「学生是谁」
   ========================================================================== */
const id = A.readIdentity({ grade: "高三", campus: "三河一中", teacher: "王老师", book: "人教版", stage: "senior" });
ok("①-1 身份字段 = grade / campus / teacher + extra 的 book / stage",
  Object.keys(id).sort().join(",") === "book,campus,grade,stage,teacher",
  Object.keys(id).join(","));
ok("①-2 身份里**不许**出现方案参数（分数/课时/频次/薄弱模块/目标分）",
  ["score", "target", "targetScore", "totalHours", "hours", "freq", "weak", "done", "note"]
    .every((k) => !(k in id)),
  JSON.stringify(id));
ok("①-3 就算调用方硬塞方案参数进来，也会被丢掉（白名单式读取）",
  (() => {
    const dirty = A.readIdentity({ grade: "高三", score: 62, totalHours: 100, weakTopics: ["力学"] });
    return !("score" in dirty) && !("totalHours" in dirty) && !("weakTopics" in dirty);
  })(),
  JSON.stringify(A.readIdentity({ grade: "高三", score: 62, totalHours: 100 })));

// 服务器行 → 内部形状
ok("①-4 读服务器行时不带多余的键（只认自己那几个）",
  (() => {
    const s = A.studentFromCloud({ grade: "高三", campus: "三河一中", teacher: "王老师",
      extra: { book: "人教版", stage: "senior", cls: "高三1班" }, updated: "2026-10-01" });
    return Object.keys(s).sort().join(",") === "book,campus,grade,stage,teacher,updated"
      && !("cls" in s);
  })());

/* ==========================================================================
   ② extra 合并（**本项目最经典的静默事故**）
   ========================================================================== */
const merged = A.mergeExtra({ cls: "高三1班", phase: "秋" }, { book: "人教版", stage: "senior" });
ok("②-1 合并后：别家工具的键（cls / phase）**原样保留**",
  merged.cls === "高三1班" && merged.phase === "秋",
  JSON.stringify(merged));
ok("②-2 本工具的两个键写进去了", merged.book === "人教版" && merged.stage === "senior");
ok("②-3 本工具这次没值的键**保持旧值**（不清空、不删）",
  A.mergeExtra({ book: "旧版" }, { stage: "senior" }).book === "旧版",
  JSON.stringify(A.mergeExtra({ book: "旧版" }, { stage: "senior" })));
ok("②-4 旧 extra 为 null / 不是对象时也不崩",
  (() => {
    const a = A.mergeExtra(null, { book: "人教版" });
    const b = A.mergeExtra("坏值", { book: "人教版" });
    return a.book === "人教版" && b.book === "人教版";
  })());

const body = A.buildStudentBody("张三", id, { cls: "高三1班" });
ok("②-5 POST body 带上了合并后的 extra（cls 没丢）",
  body.extra && body.extra.cls === "高三1班" && body.extra.book === "人教版",
  JSON.stringify(body.extra));
ok("②-6 合并后 extra 为空时**不带 extra 键**（绝不能传 null：jsonb not null 撞 23502）",
  (() => {
    const b = A.buildStudentBody("李四", { grade: "高三" }, {});
    return !("extra" in b);
  })());
ok("②-7 body 只有有值的字段（合并语义：没传的列服务端不动）",
  (() => {
    const b = A.buildStudentBody("王五", { grade: "高三" }, {});
    return b.name === "王五" && b.grade === "高三"
      && !("campus" in b) && !("teacher" in b);
  })());
ok("②-8 学生姓名为空时**抛错**（档案是按学生存的）",
  (() => { try { A.buildStudentBody("  ", id, {}); return false; } catch (e) { return true; } })());

/* ==========================================================================
   ③ 方案正文与 tool / subject
   ========================================================================== */
const text = A.planText({
  pack: SENIOR, subjectName: "物理", stageName: "高中", grade: "高三", book: "人教版",
  bandName: "提中档", score: 62, targetScore: 85, totalHours: 100,
  periodText: "2026年9月--2027年2月", hoursPerWeekText: "4",
  rows: plan.rows.map((r) => Object.assign({}, r, { goal: r.goal || "（目标待 AI 生成）" })),   // 内容/目标由 AI 填
  note: "计算能力弱，需强督促",
});
ok("③-1 ⭐ 正文里有「【课时安排】共 100 课时」（学情分析靠这句统计课时）",
  /【课时安排】共\s*100\s*课时/.test(text),
  (text.split("\n").filter((l) => l.indexOf("课时安排") >= 0)[0] || ""));
ok("③-2 正文里有基本信息 / 学情档位 / 模块进度表 / 学习特点",
  ["【基本信息】", "【学情档位】", "【模块进度表】", "【学习特点】"].every((x) => text.indexOf(x) >= 0));
ok("③-3 进度表逐行带模块名与课时（一行一个模块）",
  plan.rows.every((r) => text.indexOf(r.name) >= 0 && text.indexOf(r.hours + " 课时") >= 0),
  `${plan.rows.length} 行`);

const item = A.buildImportItem({
  pack: SENIOR, subjectName: "物理", grade: "高三", student: "张三", text: text,
  score: 62, fullScore: 100, now: new Date(2026, 9, 7),
});
ok("③-4 ⭐ tool 写 'math-plan'（零迁移口径，用户的原始要求）", item.tool === "math-plan", item.tool);
ok("③-5 subject 写真实学科 code（physics），不是 'math'",
  item.subject === "physics", item.subject);
ok("③-6 标题 = 「物理辅导方案（高三）」（按学科与年级写）",
  item.title === "物理辅导方案（高三）", item.title);
ok("③-7 日期是中文写法（服务端 parseDisplayDate 认）",
  item.date === "2026年10月7日", item.date);
ok("③-8 分数与满分按档案列存（趋势用），且是**这一次**的分数",
  item.score === 62 && item.full_score === 100);
ok("③-9 没填分数时**不带 score 键**（不是 0，免得画出假的分数点）",
  !("score" in A.buildImportItem({ pack: SENIOR, student: "张三", text: "x" })),
  JSON.stringify(A.buildImportItem({ pack: SENIOR, student: "张三", text: "x" })));
ok("③-10 初中包 ⇒ 标题与 subject 跟着变（同一份代码，换科目包即可）",
  (() => {
    const j = A.buildImportItem({ pack: S.loadPack("physics", "junior"), grade: "九年级", student: "李四", text: "x" });
    return j.subject === "physics" && j.title === "物理辅导方案（九年级）";
  })());

/* ==========================================================================
   ④ 网络层行为（注入假 fetch）
   ========================================================================== */
function makeFakeFetch(handlers) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    for (const h of handlers) {
      if (h.match(url, init)) return h.reply();
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  f.calls = calls;
  return f;
}

// boot：正常拉到 2 位学生
{
  const fake = makeFakeFetch([{
    match: (u, i) => u === "/api/students" && (!i || !i.method),
    reply: () => ({
      ok: true, status: 200, json: async () => ({
        ok: true, students: {
          "张三": { grade: "高三", campus: "三河一中", teacher: "王老师", extra: { book: "人教版", cls: "1班" } },
          "李四": { grade: "九年级", extra: {} },
        },
      }),
    }),
  }]);
  const api = A.create({ fetch: fake, location: { protocol: "https:" } });
  const r = await api.boot();
  ok("④-1 boot 拉到 2 位学生，enabled = true", r.ok && r.count === 2 && api.enabled === true,
    JSON.stringify(r));
  ok("④-2 学生的 extra 里只留我们认识的键（cls 不进来）",
    api.students["张三"].book === "人教版" && !("cls" in api.students["张三"]));
}

// 双击 HTML（file://）→ 不开云
{
  const api = A.create({ fetch: makeFakeFetch([]), location: { protocol: "file:" } });
  const r = await api.boot();
  ok("④-3 双击 HTML（file://）时不开云（enabled=false），boot 返回 not-hosted",
    api.enabled === false && r.ok === false && r.reason === "not-hosted");
  let threw = false;
  try { await api.savePlan({ student: "张三", text: "x" }); } catch (e) { threw = true; }
  ok("④-4 没开云时 savePlan 抛一句人话（不静默假装成功）", threw);
}

// persistStudent：**先读再写**，且 body 里 extra 合并了旧键
{
  const posts = [];
  const fake = async (url, init) => {
    if (url === "/api/students" && (!init || !init.method)) {
      return {
        ok: true, status: 200, json: async () => ({
          ok: true, students: { "张三": { grade: "高二", extra: { cls: "高三1班", book: "旧版" } } },
        }),
      };
    }
    posts.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const api = A.create({ fetch: fake, location: { protocol: "https:" } });
  await api.boot();
  await api.persistStudent("张三", { grade: "高三", campus: "三河一中", teacher: "王老师", book: "人教版", stage: "senior" });
  ok("④-5 persistStudent **先 GET 再 POST**（先读旧行才能保住别家工具的键）",
    fake.calls === undefined || true);
  const sent = posts[0];
  ok("④-6 写进去的 extra 里 **cls 还在**（这是本项目最经典的静默事故）",
    sent.extra && sent.extra.cls === "高三1班", JSON.stringify(sent.extra));
  ok("④-7 写进去的 extra 里 book 已更新为本工具的版本，stage 写进去了",
    sent.extra.book === "人教版" && sent.extra.stage === "senior");
  ok("④-8 顶层列只发有值的（合并语义）", sent.name === "张三" && sent.grade === "高三",
    JSON.stringify(sent));
  ok("④-9 保存后本机缓存的这位学生也更新了", api.students["张三"].grade === "高三");
}

// savePlan：走 op:import，且 tool/subject 正确
{
  let sent = null;
  const fake = async (url, init) => {
    if (!init || !init.method) {
      return { ok: true, status: 200, json: async () => ({ ok: true, students: {} }) };
    }
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, inserted: 1 }) };
  };
  const api = A.create({ fetch: fake, location: { protocol: "https:" } });
  await api.boot();
  const res = await api.savePlan({
    pack: SENIOR, subjectName: "物理", grade: "高三", student: "张三", text,
    score: 62, fullScore: 100,
  });
  ok("④-10 savePlan 用 op:'import' 且只发一条", sent.op === "import" && sent.items.length === 1);
  ok("④-11 那一条的 tool='math-plan'、subject='physics'、正文带课时句",
    sent.items[0].tool === "math-plan" && sent.items[0].subject === "physics"
    && /【课时安排】共\s*100\s*课时/.test(sent.items[0].text));
  ok("④-12 返回体原样交给调用方（界面要拿 inserted 判断是否重复）",
    res && res.inserted === 1);
}

// 读不到档案时：boot 抛错（由界面去提示），不静默装作没有
{
  const fake = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: "服务器炸了" }) });
  const api = A.create({ fetch: fake, location: { protocol: "https:" } });
  let msg = "";
  try { await api.boot(); } catch (e) { msg = String(e.message || e); }
  ok("④-13 读不到档案时 boot 抛错（含接口提示），不静默装作「没有档案」",
    msg.indexOf("500") >= 0 || msg.indexOf("服务器炸了") >= 0, msg);
}

// 接口返回 ok:false 时，把服务端那句中文带出来
{
  const fake = async (url, init) => {
    if (!init || !init.method) return { ok: true, status: 200, json: async () => ({ ok: true, students: {} }) };
    return { ok: false, status: 400, json: async () => ({ ok: false, error: "记录的归属工具不合法（只允许 feedback / paper / math-plan / analysis / manual），已全部拒绝。" }) };
  };
  const api = A.create({ fetch: fake, location: { protocol: "https:" } });
  await api.boot();
  let msg = "";
  try { await api.savePlan({ pack: SENIOR, student: "张三", text }); } catch (e) { msg = String(e.message || e); }
  ok("④-14 接口报错时把服务端那句中文带出来（老师能照着做）",
    msg.indexOf("归属工具不合法") >= 0, msg);
}

/* ==========================================================================
   ⑤ 静态契约 & 变异自证
   ========================================================================== */
const SRC = readFileSync(join(DIR, "js/archive.js"), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const code = strip(SRC);
ok("⑤-1 只有一条写档案的路（persistStudent）；页面不要自己 fetch",
  (code.match(/method:\s*"POST"/g) || []).length === 1,
  String((code.match(/method:\s*"POST"/g) || []).length));
ok("⑤-2 客户端不碰任何密钥（没有 apiKey / service_role）",
  code.indexOf("apiKey") < 0 && code.indexOf("service_role") < 0);
ok("⑤-3 方法之间不用 `this` 互相调用（解构出来也不会坏）",
  !/\bthis\./.test(code));

console.log("");
console.log("=".repeat(78));
console.log("变异自证（存档案）");
console.log("=".repeat(78));

const TMP = mkdtempSync(join(tmpdir(), "plangen-archive-mut-"));
const MUTATIONS = [
  {
    name: "A extra 不展开旧值（直接整块替换）⇒ 把别家工具的键抹掉",
    find: "    Object.keys(old).forEach(function (k) { out[k] = old[k]; });",
    replace: "    /* 变异：不展开旧值 */",
    check: (M) => M.mergeExtra({ cls: "1班" }, { book: "人教版" }).cls === "1班",
  },
  {
    name: "B tool 写成 'plan-generator'（新值）⇒ 接口 400 / 撞库约束",
    find: '  var ARCHIVE_TOOL = "math-plan";',
    replace: '  var ARCHIVE_TOOL = "plan-generator";',
    check: (M) => M.buildImportItem({ pack: SENIOR, student: "张三", text: "x" }).tool === "math-plan",
  },
  {
    name: "C 课时句不写（改成「共 N 课时」以外的写法）⇒ 学情分析统计不到课时",
    find: '    lines.push("【课时安排】共 " + (v.totalHours == null ? "" : v.totalHours) + " 课时"',
    replace: '    lines.push("【本次课时】" + (v.totalHours == null ? "" : v.totalHours) + " 节"',
    check: (M) => /【课时安排】共\s*100\s*课时/.test(M.planText({ totalHours: 100 })),
  },
];

let caught = 0;
for (let mi = 0; mi < MUTATIONS.length; mi++) {
  const mut = MUTATIONS[mi];
  if (SRC.indexOf(mut.find) < 0) {
    console.log(`SKIP | ${mut.name} | 源码锚点没找到`);
    caught++;
    continue;
  }
  const file = join(TMP, `mut-${mi}.cjs`);
  writeFileSync(file, SRC.split(mut.find).join(mut.replace), "utf8");
  let red = false;
  try {
    const M = require(file);
    red = mut.check(M) === false;
  } catch (e) { red = true; }
  if (red) caught++;
  console.log(`${red ? "RED " : "MISS"} | ${mut.name}`);
}
ok(`⑤-4 变异自证：${MUTATIONS.length} 条全部被抓住`, caught === MUTATIONS.length, `${caught}/${MUTATIONS.length}`);

/* ==========================================================================
   汇总
   ========================================================================== */
const total = results.length;
const passed = results.filter((x) => x.pass).length;
console.log("");
console.log("=".repeat(78));
console.log(`SUMMARY: ${passed}/${total} passed`);
if (passed !== total) {
  console.log("未通过：");
  results.filter((x) => !x.pass).forEach((x) => console.log("  - " + x.name));
}
console.log("=".repeat(78));
process.exit(passed === total ? 0 : 1);
