/**
 * 课后反馈工具 · 数据接口的缓存效果与正确性验证
 *
 * 为什么要有这个文件（用户明确要求）：
 *   「缓存」这种东西最容易出的错**不是慢，而是静默变空** —— tools 表那次用
 *   `unstable_cache` 就是这样：页面不报错、只是什么都没有，肉眼完全看不出来。
 *   所以本文件除了数「省了几次出网」，**必须**断言「缓存命中时数据不为空」。
 *
 * 指标口径（照 docs/perf-notes.md）：**看调用次数，不看毫秒**。
 * 本机到 Supabase 延迟低，绝对耗时没有代表性；次数 × 用户环境的单次成本才是真实体感。
 *
 * 前置：先 `pnpm build`（本测试跑在 next start 上）。
 * 跑法：
 *   & "<bundled node>" tests\feedback-data-cache.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder } from "./_helpers.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN =
  "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const INSTRUMENT = `${PROJECT}\\tests\\_instrument.cjs`;
const COUNTER = "http://127.0.0.1:4599";
const BASE = "http://127.0.0.1:3000";

const { record, summary } = makeRecorder();

// ---------------------------------------------------------------- 计数器
async function counter(pathname) {
  const r = await fetch(COUNTER + pathname, { method: pathname === "/stats" ? "GET" : "POST" });
  return pathname === "/stats" ? r.json() : r.text();
}
const resetCounter = () => counter("/reset");
const stats = () => counter("/stats");

// ---------------------------------------------------------------- 登录
/** 用邮箱密码换一个真会话，并按 @supabase/ssr 的 cookie 格式塞进请求头 */
async function loginCookie(email, password) {
  const { SUPABASE_URL, ANON_KEY } = readEnv();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const session = await res.json();
  if (!res.ok || !session.access_token) {
    throw new Error("登录取会话失败: " + JSON.stringify(session).slice(0, 300));
  }
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  const chunks = [];
  for (let i = 0; i * 3180 < value.length; i++) chunks.push(value.slice(i * 3180, (i + 1) * 3180));
  return chunks.map((c, i) => `${name}${chunks.length > 1 ? "." + i : ""}=${c}`).join("; ");
}

/** 带会话请求数据接口，同时报出这次请求打了几次 Supabase */
async function getData(cookie, query) {
  await resetCounter();
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/feedback/data?${query}`, { headers: { cookie } });
  const ms = Math.round(performance.now() - t0);
  const body = await res.json().catch(() => null);
  const stat = await stats();
  return {
    status: res.status,
    body,
    ms,
    calls: stat.total,
    byTable: stat.byTable,
    keys: Object.keys(stat.byTable).sort(),
  };
}

function describe(calls) {
  return `${calls.calls} 次出网 [${calls.keys
    .map((k) => `${k}×${calls.byTable[k]}`)
    .join(", ")}]`;
}

// ---------------------------------------------------------------- 主流程
let srv = null;
try {
  // 先确保 3000 端口干净
  const pid = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess",
    ],
    { encoding: "utf8" },
  ).stdout.trim();
  if (pid) {
    spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], {
      encoding: "utf8",
    });
    await sleep(1500);
  }

  srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], {
    cwd: PROJECT,
    stdio: "ignore",
    env: { ...process.env, NODE_OPTIONS: `--require=${INSTRUMENT}` },
  });

  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      if ((await fetch(`${BASE}/login`)).status === 200) {
        up = true;
        break;
      }
    } catch {
      /* 继续等 */
    }
  }
  if (!up) throw new Error("next start 没起来（先跑 pnpm build）");

  // 计数器没起来的话，后面所有次数都不可信，直接失败
  let counterUp = false;
  for (let i = 0; i < 20; i++) {
    try {
      await stats();
      counterUp = true;
      break;
    } catch {
      await sleep(300);
    }
  }
  record("插桩端口可用（否则次数不可信）", counterUp);
  if (!counterUp) throw new Error("插桩端口 4599 不可用");

  const { adminEmail, password } = readUsers(); // rolea = 免费版
  const cookie = await loginCookie(adminEmail, password);
  const SCOPE = "stage=senior&subject=math";

  // ---------- 1. 第一次请求（缓存全冷） ----------
  const first = await getData(cookie, SCOPE);
  record("第一次请求返回 200", first.status === 200, `status=${first.status}`);
  record("第一次请求：分类/教材/短语都不为空", 
    Array.isArray(first.body?.categories) && first.body.categories.length > 0 &&
    Array.isArray(first.body?.textbooks) && first.body.textbooks.length > 0 &&
    Array.isArray(first.body?.phrases) && first.body.phrases.length > 0,
    `分类${first.body?.categories?.length} / 教材${first.body?.textbooks?.length} / 短语${first.body?.phrases?.length}`);
  console.log(`   冷请求：${describe(first)}`);

  // ---------- 2. 第二次请求（应当命中缓存） ----------
  const second = await getData(cookie, SCOPE);
  console.log(`   热请求：${describe(second)}`);
  console.log(`   冷请求明细：${JSON.stringify(first.byTable)}`);

  // ★ 用户特别要求的一条：缓存命中时数据不能变空
  record(
    "★缓存命中时数据不为空（防静默变空）",
    Array.isArray(second.body?.categories) &&
      second.body.categories.length > 0 &&
      Array.isArray(second.body?.textbooks) &&
      second.body.textbooks.length > 0 &&
      Array.isArray(second.body?.phrases) &&
      second.body.phrases.length > 0 &&
      Array.isArray(second.body?.textbooks[0]?.topics),
    `分类${second.body?.categories?.length} / 教材${second.body?.textbooks?.length} / 短语${second.body?.phrases?.length}`,
  );

  record(
    "★缓存命中时内容与冷请求完全一致",
    JSON.stringify(second.body) === JSON.stringify(first.body),
    `冷 ${JSON.stringify(first.body).length} 字节 / 热 ${JSON.stringify(second.body).length} 字节`,
  );

  record(
    "★静态表命中：分类/教材/章节/短语一次都不查",
    !second.keys.some((k) => /feedback_(categories|textbooks|chapters|phrases)/.test(k)),
    `热请求打了 [${second.keys.join(", ")}]`,
  );

  record(
    "★按用户表命中：students/history 也不查",
    !second.keys.some((k) => /feedback_(students|history)/.test(k)),
    `热请求打了 [${second.keys.join(", ")}]`,
  );

  record(
    "省下的次数（冷 − 热）≥ 4",
    first.calls - second.calls >= 4,
    `${first.calls} → ${second.calls}（省 ${first.calls - second.calls} 次）`,
  );

  // 会员状态（user_roles）也进了 30 秒进程内缓存 —— 但**只能省掉页面侧那一次**。
  // 中间件（src/proxy.ts）不在 React 渲染树里，用不到这个缓存，它自己那次省不掉。
  // 所以正确的期望是：冷请求 2 次 → 热请求 1 次（中间件那一次），**不是 0 次**。
  record(
    "★会员状态命中：user_roles 从每次 2 次降到 1 次（剩下的是中间件那次，省不掉）",
    second.byTable["user_roles"] === 1,
    `冷 ${first.byTable["user_roles"]} 次 → 热 ${second.byTable["user_roles"]} 次；热请求打了 [${second.keys.join(", ")}]`,
  );

  // 每次请求的**理论下限**：中间件 auth.getUser + 中间件 user_roles
  //  + getViewer 的 auth.getUser（安全底线，必须实时校验会话，不能缓存）。
  // getViewer 的 user_roles 已经命中缓存 —— 所以是 3 次，不是原来的 4 次。
  record(
    "★热请求降到 3 次出网 = 安全底线（auth×2 + 中间件 user_roles×1）",
    second.calls === 3 && second.keys.every((k) => /^auth:/.test(k) || k === "user_roles"),
    `热请求 ${describe(second)}`,
  );

  // ---------- 耗时（只记录，不做精确断言的失败条件） ----------
  // ⚠️ 这里**故意不断言毫秒上限**（曾经写成「冷请求 < 3000ms」，结果实测 3004ms 假失败）。
  //    原因：本机到 Supabase 只有 ~90ms/次往返，绝对耗时受机器负载/冷启动噪声影响很大，
  //    而用户环境是 400–500ms/次 —— 本机的毫秒数**没有代表性**（docs/perf-notes.md 的原则：
  //    **看调用次数，不要看毫秒**）。
  //    所以：下面**只把毫秒打出来给人看**，真正拦住退化的是上面的**出网次数断言**。
  console.log(
    `   耗时参考（本机 ~90ms/次往返，不代表用户体感）：冷 ${first.ms}ms / 热 ${second.ms}ms`,
  );
  record(
    "冷请求出网次数没有退化（仍是 11 次，非耗时）",
    first.calls === 11,
    `${first.calls} 次`,
  );

  // ---------- 3. 换维度：教材表必须共享（章节/关键词天然按维度各一份） ----------
  //    背景：缓存 key 以前精确到「学段+科目+教材」，每换一个组合就是一次全新 miss ——
  //    这是「使用频率低的人每次都冷启动」的主因。
  //    现在：教材全表**只有一条 key**（1 条），章节/关键词按「学段|科目」各一条。
  //    所以验收标准是两条：
  //      ① 换任何维度，textbooks **一次都不该查**（它只有一条 key，冷请求时已填好）
  //      ② **第二次**进入同一个维度，feedback_* 全部为 0（章节/关键词那份已经在了）
  const scopeVisits = [
    ["stage=senior&subject=english", "高中/英语"],
    ["stage=junior&subject=math", "初中/数学"],
    ["stage=senior&subject=chemistry", "高中/化学"],
  ];
  for (const [q, label] of scopeVisits) {
    const r = await getData(cookie, q);
    record(
      `换维度「${label}」：教材表共享（不再各存一条）`,
      !r.keys.includes("feedback_textbooks") && r.status === 200,
      `${describe(r)}；教材${r.body?.textbooks?.length} 本`,
    );
  }

  // 第二次进同一个维度 —— 章节/关键词也该全命中
  for (const [q, label] of scopeVisits) {
    const r = await getData(cookie, q);
    record(
      `★再次进入「${label}」：静态表全部命中（这才是「用过的组合不再冷」）`,
      !r.keys.some((k) => /^feedback_/.test(k)) && (r.body?.chapterKeywordCount ?? 0) >= 0,
      describe(r),
    );
  }

  // ---------- 4. 同一科目内换教材：章节按「学段|科目」共享，不再各存一条 ----------
  const books = first.body?.textbooks ?? [];
  if (books.length >= 2) {
    await getData(cookie, `${SCOPE}&textbook=${books[0].id}`); // 预热该科目章节
    const other = await getData(cookie, `${SCOPE}&textbook=${books[1].id}`);
    record(
      "★同一科目内换教材：章节也不查库（按科目共享章节缓存）",
      !other.keys.includes("feedback_chapters") && (other.body?.chapters?.length ?? 0) > 0,
      `${describe(other)}；该教材章节 ${other.body?.chapters?.length} 个`,
    );
  }

  // ---------- 5. 写入后必须立即可见（失效逻辑的对拍） ----------
  //    故意用「读 → 写 → 再读」的往返：如果写完没清缓存，第三次读会拿到旧数据而失败。
  const probe = `缓存验证学生-${Date.now()}`;
  const post = async (payload) => {
    await resetCounter();
    const res = await fetch(`${BASE}/api/feedback/data`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  await getData(cookie, SCOPE); // 先让档案缓存处于「已缓存」状态
  const created = await post({ op: "student", name: probe, subject: "math" });
  record("存一条测试档案成功", created.status === 200 && created.body?.ok === true, `status=${created.status}`);

  const afterCreate = await getData(cookie, SCOPE);
  record(
    "★刚存的档案立刻能看到（写完已清缓存）",
    Object.prototype.hasOwnProperty.call(afterCreate.body?.students ?? {}, probe),
    `students 里 ${Object.keys(afterCreate.body?.students ?? {}).length} 条`,
  );

  // 清理：删掉这条测试档案，并验证「删掉后立刻看不到」
  await resetCounter();
  const del = await fetch(`${BASE}/api/feedback/data?id=${created.body?.student?.id}`, {
    method: "DELETE",
    headers: { cookie },
  });
  // 上面这个 id 是档案 id，DELETE?id= 删的是历史；档案要用 student=姓名
  const del2 = await fetch(`${BASE}/api/feedback/data?student=${encodeURIComponent(probe)}`, {
    method: "DELETE",
    headers: { cookie },
  });
  record("清理测试档案成功", del.status === 200 && del2.status === 200, `历史分支${del.status} / 档案分支${del2.status}`);
  const afterDelete = await getData(cookie, SCOPE);
  record(
    "★删掉的档案立刻消失（删完已清缓存）",
    !Object.prototype.hasOwnProperty.call(afterDelete.body?.students ?? {}, probe),
    `students 里 ${Object.keys(afterDelete.body?.students ?? {}).length} 条`,
  );
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
} finally {
  if (srv?.pid) {
    spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], {
      encoding: "utf8",
    });
  }
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
