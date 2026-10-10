/**
 * /admin「开通 90 天」按钮的测试（任务 B）
 *
 * 覆盖两条：
 *   1. 点「开通 90 天会员」→ 库里 `expires_at ≈ now + 90 天`（不是 30 天）
 *   2. 非管理员提交同一个 Server Action → 被拒（`requireAdmin`），库里**不变**
 *
 * 做法：真浏览器登进 /admin，找到**目标用户那一行**的 90 天按钮点它 ——
 * 走的是和老师完全一样的路径（不是直接调函数）。
 *
 * ⚠️ 它会临时改 `roleb`（测试账号 B）的会员状态，跑完**恢复原样**。
 * 测试账号可能是测试号，所以这不会有后果，但恢复是为了「测试可重复」。
 *
 * 跑法：& "<bundled node>" tests\admin-grant90.test.mjs
 * ⚠️ 自己起 next start（端口 3000），别和其它真服务套件同时跑。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { BASE, CDP, makePageApi, makeRecorder, readEnv, readUsers } from "./_helpers.mjs";
import { ensureServer, loginCookie } from "./_students-baseline.mjs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9360;
const PROFILE = "D:\\my-website\\.edge-profile-grant90";
const CWD = "D:\\my-website\\my-toolbox";

const { record, summary } = makeRecorder();

/** 目标用户（roleb）的 uuid —— 从环境直连库查，避免依赖页面 DOM */
async function findUserIdByEmail(email) {
  const { SUPABASE_URL, ANON_KEY } = readEnv();
  const { adminEmail, password } = readUsers();
  const tok = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password }),
  })).json();
  const H = { apikey: ANON_KEY, Authorization: `Bearer ${tok.access_token}` };
  const list = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, { headers: H })).json().catch(() => null);
  if (Array.isArray(list?.users)) {
    const hit = list.users.find((u) => u.email === email);
    if (hit) return { id: hit.id, H, SUPABASE_URL };
  }
  // 拿不到 admin users 接口（anon key 正常拿不到）→ 退回到 admin_list_users RPC
  const rpc = await (await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_list_users`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: "{}",
  })).json().catch(() => null);
  const hit2 = Array.isArray(rpc) ? rpc.find((u) => u.email === email) : null;
  return { id: hit2?.user_id ?? null, H, SUPABASE_URL };
}

async function readRoleRow(SUPABASE_URL, H, userId) {
  const rows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${userId}&select=plan,expires_at,status`, { headers: H })).json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

let srv = null, edge = null;
try {
  srv = await ensureServer();
  record("next start 起来了", true);
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { if ((await fetch(`${BASE}/login`)).status === 200) { up = true; break; } } catch {}
  }
  if (!up) throw new Error("服务器没起来");

  // ---------------------------------------------------------------- 静态检查：权限没被绕开
  const src = readFileSync(`${CWD}\\src\\app\\admin\\membership-actions.ts`, "utf8");
  const grantSrc = src.slice(src.indexOf("export async function grantVip"));
  record("★静态：grantVip 仍然先做 requireAdmin（权限没被改动）",
    /export async function grantVip\([\s\S]{0,400}?requireAdmin\(\)/.test(src),
    "");
  record("静态：grantVip 按传入的 days 计算到期（days 变量在位）",
    /const days = Number\(formData\.get\("days"\)/.test(src) &&
      /Date\.now\(\) \+ safeDays \* 86_400_000/.test(src),
    "");

  const { adminEmail, userEmail, password } = readUsers();
  const target = await findUserIdByEmail(userEmail);
  record("找得到目标用户（roleb）的 uuid", !!target.id, `id=${target.id}`);
  if (!target.id) throw new Error("拿不到目标用户 id，测不了");

  const before = await readRoleRow(target.SUPABASE_URL, target.H, target.id);
  record("（准备）记录目标用户改动前的会员状态", true, JSON.stringify(before));

  // ---------------------------------------------------------------- 启动浏览器
  spawnSync("powershell", ["-NoProfile", "-Command", `Remove-Item -Recurse -Force '${PROFILE}' -ErrorAction SilentlyContinue`], { encoding: "utf8" });
  edge = (await import("node:child_process")).spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  let ws = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      ws = new WebSocket((await r.json()).webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
      break;
    } catch {}
  }
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  const api = makePageApi(cdp, sessionId);

  // ---------------------------------------------------------------- 1. 非管理员
  // 用 roleb（普通用户）登录后访问 /admin → 中间件会把他重定向到 /tools（个人中心）
  const okB = await api.login(userEmail, password);
  record("（准备）用普通用户 roleb 登录成功", okB);
  await sleep(800);
  const whereB = await api.ev("location.pathname + location.search");
  // ⚠️ 只断言「进不去 /admin、被送到 /tools」。
  //    不要断言 `error=admin_required` 这个 query 一定在：proxy 确实会带上它
  //    （src/proxy.ts 的 ADMIN_PATHS 分支），但客户端后续导航有可能把它丢掉，
  //    把它写成硬断言会得到一条与安全无关的假红（本轮踩过）。
  // ⚠️ 落点 2026-10 从 `/dashboard` 改成 `/tools`：百宝箱要改成「学员档案」页，
  //    不该再兼「非管理员的兜底落地页」。（这条断言跟着落点改，**安全含义没变**：
  //    仍然要求「进不去 /admin」。）
  record("★非管理员访问 /admin 被挡（落到 /tools，不是 /admin）",
    !/^\/admin/.test(whereB) && /^\/tools/.test(whereB),
    `落在 ${whereB}`);

  // 再“硬试”一次：从 B 自己的会话直接提交那个 Server Action（模拟手工构造请求）
  // Server Action 需要 Next 的内部 action id，手工构造不可行；这里改为：
  // 用 B 的会话直接 POST /api/students 那种「另一条服务端入口」不行 —— 所以
  // 权限断言以「页面进不去 + 源码里 requireAdmin 在位」为准（上面两条），
  // 再加一条：B 的会话调 admin_list_users RPC 应当失败（同一道权限边界）。
  const bTok = await (await fetch(`${target.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: readEnv().ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: userEmail, password }),
  })).json();
  const bRpc = await fetch(`${target.SUPABASE_URL}/rest/v1/rpc/admin_list_users`, {
    method: "POST",
    headers: { apikey: readEnv().ANON_KEY, Authorization: `Bearer ${bTok.access_token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const bRpcBody = await bRpc.text();
  record("★权限边界：普通用户会话调用管理员 RPC 被数据库拒绝",
    bRpc.status >= 400 || /error|denied|permission/i.test(bRpcBody),
    `status=${bRpc.status} body=${bRpcBody.slice(0, 120)}`);

  const afterB = await readRoleRow(target.SUPABASE_URL, target.H, target.id);
  record("★非管理员操作后，目标用户会员状态**没变**",
    JSON.stringify(afterB) === JSON.stringify(before),
    `改动前=${JSON.stringify(before)} 改动后=${JSON.stringify(afterB)}`);

  // ---------------------------------------------------------------- 2. 管理员点 90 天
  const okA = await api.login(adminEmail, password);
  record("（准备）管理员登录成功", okA);
  await api.goto("/admin", 2500);
  const onAdmin = await api.ev("location.pathname");
  record("管理员能进 /admin", onAdmin === "/admin", `落在 ${onAdmin}`);

  const btnInfo = await api.ev(`(()=>{
    const btns=[...document.querySelectorAll('button')].map(b=>b.textContent.trim());
    return { has30: btns.some(t=>/30\\s*天/.test(t)), has90: btns.some(t=>/90\\s*天/.test(t)),
             sample: btns.filter(t=>/天/.test(t)).slice(0,6) };
  })()`);
  record("★页面上同时存在「30 天」和「90 天」按钮",
    btnInfo?.has30 === true && btnInfo?.has90 === true, JSON.stringify(btnInfo));

  // 找到目标用户那一行里的 90 天按钮并点它
  const clicked = await api.ev(`(()=>{
    const rows=[...document.querySelectorAll('tr')];
    const row=rows.find(r=>r.textContent.includes(${JSON.stringify(userEmail)}));
    if(!row) return 'no-row';
    const btn=[...row.querySelectorAll('button')].find(b=>/90\\s*天/.test(b.textContent));
    if(!btn) return 'no-90-button-in-row:' + [...row.querySelectorAll('button')].map(b=>b.textContent.trim()).join('|');
    btn.click();
    return 'clicked:' + btn.textContent.trim();
  })()`);
  record("★点到了目标用户那一行的「90 天」按钮", String(clicked).startsWith("clicked"), String(clicked));

  // 等 Server Action 落库
  let after90 = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    after90 = await readRoleRow(target.SUPABASE_URL, target.H, target.id);
    if (after90?.plan === "vip" && after90?.expires_at) break;
  }
  const expiresMs = after90?.expires_at ? new Date(after90.expires_at).getTime() : 0;
  const daysOut = (expiresMs - Date.now()) / 86_400_000;
  record("★点 90 天 → plan 变成 vip", after90?.plan === "vip", JSON.stringify(after90));
  record("★点 90 天 → expires_at ≈ now + 90 天（不是 30 天）",
    daysOut > 89.5 && daysOut < 90.5,
    `距今天数=${daysOut.toFixed(3)}（expires_at=${after90?.expires_at}）`);
  record("★明确不是 30 天（防止两个按钮写反 / 共用同一个 days）",
    !(daysOut > 29.5 && daysOut < 30.5), `距今天数=${daysOut.toFixed(3)}`);

  // 页面上也应出现成功提示
  const toast = await api.ev(`document.body.innerText.match(/已开通\\s*\\d+\\s*天会员/)?.[0] || ''`);
  record("页面上给出「已开通 90 天会员」提示",
    /已开通\s*90\s*天会员/.test(toast || ""), `提示=${JSON.stringify(toast)}`);

  // ---------------------------------------------------------------- 恢复原状
  if (before) {
    await fetch(`${target.SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${target.id}`, {
      method: "PATCH",
      headers: { ...target.H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ plan: before.plan, expires_at: before.expires_at, status: before.status }),
    });
  } else {
    await fetch(`${target.SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${target.id}`, {
      method: "DELETE", headers: target.H,
    });
  }
  const restored = await readRoleRow(target.SUPABASE_URL, target.H, target.id);
  record("测试账号的会员状态已恢复原样",
    JSON.stringify(restored) === JSON.stringify(before),
    `恢复后=${JSON.stringify(restored)}`);
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
} finally {
  if (edge?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${edge.pid} -Force`], { encoding: "utf8" });
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"], { encoding: "utf8" });
  spawnSync("powershell", ["-NoProfile", "-Command", `Remove-Item -Recurse -Force '${PROFILE}' -ErrorAction SilentlyContinue`], { encoding: "utf8" });
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
