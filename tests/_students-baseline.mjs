// 阶段2 第1步 · 对照组基线采集（改代码**之前**跑）
//
// 目的：证明「给 feedback-db.ts 加列读取」没有动到任何**老字段**。
// 做法：
//   ① 用固定探针数据（新列也一起写进去）建一条档案 + 一条历史；
//   ② 调 /api/feedback/data，把响应里**老字段**的值存成基线；
//   ③ 改完代码后再跑一次，逐字段比对 → 老字段少一个或值变了就红。
//
// ⚠️ 必须在改 feedback-db.ts **之前**跑，否则基线里已经混进新值。
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers } from "./_helpers.mjs";

const NODE = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT = "D:\\my-website\\my-toolbox\\node_modules\\next\\dist\\bin\\next";
const CWD = "D:\\my-website\\my-toolbox";
const BASE = "http://127.0.0.1:3000";
const OUT = `${CWD}\\tests\\_students-baseline.json`;

/** 固定探针（不要用随机值：对照组要跨两次运行比得起来） */
export const PROBE = {
  name: "__对照组探针·张三",
  subject: "math",
  salutation: "妈妈",
  teacher: "郭庆杰",
  type: "regular",
  notes: "老字段 notes（含换行\n与符号 &<>\"）",
  // 新列（0014 加的）：故意都给上非空值，这样"漏读新列"也看得出来
  grade: "高三",
  gender: "男",
  campus: "燕郊中学校区",
  manager: "李学管",
  class_name: "3班",
  attitude: "计算能力弱、畏难留白",
  extra: { cls: "3班", phase: "秋", score: 62, target: 100 },
};
export const PROBE_HIST = {
  text: "对照组历史正文（含换行\n与符号 &<>\"）",
  date: "2026-10-07",           // paper 那条会用自由文本，这条用 ISO 稳一点
  type_name: "regular",
  subject: "math",
  title: "对照组考试名",
  score: 86,
  full_score: 150,
  tool: "feedback",
};

const ps = (c) => spawnSync("powershell", ["-NoProfile", "-Command", c], { encoding: "utf8" }).stdout.trim();
const killPort = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
};

/** 老字段白名单：**一个都不能少**（漏一个就说明改动删了东西）
 *
 *  ⚠️ `id` / `saved` / `updated` **故意排除在「值要比对」之外**
 *     （但仍然参与「字段在不在」的检查）：
 *     探针每次运行都是「先删后建」，自增 id 必然不同、时间戳必然不同；
 *     而 `updated` 是**「最后一次修改的日期」**（`updated_at.slice(0,10)`），
 *     只要跨过零点就会变 —— 2026-10-09 实测踩到：
 *     基线是 10-08、当天跑出来是 10-09，红线1 因此**假红**。
 *     把它们当成「值变了」会得到一条永远红的假断言。
 *     ⚠️ 但**类型**仍然要在 diffFields 里验（见那里的 volatile 分支）。 */
export const OLD_STUDENT_FIELDS = ["subject", "salutation", "teacher", "type", "notes", "updated", "id"];
export const OLD_HISTORY_FIELDS = ["text", "date", "typeName", "subject", "saved", "id"];
/** 值比对时跳过的字段（非确定性：自增 id、真时间戳、按天滚动的 updated） */
export const VOLATILE_FIELDS = new Set(["id", "saved", "updated"]);
/** 允许新增的字段（对照组里单独列出来看，不算"变了"） */
export const NEW_STUDENT_FIELDS = ["grade", "gender", "campus", "manager", "class_name", "attitude", "extra"];
export const NEW_HISTORY_FIELDS = ["tool", "title", "score", "fullScore"];

/** 只挑老字段，做成可比对的快照 */
export function oldOnlyStudent(stu) {
  const out = {};
  for (const k of OLD_STUDENT_FIELDS) out[k] = stu[k] === undefined ? "<缺失>" : stu[k];
  return out;
}
export function oldOnlyHistory(item) {
  const out = {};
  for (const k of OLD_HISTORY_FIELDS) out[k] = item[k] === undefined ? "<缺失>" : item[k];
  return out;
}

export async function loginCookie(email, password) {
  const { SUPABASE_URL, ANON_KEY } = readEnv();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const session = await res.json();
  if (!session.access_token) throw new Error("登录失败: " + JSON.stringify(session).slice(0, 200));
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  const chunks = [];
  for (let i = 0; i * 3180 < value.length; i++) chunks.push(value.slice(i * 3180, (i + 1) * 3180));
  return chunks.map((c, i) => `${name}${chunks.length > 1 ? "." + i : ""}=${c}`).join("; ");
}

export async function ensureServer() {
  killPort();
  await sleep(1200);
  const srv = spawn(NODE, [NEXT, "start", "-p", "3000"], {
    cwd: CWD,
    stdio: "ignore",
    // 让 /api/debug/* 可用（走 src/lib/debug-gate.ts 那一处开关）。
    // ⚠️ `next start` 会把 NODE_ENV 设成 production，所以**不能**靠 NODE_ENV 判断 ——
    //    那个判断也是死代码（Next 构建期内联），门只看这两个变量。
    // ⚠️ 生产环境两个都不该出现 —— 那时这些路由等于不存在。
    // STUDENTS_TEST_NO_DEBUG=1 时故意不配，用来验证「没配也全绿」。
    env: DEBUG_DISABLED
      ? (() => { const e = { ...process.env }; delete e.DEBUG_CACHE_TOKEN; delete e.ALLOW_DEBUG_CACHE_CLEAR; return e; })()
      : { ...process.env, DEBUG_CACHE_TOKEN: DEBUG_TOKEN, ALLOW_DEBUG_CACHE_CLEAR: "1" },
  });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(`${BASE}/login`)).status === 200) return srv; } catch {}
  }
  return srv;
}

/** 造探针数据（幂等：先删后建，保证两次运行的输入完全相同） */
export async function seedProbe(cookie) {
  const del = async (q) => fetch(`${BASE}/api/feedback/data?${q}`, { method: "DELETE", headers: { cookie } });
  await del("student=" + encodeURIComponent(PROBE.name));
  await del("student=" + encodeURIComponent(PROBE.name)); // 历史是按 student_name 删的，删两次确保干净
  const sp = await fetch(`${BASE}/api/feedback/data`, {
    method: "POST", headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ op: "student", ...PROBE }),
  });
  const hp = await fetch(`${BASE}/api/feedback/data`, {
    method: "POST", headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ op: "history", studentName: PROBE.name, ...PROBE_HIST }),
  });
  return { studentStatus: sp.status, historyStatus: hp.status };
}

/** 测试用的 debug token（与 startServer 传进环境变量的那个一致）
 *  ⚠️ 长度必须 ≥ 24（`src/lib/debug-gate.ts` 会拒绝过短的 token），所以别随手改短。 */
export const DEBUG_TOKEN = "students-unified-test-token-please-do-not-shorten";

/** 是否连调试口一起起（默认起）。
 *  设 `STUDENTS_TEST_NO_DEBUG=1` 就**故意不配**调试口 —— 用来验证：
 *  「调试口没配置时（= 生产环境的样子），测试仍然全绿，对照组明确跳过而不是变红」。 */
export const DEBUG_DISABLED = process.env.STUDENTS_TEST_NO_DEBUG === "1";

/**
 * 清掉服务端**进程内**的学生/历史缓存。
 *
 * ⚠️ 必须有这一步：测试里有时要**绕过写接口直接改库**（造带新列的档案），
 *    那时没有任何代码路径去清缓存，会读到最长 25 秒的旧值，
 *    症状非常像「功能坏了」。走 `/api/debug/clear-caches`（仅非生产 + 需要 token）。
 *
 * ⚠️ 必须带上会话 cookie：中间件对 `/api/*` 一律要求登录（未登录返回 401 JSON），
 *    不是这个路由自己的要求 —— 忘了带 cookie 会拿到 401，看着像路由不存在。
 *
 * 返回 true 表示真的清了；false 说明没清成（调用方应当据此报错，别静默继续）。
 */
export async function clearServerCaches(cookie) {
  const r = await fetch(`${BASE}/api/debug/clear-caches`, {
    method: "POST",
    headers: { "x-debug-token": DEBUG_TOKEN, ...(cookie ? { cookie } : {}) },
  });
  const body = await r.json().catch(() => null);
  return { ok: !!(r.ok && body?.ok && body?.cleared), status: r.status, body };
}

/** 取「学生 + 历史」快照
 *
 *  ⚠️ 两个口径都要给：
 *    · `student` / `historyItem` = **完整**响应对象（新老字段都在）→ 用来验新列；
 *    · `studentOld` / `historyOld` = **只挑老字段**的投影 → 用来与基线做逐字节比对
 *      （不能拿完整对象比：多出来的新字段会被算成「变了」）。
 *  ⚠️ 历史不能想当然取第一条：同一个人可能有多条（feedback 的 + paper 的），
 *    而且查询是 created_at desc。要精确比对就**按 text 找那条探针**。 */
export async function snapshot(cookie) {
  const r = await fetch(`${BASE}/api/feedback/data?stage=senior&subject=math`, { headers: { cookie } });
  const body = await r.json();
  const stu = body?.students?.[PROBE.name] || null;
  const list = body?.history?.[PROBE.name] || [];
  const item = list.find((h) => h?.text === PROBE_HIST.text) || null;
  return {
    status: r.status,
    student: stu,
    /** 全部学生（按姓名索引）—— 探针名不止一个（PROBE.name / PROBE.name+后缀），
     *  只返回 `student` 那一个会让调用方拿到 undefined，看着像「功能没生效」。 */
    studentsAll: body?.students || {},
    historyItem: item,
    historyCount: list.length,
    studentOld: stu ? oldOnlyStudent(stu) : null,
    historyOld: item ? oldOnlyHistory(item) : null,
  };
}

// ---------------------------------------------------------------- 直接执行时：采集基线
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const srv = await ensureServer();
  try {
    const { adminEmail, password } = readUsers();
    const cookie = await loginCookie(adminEmail, password);
    const seeded = await seedProbe(cookie);
    console.log("探针写入:", JSON.stringify(seeded));
    const snap = await snapshot(cookie);
    console.log("响应状态:", snap.status);
    console.log("学生老字段:", JSON.stringify(snap.studentOld, null, 1));
    console.log("历史老字段:", JSON.stringify(snap.historyOld, null, 1));
    console.log("学生响应里现有全部键:", JSON.stringify(Object.keys(snap.studentRaw || {})));
    console.log("历史响应里现有全部键:", JSON.stringify(Object.keys(snap.historyRaw || {})));
    writeFileSync(OUT, JSON.stringify(snap, null, 2), "utf8");
    console.log("\n基线已写入:", OUT);
  } finally {
    if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`]);
    killPort();
  }
}
