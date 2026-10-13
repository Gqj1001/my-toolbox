#!/usr/bin/env node
/**
 * 功能开关（管理后台）+ 服务端拼参数 —— 测试
 * ==========================================================================
 * 测什么：
 *  ① 管理后台的「功能开关」区块在（管理员能看、非管理员看不到）
 *  ② **迁移没跑时**：明确提示"表还没建 + 要跑哪个迁移"，而且**所有功能保持开启**（不许悄悄关掉）
 *  ③ **迁移跑过之后**：后台点「关掉」→ 工具页 iframe 的 src 带上 `nocompanyexport=1`
 *     → iframe 里面板消失；再点「打开」→ 恢复
 *  ④ 非管理员改不动（Server Action 里 requireAdmin()）
 *
 * ⚠️ 本套件**自动适配两种状态**（`feature_flags` 表在不在）：
 *    · 没建表 → 走分支 A（断言"保持开启 + 明确提示"）
 *    · 建了表 → 走分支 B（断言开关真的能关掉/打开）
 *    跑完 `supabase/migrations/0018_feature_flags.sql` 之后，本套件会自动开始测"切换"。
 *
 * ⚠️ 自己起 `next start`（会杀 3000 端口），别和其它真服务套件并行跑。
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder, startBrowser, makePageApi } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const BASE = "http://127.0.0.1:3000";
const CDP_PORT = 9496;
const MIGRATION = "0018_feature_flags.sql";

const { record, summary } = makeRecorder();
const { adminEmail, userEmail, password } = readUsers();   // rolea=免费/管理员 · roleb=VIP/非管理员
readEnv();

const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const killPort3000 = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
};

killPort3000();
await sleep(1500);
const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], { cwd: PROJECT, stdio: "ignore", env: { ...process.env } });
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { if ((await fetch(`${BASE}/login`)).status === 200) break; } catch { /* 等 */ }
}
record("（准备）本地服务已起来", (await fetch(`${BASE}/login`)).status === 200);

const adminCookie = await loginCookie(adminEmail, password);
const vipCookie = await loginCookie(userEmail, password);
record("（准备）管理员与普通会员两个会话都拿到", !!adminCookie && !!vipCookie);

const getHtml = async (path, cookie) => {
  const r = await fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
  return { status: r.status, location: r.headers.get("location"), html: await r.text() };
};

let edge = null;
try {
  /* ======================================================================
     1. 后台页：谁能看
     ====================================================================== */
  const asAdmin = await getHtml("/admin", adminCookie);
  record("① 管理员能打开 /admin（HTTP 200）", asAdmin.status === 200, `HTTP ${asAdmin.status}`);
  record("① 后台页有「功能开关」区块 + 登记的开关（company_export）",
    /功能开关/.test(asAdmin.html) && /company_export/.test(asAdmin.html) &&
      /公司模板导出/.test(asAdmin.html),
    `含功能开关=${/功能开关/.test(asAdmin.html)} 含 company_export=${/company_export/.test(asAdmin.html)}`);

  const asVip = await getHtml("/admin", vipCookie);
  const denied = asVip.status !== 200 || /没有访问权限/.test(asVip.html) || (asVip.location ?? "").length > 0;
  record("④ 非管理员打不开后台（跳走或明确拒绝）", denied,
    `HTTP ${asVip.status} location=${asVip.location ?? "-"}`);

  /* ======================================================================
     2. 现在处于哪种状态：feature_flags 表建了没
     ====================================================================== */
  const ready = /data-flags-ready="1"/.test(asAdmin.html);
  const notReady = /data-flags-ready="0"/.test(asAdmin.html);
  record("② 后台明确标出开关表的状态（ready=1 / ready=0 二者之一）", ready || notReady,
    `ready=${ready} notReady=${notReady}`);
  console.log(ready
    ? "     → 检测到 feature_flags 表**已建**：走分支 B（测「关掉/打开」真的生效）"
    : "     → 检测到 feature_flags 表**还没建**：走分支 A（测「保持开启 + 明确提示」）；" +
      `跑完 ${MIGRATION} 后本套件会自动改测分支 B`);

  /* ======================================================================
     3. 工具页：iframe 的 src 有没有被拼上关闭参数
     ====================================================================== */
  const toolPage = await getHtml("/tools/paper-analysis", adminCookie);
  const hasParam = /nocompanyexport=1/.test(toolPage.html);
  record("③ 工具页（/tools/paper-analysis）能打开且含 iframe",
    toolPage.status === 200 && /iframe/i.test(toolPage.html), `HTTP ${toolPage.status}`);

  if (!ready) {
    /* ---------------- 分支 A：迁移还没跑 ---------------- */
    record(`② 表没建时后台明确说要跑哪个迁移（点名 ${MIGRATION}）`,
      new RegExp(MIGRATION).test(asAdmin.html),
      `含 ${MIGRATION}=${new RegExp(MIGRATION).test(asAdmin.html)}`);
    record("② 读不到开关表时**功能保持开启**：iframe src 里没有关闭参数",
      hasParam === false, `含 nocompanyexport=${hasParam}`);
    record("② 开关区显示的仍是「已开启」（默认值，而不是被关掉）",
      /data-flag="company_export" data-flag-enabled="1"/.test(asAdmin.html),
      /data-flag-enabled="1"/.test(asAdmin.html) ? "enabled=1" : "enabled≠1");
  } else {
    /* ---------------- 分支 B：表在，测真的能关掉 ---------------- */
    record("③ 默认（开着）时 iframe src **不带**关闭参数", hasParam === false,
      `含 nocompanyexport=${hasParam}`);
    record("③ 后台显示 company_export 为「已开启」",
      /data-flag="company_export" data-flag-enabled="1"/.test(asAdmin.html), "enabled=1");

    const b = await startBrowser(CDP_PORT, "D:/my-website/.edge-profile-flags");
    edge = b.edge;
    const { cdp, sessionId } = b;
    const { ev, goto, inTool, login } = makePageApi(cdp, sessionId);
    const pageErrors = [];
    cdp.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        pageErrors.push(`${String(d?.text)} ${String(d?.exception?.description ?? "").slice(0, 140)}`);
      }
    });

    record("（准备）管理员在浏览器里登录", await login(adminEmail, password));
    await goto("/admin", 4000);

    // 点「关掉这个功能」（Server Action）
    const clicked = await ev(`(() => {
      const row = document.querySelector('[data-flag="company_export"]');
      if (!row) return { err: '后台没有这行开关' };
      const btn = row.querySelector('button[type="submit"]');
      if (!btn) return { err: '没有按钮' };
      const label = btn.textContent.trim();
      btn.click();
      return { label };
    })()`);
    record("③ 后台能点到「关掉这个功能」按钮", !clicked?.err, clicked?.err || clicked?.label);
    await sleep(3000);
    const afterToggle = await ev(`(() => {
      const row = document.querySelector('[data-flag="company_export"]');
      return { enabled: row ? row.getAttribute('data-flag-enabled') : null,
               text: row ? row.innerText.replace(/\\s+/g, ' ').slice(0, 120) : null };
    })()`);
    record("③ 关掉后后台显示「已关闭」（库里真的改了）",
      afterToggle?.enabled === "0", JSON.stringify(afterToggle));

    // 工具页：iframe src 应带上参数 + iframe 里面板消失
    await goto("/tools/paper-analysis", 4500);
    const srcNow = await ev(`(() => { const f = document.querySelector('iframe'); return f ? f.getAttribute('src') : null; })()`);
    record("③ 工具页 iframe 的 src 被拼上 `nocompanyexport=1`（服务端拼参数，工具页代码没改）",
      /nocompanyexport=1/.test(String(srcNow ?? "")), JSON.stringify(srcNow));
    const panelState = await inTool(`
      const p = w.document.getElementById('companyPanel');
      return { disabled: w.CompanyExportHooks ? w.CompanyExportHooks.disabled() : null,
               visible: !!p && p.style.display !== 'none' && !p.hasAttribute('hidden') };
    `);
    record("③ 关掉后「🏢 公司模板导出」面板在工具页里**消失**",
      panelState?.disabled === true && panelState?.visible === false, JSON.stringify(panelState));
    record("③ 关掉后**其它功能照常**（旧导出按钮、报告框还在）",
      (await inTool(`return { a: !!w.document.getElementById('btnDocx'), b: !!w.document.getElementById('reportText') };`))
        ?.a === true, "btnDocx/reportText 都在");

    // 开回来
    await goto("/admin", 4000);
    await ev(`(() => {
      const row = document.querySelector('[data-flag="company_export"]');
      const btn = row && row.querySelector('button[type="submit"]');
      if (btn) btn.click();
      return btn ? btn.textContent.trim() : 'no-btn';
    })()`);
    await sleep(3000);
    const restored = await getHtml("/admin", adminCookie);
    record("③ 再点一次能**打开**（状态回到已开启）",
      /data-flag="company_export" data-flag-enabled="1"/.test(restored.html), "enabled=1");
    await goto("/tools/paper-analysis", 4500);
    const srcBack = await ev(`(() => { const f = document.querySelector('iframe'); return f ? f.getAttribute('src') : null; })()`);
    record("③ 打开后 iframe src 不再带参数，面板恢复可见",
      !/nocompanyexport=1/.test(String(srcBack ?? "")), JSON.stringify(srcBack));

    record("页面无真实 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ") || "0 条");
    try { await cdp.send("Browser.close"); } catch { /* ignore */ }
  }
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
  console.error(e?.stack ?? e);
} finally {
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  killPort3000();
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
