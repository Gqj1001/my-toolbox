/**
 * 统一学生档案 · 阶段2 测试
 *
 * 这个文件是阶段 2 三条红线的**可执行证据**：
 *   红线1（返回结构逐字节兼容）→ 第 1 组：老字段与基线逐字段比对，少一个/变一个就红
 *   红线2（缓存 key 拼 user_id）→ 第 3 组：两个账号互相看不到（阶段2 第3步补）
 *   红线3（parseDisplayDate 行为零改动）→ 第 2 组（阶段2 第2步补）
 *
 * 前置：`tests/_students-baseline.json` 必须是**改代码之前**采的基线
 *       （用 `node tests/_students-baseline.mjs` 采）。
 *
 * 跑法：
 *   & "<bundled node>" tests\students-unified.test.mjs
 * ⚠️ 它自己起 next start（端口 3000）并杀掉旧监听，别和其它真服务套件同时跑。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { makeRecorder, readEnv, readUsers } from "./_helpers.mjs";
import {
  DEBUG_TOKEN, NEW_HISTORY_FIELDS, NEW_STUDENT_FIELDS, OLD_HISTORY_FIELDS, OLD_STUDENT_FIELDS,
  PROBE, PROBE_HIST, VOLATILE_FIELDS, clearServerCaches, ensureServer, loginCookie, seedProbe, snapshot,
} from "./_students-baseline.mjs";

const CWD = "D:\\my-website\\my-toolbox";
const BASE = "http://127.0.0.1:3000";
const BASELINE = `${CWD}\\tests\\_students-baseline.json`;

const { record, summary } = makeRecorder();

/** 逐字段比对：老字段**一个都不能少**，且值必须与基线一致（id/saved 这种非确定性字段只比类型） */
function diffFields(label, before, after, fields, rec) {
  const missing = [], changed = [];
  for (const k of fields) {
    if (!(k in (after || {}))) { missing.push(k); continue; }
    if (VOLATILE_FIELDS.has(k)) continue;   // 值跳过比对，但"在不在"上面已经查过
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) {
      changed.push(`${k}: ${JSON.stringify(before?.[k])} → ${JSON.stringify(after?.[k])}`);
    }
  }
  rec(`★红线1 ${label}：老字段一个都没少（共 ${fields.length} 个）`, missing.length === 0,
    missing.length ? `缺失=[${missing.join(",")}]` : "");
  const stableCount = fields.length - fields.filter((k) => VOLATILE_FIELDS.has(k)).length;
  rec(`★红线1 ${label}：老字段的值与基线逐字节一致（${stableCount} 个稳定字段）`, changed.length === 0,
    changed.length ? changed.join(" | ") : `（id/saved 为非确定性字段，只验类型）`);
}

let srv = null;
try {
  srv = await ensureServer();
  record("next start 起来了", true);
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { if ((await fetch(`${BASE}/login`)).status === 200) { up = true; break; } } catch {}
  }
  if (!up) throw new Error("服务器没起来");

  if (!existsSync(BASELINE)) throw new Error(`缺少基线文件 ${BASELINE}（先跑 tests/_students-baseline.mjs）`);
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  record("读得到改代码前采的基线", !!baseline?.studentOld && !!baseline?.historyOld,
    `基线学生老字段 ${Object.keys(baseline?.studentOld || {}).length} 个`);

  const { adminEmail, userEmail, password } = readUsers();
  const otherEmail = userEmail;   // roleb-* —— 跨账号隔离测试用
  const cookie = await loginCookie(adminEmail, password);
  record("用真会话登录成功", !!cookie);

  // 用**同一份固定探针数据**重建，保证两次运行的输入完全相同
  const seeded = await seedProbe(cookie);
  record("探针档案 + 探针历史写入成功", seeded.studentStatus === 200 && seeded.historyStatus === 200,
    JSON.stringify(seeded));

  const snap = await snapshot(cookie);
  record("接口返回 200", snap.status === 200, `status=${snap.status}`);
  record("探针档案能在响应里找到", !!snap.student);
  record("探针历史能在响应里找到（按正文精确定位，不是取最新一条）", !!snap.historyItem,
    `该学生共 ${snap.historyCount} 条历史`);

  // ---------------------------------------------------------------- 第 1 组：红线1
  diffFields("学生档案", baseline.studentOld, snap.studentOld, OLD_STUDENT_FIELDS, record);
  diffFields("反馈历史", baseline.historyOld, snap.historyOld, OLD_HISTORY_FIELDS, record);

  // 老字段的类型也不能变（"1" vs 1 这种最容易漏）
  record("★红线1 学生 id 仍是数字（没被 jsonb/字符串化）",
    typeof snap.student?.id === "number", `typeof id = ${typeof snap.student?.id}`);
  record("★红线1 历史 saved 仍是 ISO 字符串",
    typeof snap.historyItem?.saved === "string" && /^\d{4}-\d{2}-\d{2}T/.test(snap.historyItem.saved),
    `saved=${snap.historyItem?.saved}`);
  record("★红线1 历史 date 仍是显示格式（不是 ISO）",
    typeof snap.historyItem?.date === "string" && /月/.test(snap.historyItem.date),
    `date=${snap.historyItem?.date}`);

  // ---------------------------------------------------------------- 第 1b 组：新字段确实加上了
  const newStuMissing = NEW_STUDENT_FIELDS.filter((k) => !(k in (snap.student || {})));
  record("新列：学生档案响应里已带上新字段", newStuMissing.length === 0,
    newStuMissing.length ? `缺=[${newStuMissing.join(",")}] 现有=[${Object.keys(snap.student || {}).join(",")}]`
      : `现有键=[${Object.keys(snap.student || {}).join(",")}]`);
  const newHistMissing = NEW_HISTORY_FIELDS.filter((k) => !(k in (snap.historyItem || {})));
  record("新列：反馈历史响应里已带上新字段", newHistMissing.length === 0,
    newHistMissing.length ? `缺=[${newHistMissing.join(",")}]` : `现有键=[${Object.keys(snap.historyItem || {}).join(",")}]`);

  // 老行（feedback 工具自己建的）里新列都是 NULL → 必须给安全默认值，不能是 undefined
  record("★老行安全默认：新字段是空串/{} 而不是 undefined",
    snap.student?.grade === "" && snap.student?.campus === "" &&
      typeof snap.student?.extra === "object" && snap.student?.extra !== null,
    `grade=${JSON.stringify(snap.student?.grade)} extra=${JSON.stringify(snap.student?.extra)}`);
  record("★老行安全默认：历史 tool 默认 'feedback'、score 为 null",
    snap.historyItem?.tool === "feedback" && snap.historyItem?.score === null,
    `tool=${JSON.stringify(snap.historyItem?.tool)} score=${JSON.stringify(snap.historyItem?.score)}`);
  // 结构性红线：响应里**不应该**多出 name / user_id 这类字段。
  // name 是外层字典的 key；user_id 是隐私字段。加了它们就是改变了返回结构。
  record("★红线1 响应结构没被扩：学生对象里没有 name / user_id",
    snap.student && !("name" in snap.student) && !("user_id" in snap.student),
    `学生对象键=[${Object.keys(snap.student || {}).join(",")}]`);

  // ---------------------------------------------------------------- 第 1c 组：新列真的能从库里读出来
  // 现在 POST /api/feedback/data 还不认新字段（那是第 3 步 /api/students 的事），
  // 所以这里绕开它、直连 PostgREST 写一行带新列的档案，再确认**接口能读出来**。
  const { SUPABASE_URL, ANON_KEY } = readEnv();
  const tok = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password }),
  })).json();
  const H = { apikey: ANON_KEY, Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" };
  const richName = PROBE.name + "·富字段";
  await fetch(`${SUPABASE_URL}/rest/v1/feedback_students?name=eq.${encodeURIComponent(richName)}`, { method: "DELETE", headers: H });
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/feedback_students`, {
    method: "POST", headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({
      name: richName, subject: "math", grade: "高二", gender: "女", campus: "燕郊中学校区",
      manager: "李学管", class_name: "5班", attitude: "审题不细",
      extra: { phase: "秋", score: 88, target: 120, cls: "5班" },
    }),
  });
  record("（准备）直连库写入一份带全部新列的档案", ins.status === 201, `status=${ins.status}`);
  // 直连库写入绕过了写接口 → 服务端进程内缓存不会自动清，必须显式清，
  // 否则会读到 25 秒内的旧值（这一步本身就是「缓存确实存在且需要失效」的证据）。
  const cleared1 = await clearServerCaches(cookie);
  record("能清掉服务端进程内缓存（否则下面读到的是旧值）", cleared1.ok,
    `status=${cleared1.status} body=${JSON.stringify(cleared1.body)}`);

  const withRich = await snapshot(cookie);
  // ⚠️ 必须按 richName 取：snapshot() 的 `student` 只对应 PROBE.name 那一个，
  //    拿它去验另一条档案会永远是 undefined（本轮踩过）。
  const rich = withRich.studentsAll[richName];
  record("★新列读得出来：grade/gender/campus/manager/class_name/attitude 全部就位",
    // ⚠️ 不要断言 `rich.name`：响应里**从来没有** name 字段 ——
    //    姓名是外层字典的 key（`{ 张三: {...} }`），这是老结构，不能顺手加个 name。
    rich?.grade === "高二" && rich.gender === "女" && rich.campus === "燕郊中学校区" &&
      rich.manager === "李学管" && rich.class_name === "5班" && rich.attitude === "审题不细",
    JSON.stringify({ grade: rich?.grade, gender: rich?.gender, campus: rich?.campus,
      manager: rich?.manager, class_name: rich?.class_name, attitude: rich?.attitude }));
  record("★新列读得出来：extra jsonb 原样返回（不是字符串）",
    rich && typeof rich.extra === "object" && rich.extra?.score === 88 && rich.extra?.phase === "秋",
    `extra=${JSON.stringify(rich?.extra)} typeof=${typeof rich?.extra}`);

  // 直连库写的历史：验证 tool/title/score/full_score 读得出来
  await fetch(`${SUPABASE_URL}/rest/v1/feedback_history?student_name=eq.${encodeURIComponent(richName)}`, { method: "DELETE", headers: H });
  const hins = await fetch(`${SUPABASE_URL}/rest/v1/feedback_history`, {
    method: "POST", headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({
      student_name: richName, text: "试卷分析记录正文", date: "2026-10-07",
      subject: "math", tool: "paper", title: "深圳市一模", score: 86, full_score: 150,
    }),
  });
  record("（准备）直连库写入一条 paper 归属的历史", hins.status === 201, `status=${hins.status}`);
  const cleared2 = await clearServerCaches(cookie);
  record("能清掉服务端进程内缓存（第二步）", cleared2.ok,
    `status=${cleared2.status} body=${JSON.stringify(cleared2.body)}`);
  // ⚠️ paper 那条历史属于**另一个探针名**（richName），不在 PROBE.name 名下，
  //    所以这里按名字单独取它的那一条，不能复用 historyItem（那是 feedback 的探针）。
  const rh = await (async () => {
    const r2 = await fetch(`${BASE}/api/feedback/data?stage=senior&subject=math`, { headers: { cookie } });
    const b2 = await r2.json();
    return (b2?.history?.[richName] || [])[0] || null;
  })();
  record("（准备）paper 历史挂在富字段学生名下", !!rh);
  record("★新列读得出来：tool/title/score/fullScore 全部就位",
    rh?.tool === "paper" && rh.title === "深圳市一模" && rh.score === 86 && rh.fullScore === 150,
    JSON.stringify({ tool: rh?.tool, title: rh?.title, score: rh?.score, fullScore: rh?.fullScore }));
  record("★paper 历史的 date 也走显示格式（与 feedback 一致）",
    /月/.test(rh?.date || ""), `date=${rh?.date}`);

  // ================================================================
  // 第 2 组：/api/students —— 合并语义（阶段2 第3步）
  // ================================================================
  const studentsApi = (q = "") => fetch(`${BASE}/api/students${q}`, { headers: { cookie } });
  const studentsPost = (body) => fetch(`${BASE}/api/students`, {
    method: "POST", headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const MERGE = "__合并语义探针";

  // 先清干净
  await fetch(`${BASE}/api/students?name=${encodeURIComponent(MERGE)}`, { method: "DELETE", headers: { cookie } });

  // ① math-plan 先存一份「它关心的字段」
  const p1 = await studentsPost({
    name: MERGE, grade: "高三", campus: "燕郊中学校区", teacher: "郭庆杰",
    extra: { phase: "秋", book: "人教A版", exam: "新高考Ⅰ卷", score: 62, target: 100 },
  });
  const p1b = await p1.json().catch(() => null);
  record("合并①：math-plan 风格写入成功（grade/campus/extra）",
    p1.status === 200 && p1b?.ok === true && p1b.student?.grade === "高三" &&
      p1b.student?.extra?.phase === "秋",
    `status=${p1.status} student=${JSON.stringify(p1b?.student)?.slice(0, 200)}`);

  // ② 再用「feedback 的老写路径」保存一次（只发 feedback 认识的那几个字段）
  //    这是真实场景：老师在反馈工具里点「保存档案」。
  const fbSave = await fetch(`${BASE}/api/feedback/data`, {
    method: "POST", headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      op: "student", name: MERGE, subject: "math",
      salutation: "妈妈", teacher: "郭庆杰（反馈）", type: "regular", notes: "反馈备注",
    }),
  });
  record("合并②：feedback 老写路径保存成功", fbSave.status === 200, `status=${fbSave.status}`);

  // ③ ★核心断言：走 /api/students 再存一次「只带 feedback 字段」
  //    模拟「换新接口之后」的行为 —— math-plan 存的字段必须**原样保留**
  const p3 = await studentsPost({
    name: MERGE, subject: "math", salutation: "妈妈",
    teacher: "郭庆杰（新接口）", type: "regular", notes: "新接口备注",
  });
  const p3b = await p3.json().catch(() => null);
  record("★合并③：只传 feedback 字段时，math-plan 的字段**没被清掉**",
    p3b?.ok === true &&
      p3b.student?.grade === "高三" &&
      p3b.student?.campus === "燕郊中学校区" &&
      p3b.student?.extra?.phase === "秋" &&
      p3b.student?.extra?.target === 100,
    `grade=${JSON.stringify(p3b?.student?.grade)} campus=${JSON.stringify(p3b?.student?.campus)} `
      + `extra=${JSON.stringify(p3b?.student?.extra)}`);
  record("★合并③：本次真正传了的字段**确实被更新**了",
    p3b?.student?.teacher === "郭庆杰（新接口）" && p3b?.student?.notes === "新接口备注",
    `teacher=${JSON.stringify(p3b?.student?.teacher)} notes=${JSON.stringify(p3b?.student?.notes)}`);

  // ④ 明确传 null 应当**清空**（区别于「没传」）
  const p4 = await studentsPost({ name: MERGE, attitude: null, campus: null });
  const p4b = await p4.json().catch(() => null);
  record("★合并④：明确传 null 会清空该字段（与「没传」区分开）",
    p4b?.ok === true && p4b.student?.campus === "" && p4b.student?.attitude === "" &&
      p4b.student?.grade === "高三",   // 没传的 grade 仍然保留
    `campus=${JSON.stringify(p4b?.student?.campus)} attitude=${JSON.stringify(p4b?.student?.attitude)} grade=${JSON.stringify(p4b?.student?.grade)}`);

  // ⑤ GET 列表 / 单查
  const list = await (await studentsApi()).json().catch(() => null);
  record("GET 列表返回当前用户的档案（含合并探针）",
    list?.ok === true && !!list.students?.[MERGE], `count=${list?.count}`);
  const one = await (await studentsApi(`?name=${encodeURIComponent(MERGE)}`)).json().catch(() => null);
  record("GET 单查返回该学生", one?.ok === true && one.student?.grade === "高三", JSON.stringify(one?.student)?.slice(0, 120));
  const missing = await (await studentsApi(`?name=${encodeURIComponent("不存在的学生xyz")}`)).json().catch(() => null);
  record("GET 单查不存在的学生 → ok:true 且 student:null（不是报错）",
    missing?.ok === true && missing.student === null, JSON.stringify(missing)?.slice(0, 120));

  // ⑥ 非法 extra 被拒
  const badExtra = await studentsPost({ name: MERGE, extra: [1, 2, 3] });
  record("POST 非法 extra（数组）被拒 400", badExtra.status === 400, `status=${badExtra.status}`);

  // ================================================================
  // 第 3 组：红线2 —— 跨账号隔离（A 存的学生，B 看不到）
  // ================================================================
  // roster：rolea-* = 免费/管理员（当前用），roleb-* = 另一位
  record("（准备）拿得到第二个账号用于隔离测试", !!otherEmail && otherEmail !== adminEmail,
    `A=${adminEmail} B=${otherEmail}`);
  const cookieB = await loginCookie(otherEmail, password);
  record("（准备）第二个账号登录取到会话", !!cookieB);

  // A 端存在（上面已建），现在用 B 端查：**绝不能看到 MERGE**
  const bList = await (await fetch(`${BASE}/api/students`, { headers: { cookie: cookieB } })).json().catch(() => null);
  record("★红线2 B 账号的档案列表里**没有** A 的学生",
    bList?.ok === true && !bList.students?.[MERGE],
    `B 端 count=${bList?.count} 是否含 A 的探针=${!!bList?.students?.[MERGE]}`);
  const bOne = await (await fetch(`${BASE}/api/students?name=${encodeURIComponent(MERGE)}`, { headers: { cookie: cookieB } }))
    .json().catch(() => null);
  record("★红线2 B 账号单查 A 的学生 → 拿到 null（不是 A 的数据）",
    bOne?.ok === true && bOne.student === null, JSON.stringify(bOne)?.slice(0, 160));

  // B 端自己也存一个同名学生：两边互不干扰
  const bSave = await fetch(`${BASE}/api/students`, {
    method: "POST", headers: { cookie: cookieB, "Content-Type": "application/json" },
    body: JSON.stringify({ name: MERGE, grade: "高二", notes: "这是B账号的" }),
  });
  const bSaveBody = await bSave.json().catch(() => null);
  record("★红线2 B 账号可以存同名学生（互不冲突）",
    bSave.status === 200 && bSaveBody?.student?.grade === "高二" && bSaveBody?.student?.notes === "这是B账号的",
    JSON.stringify(bSaveBody?.student)?.slice(0, 160));

  // A 端再查：**A 的数据没有被 B 覆盖**
  const aAgain = await (await studentsApi(`?name=${encodeURIComponent(MERGE)}`)).json().catch(() => null);
  record("★红线2 A 的数据没有被 B 的写入覆盖",
    aAgain?.student?.grade === "高三" && aAgain?.student?.notes === "新接口备注",
    `A 端 grade=${JSON.stringify(aAgain?.student?.grade)} notes=${JSON.stringify(aAgain?.student?.notes)}`);

  // B 的历史里也不该有 A 的
  const bHist = await (await fetch(`${BASE}/api/students?withHistory=1`, { headers: { cookie: cookieB } })).json().catch(() => null);
  record("★红线2 B 端 withHistory 里没有 A 的探针学生",
    bHist?.ok === true && !bHist.history?.[MERGE],
    `B 端 history 键=[${Object.keys(bHist?.history || {}).join(",")}]`);

  // ================================================================
  // 第 4 组：import 幂等（多次调用结果一致）
  // ================================================================
  const importItems = [
    // ⚠️ 用 `10月7日`（解析器支持的那种），**不要**用 `2026年10月7日` ——
    //    后者解析器不支持（正则里没有「年」），会返回 null。
    //    这条差异本身有诊断价值（见本组末尾的断言）：paper 的
    //    `examDate` 默认填的是「2026年10月7日」，**正好是解析不了的那一类**。
    { student_name: MERGE, text: "导入记录-A", date: "10月7日", tool: "paper",
      title: "深圳市一模", score: 86, full_score: 150, subject: "math" },
    { student_name: MERGE, text: "导入记录-B", date: "10-20", tool: "paper",
      title: "周测", score: 90, full_score: 150, subject: "math" },
    // 这两条日期解析不出来 → 必须被如实报告（不静默丢）
    { student_name: MERGE, text: "导入记录-C", date: "周三", tool: "paper",
      title: "日期无法识别", score: 70, full_score: 150, subject: "math" },
    { student_name: MERGE, text: "导入记录-D", date: "2026年10月7日", tool: "paper",
      title: "paper 默认格式", score: 60, full_score: 150, subject: "math" },
  ];
  const imp1 = await studentsPost({ op: "import", items: importItems });
  const imp1b = await imp1.json().catch(() => null);
  record("import 第一次：插入 4 条、跳过 0 条",
    imp1b?.ok === true && imp1b.inserted === 4 && imp1b.skipped === 0,
    JSON.stringify(imp1b));
  record("★import 如实报告「日期解析不出来」的条数（不静默丢）",
    imp1b?.dateUnparsed === 2,
    `dateUnparsed=${imp1b?.dateUnparsed}（「周三」与「2026年10月7日」都解析不了）`);
  record("★诊断留痕：paper 的 examDate 默认格式「2026年10月7日」当前**解析不了**",
    imp1b?.dateUnparsed >= 1, "阶段3 迁移时必须处理（可先归一化再导入）");

  const imp2 = await studentsPost({ op: "import", items: importItems });
  const imp2b = await imp2.json().catch(() => null);
  record("★import 第二次（同一批数据）：插入 0 条、跳过 4 条 —— **幂等**",
    imp2b?.ok === true && imp2b.inserted === 0 && imp2b.skipped === 4, JSON.stringify(imp2b));

  // 库里行数确实没变（用业务键数一遍）
  // ⚠️ 括号别省：`await fetch(x).then(...)` 会被解析成 `await (fetch(x).then(...))` 之外的东西，
  //    实际报 "(intermediate value).then is not a function"（因为 await 只作用于 fetch 的结果）。
  const histCountResp = await fetch(
    `${SUPABASE_URL}/rest/v1/feedback_history?student_name=eq.${encodeURIComponent(MERGE)}&select=id`,
    { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  const histCount = histCountResp.headers.get("content-range");
  record("★import 幂等：库里该学生的记录数没有翻倍", /\/4$/.test(histCount || ""),
    `content-range=${histCount}（期望 */4，与第一次插入的 4 条一致）`);

  // 同一批内部重复也算跳过
  const imp3 = await studentsPost({ op: "import", items: [importItems[0], importItems[0]] });
  const imp3b = await imp3.json().catch(() => null);
  record("import 同批内部重复 → 只算一次（0 插入 / 2 跳过）",
    imp3b?.inserted === 0 && imp3b?.skipped === 2, JSON.stringify(imp3b));

  // 日期确实按 feedback 的解析器存进去了
  const histAfter = await (await studentsApi(`?name=${encodeURIComponent(MERGE)}&withHistory=1`)).json().catch(() => null);
  const myHist = histAfter?.history?.[MERGE] || [];
  record("import 进来的记录 date 走同一套解析（10月7日 / 10-20 → 显示格式）",
    myHist.some((h) => h.date === "10月7日") && myHist.some((h) => h.date === "10月20日"),
    `日期=[${myHist.map((h) => h.date).join(", ")}]`);
  record("import 进来的记录带上了 paper 的分数与 tool 标记",
    myHist.some((h) => h.tool === "paper" && h.score === 86 && h.fullScore === 150),
    JSON.stringify(myHist[0] || {}).slice(0, 160));

  // 清理：两个账号的探针都删掉（B 端要单独删，跨账号删不到）
  await fetch(`${BASE}/api/students?name=${encodeURIComponent(MERGE)}`, { method: "DELETE", headers: { cookie } });
  await fetch(`${BASE}/api/students?name=${encodeURIComponent(MERGE)}`, { method: "DELETE", headers: { cookie: cookieB } });
  const goneA = await (await studentsApi(`?name=${encodeURIComponent(MERGE)}`)).json().catch(() => null);
  const goneB = await (await fetch(`${BASE}/api/students?name=${encodeURIComponent(MERGE)}`, { headers: { cookie: cookieB } })).json().catch(() => null);
  record("DELETE 两个账号的探针都被删掉（含其历史）",
    goneA?.student === null && goneB?.student === null,
    `A=${goneA?.student === null} B=${goneB?.student === null}`);

  // ---------------------------------------------------------------- 清理
  const del = async (q) => (await fetch(`${BASE}/api/feedback/data?${q}`, { method: "DELETE", headers: { cookie } })).status;
  await del("student=" + encodeURIComponent(PROBE.name));
  await del("student=" + encodeURIComponent(PROBE.name));
  await fetch(`${SUPABASE_URL}/rest/v1/feedback_history?student_name=eq.${encodeURIComponent(richName)}`, { method: "DELETE", headers: H });
  await fetch(`${SUPABASE_URL}/rest/v1/feedback_students?name=eq.${encodeURIComponent(richName)}`, { method: "DELETE", headers: H });
  const left = await (await fetch(`${SUPABASE_URL}/rest/v1/feedback_students?name=in.(${encodeURIComponent(PROBE.name)},${encodeURIComponent(richName)})&select=name`, { headers: H })).json();
  record("探针数据已清理（不留垃圾在线上）", Array.isArray(left) && left.length === 0,
    `剩余=${JSON.stringify(left)}`);
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
} finally {
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"],
    { encoding: "utf8" });
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
