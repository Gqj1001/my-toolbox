#!/usr/bin/env node
/**
 * 忘记密码 / 修改密码（2026-10 第十五批）—— 测试
 * ==========================================================================
 * 测什么（四段）：
 *   一、**纯函数**密码规则（`src/lib/password-policy.ts`）—— 不用起服务，秒级跑完；
 *   二、**公开页**：`/forgot-password` 未登录就能打开（忘了密码的人恰恰是登不进来的人），
 *       而 `/reset-password`、`/account/password` **未登录必须被挡**；
 *   三、**结构契约**：表单字段名/长度限制/隐藏的"重置流程"标记/中文文案锚点；
 *       外加两条"不许出现第二个来源"的静态契约（报错翻译只有一份、
 *       `"use server"` 文件里不许有同步 export）；
 *   四、**真浏览器**：登录后到 `/account/password`，**空着当前密码提交** ——
 *       页面必须给出"两个密码框都填上"的提示，且**一次网络写请求都没发生**
 *       （证明校验发生在动作的第一道，而不是打完 Supabase 才报错）。
 *
 * ⚠️ 本套**故意不做"真改一次密码"**的破坏性验证：那要动共享测试账号的密码，
 *    万一中途失败会把账号留在未知密码上，后续所有套件一起红。
 *    真正的"改密码成功"由用户在页面上点一次确认（见 docs/password-reset-plan.md §5）。
 *
 * ⚠️ 自己起 `next start`（会杀 3000 端口），别和其它真服务套件并行跑。
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { readEnv, readUsers, makeRecorder, startBrowser, makePageApi } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const BASE = "http://127.0.0.1:3000";
const CDP_PORT = 9498;

const { record, summary } = makeRecorder();
const { adminEmail, password } = readUsers();
readEnv();

/* ---------------------------------------------------------------------------
   一、纯函数：密码规则
   ---------------------------------------------------------------------------
   ⚠️ 与 `student-report.test.mjs` 同一个做法：先静音 warning，再动态 import `.ts`。 */
process.removeAllListeners("warning");
process.on("warning", () => { /* 有意静音：MODULE_TYPELESS_PACKAGE_JSON 会被误当成故障 */ });

const { checkNewPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } = await import(
  "../src/lib/password-policy.ts"
);

{
  record("① 空表单被拒（提示要两个框都填）",
    checkNewPassword({ password: "", confirm: "" }).ok === false &&
      /两个密码框/.test(checkNewPassword({ password: "", confirm: "" }).error),
    JSON.stringify(checkNewPassword({ password: "", confirm: "" })));

  record("① 太短被拒（下限与注册页一致）",
    checkNewPassword({ password: "12345", confirm: "12345" }).ok === false &&
      MIN_PASSWORD_LENGTH === 6,
    `MIN=${MIN_PASSWORD_LENGTH}`);

  record("① 两次不一致被拒",
    checkNewPassword({ password: "abcdef1", confirm: "abcdef2" }).ok === false &&
      /不一样/.test(checkNewPassword({ password: "abcdef1", confirm: "abcdef2" }).error));

  record("① 太长被拒（挡住整段粘贴）",
    checkNewPassword({ password: "a".repeat(MAX_PASSWORD_LENGTH + 1), confirm: "a".repeat(MAX_PASSWORD_LENGTH + 1) }).ok === false,
    `MAX=${MAX_PASSWORD_LENGTH}`);

  record("① 合法的新密码通过",
    checkNewPassword({ password: "abc123", confirm: "abc123" }).ok === true);

  record("★①「新密码不能和当前密码一样」（只在传了当前密码时才比）",
    checkNewPassword({ password: "abc123", confirm: "abc123", oldPassword: "abc123" }).ok === false &&
      /不能和当前密码一样/.test(checkNewPassword({ password: "abc123", confirm: "abc123", oldPassword: "abc123" }).error),
    "带 oldPassword → 拒");

  record("★① 重置流程（没有当前密码）不许被误判成「和当前密码一样」",
    checkNewPassword({ password: "abc123", confirm: "abc123", oldPassword: "" }).ok === true &&
      checkNewPassword({ password: "abc123", confirm: "abc123" }).ok === true,
    "oldPassword 为空 → 放行");
}

/* ---------------------------------------------------------------------------
   三、静态契约（不需要服务，先做完）
   --------------------------------------------------------------------------- */
{
  const errorsSrc = readFileSync("D:/my-website/my-toolbox/src/lib/auth-errors.ts", "utf8");
  const actionsSrc = readFileSync("D:/my-website/my-toolbox/src/app/auth/actions.ts", "utf8");
  const pwActionsSrc = readFileSync("D:/my-website/my-toolbox/src/app/auth/password-actions.ts", "utf8");

  record("★契约：报错中文翻译只有一份（住在 lib/auth-errors.ts，另两处都是 import）",
    /export function translateAuthError/.test(errorsSrc) &&
      /import \{ translateAuthError \} from "@\/lib\/auth-errors"/.test(actionsSrc) &&
      /import \{ translateAuthError \} from "@\/lib\/auth-errors"/.test(pwActionsSrc) &&
      !/export function translateAuthError/.test(actionsSrc),
    "唯一来源 OK");

  record("★契约：`use server` 文件里不许有同步 export（构建会直接报错）",
    // 该文件的每个 export 都必须是 `export async function`
    !/export\s+(?!async)(function|const|class)\s/.test(pwActionsSrc),
    "password-actions.ts 只导出 async");

  record("★契约：修改密码**必须先验当前密码**（用旧密码再登录一次，不依赖后台配置）",
    /signInWithPassword\(\{ email, password: oldPassword \}\)/.test(pwActionsSrc),
    "存在验旧密码那一步");

  record("★契约：重置流程跳过验旧密码，且会话过期时提示**重新申请重置邮件**",
    /isResetFlow/.test(pwActionsSrc) &&
      /if \(!isResetFlow\) \{/.test(pwActionsSrc) &&
      /重置链接已过期或无效，请重新申请一封重置邮件/.test(pwActionsSrc),
    "isResetFlow 分支 OK");

  // ⚠️ 这条是**变异测试逼出来的**：第一版我只测了纯函数 `checkNewPassword`（空 oldPassword → 放行），
  //    于是把动作里那句"重置流程不传 oldPassword"改回"总是传"时，**31/31 全绿** =
  //    那条断言根本没守住这个行为。现在直接对**动作的源码**下契约。
  record("★契约：动作在「主动改密码」时**必须把 oldPassword 交给校验**，重置流程才不传",
    /isResetFlow \? \{ password, confirm \} : \{ password, confirm, oldPassword \}/.test(pwActionsSrc),
    "三参数分支 OK");

  record("★契约：重置邮件回到 /auth/confirm 并带上 next=/reset-password",
    /redirectTo: `\$\{origin\}\/auth\/confirm\?next=\/reset-password`/.test(pwActionsSrc),
    "redirectTo OK");

  const resetFormSrc = readFileSync("D:/my-website/my-toolbox/src/components/reset-password-form.tsx", "utf8");
  record("★契约：重置页表单带 `reset=1` 隐藏字段（服务端据此跳过验旧密码）",
    /name="reset"\s+value="1"/.test(resetFormSrc),
    "隐藏字段在");

  /* ------------------------------------------------------------------------
     ⚠️ 本节是**第十六批修的 bug 的防回归**（用户实测报的）：
     症状：点邮件里的重置链接 → 落到**登录界面**，根本没法重置密码。
     根因：Supabase 现在把会话放在跳转地址的 **`#` 片段**里
          （`…/auth/confirm?next=/reset-password#access_token=…`），而 `#` **不发给服务器**；
          原来那个"服务端路由 /auth/confirm"只读 `?token_hash=` ⇒ 永远读不到会话 ⇒ 跳登录页。
     修法：换成**客户端**回调页（浏览器能读 `#`，并且浏览器端 client 会把会话落成 Cookie）。
     ⇒ 这里用静态契约钉住"回调页确实是客户端在干活"，真行为由下面的真浏览器那一段验。
     ------------------------------------------------------------------------ */
  const confirmPageSrc = readFileSync("D:/my-website/my-toolbox/src/app/auth/confirm/page.tsx", "utf8");
  const confirmClientSrc = readFileSync("D:/my-website/my-toolbox/src/components/auth-confirm-client.tsx", "utf8");
  const callbackLibSrc = readFileSync("D:/my-website/my-toolbox/src/lib/auth-callback.ts", "utf8");
  let oldRouteExists = true;
  try { readFileSync("D:/my-website/my-toolbox/src/app/auth/confirm/route.ts", "utf8"); } catch { oldRouteExists = false; }

  record("★契约：/auth/confirm 是**客户端**回调（旧的只会读 ?token_hash 的服务端路由已删除）",
    /AuthConfirmClient/.test(confirmPageSrc) && oldRouteExists === false,
    `page=客户端 old-route.ts 存在=${oldRouteExists}`);

  record("★契约：回调必须读 **URL 片段**（hash）并把会话写进 Cookie（setSession / exchangeCodeForSession / verifyOtp 三条都要在）",
    /location\.hash/.test(confirmClientSrc) &&
      /setSession\(/.test(confirmClientSrc) &&
      /exchangeCodeForSession\(/.test(confirmClientSrc) &&
      /verifyOtp\(/.test(confirmClientSrc) &&
      /createClient\(\)/.test(confirmClientSrc),
    "hash + 三条换会话路径都在");

  record("★契约：链接失效/过期时给出**中文出路**（别甩上游错误原文、别停在空白页）",
    /已失效|已过期|无效或已经用过/.test(callbackLibSrc) &&
      /重新申请一封重置邮件/.test(callbackLibSrc) &&
      /error_code/.test(callbackLibSrc),
    "错误分支有中文提示");

  // eslint-disable-next-line no-new-func
  const { parseAuthCallback, hasSessionPayload, authCallbackMessage, safeNextPath } =
    await import("../src/lib/auth-callback.ts");

  record("① 解析：片段的会话 + 查询串的 next 都要拿到（这正是被修的那个形状）",
    (() => {
      const url = "https://010034.xyz/auth/confirm?next=/reset-password#access_token=AT&refresh_token=RT&type=recovery";
      const p = parseAuthCallback(url, "#access_token=AT&refresh_token=RT&type=recovery");
      return p.accessToken === "AT" && p.refreshToken === "RT" && p.type === "recovery" &&
        p.next === "/reset-password" && hasSessionPayload(p) === true;
    })(),
    "片段 + 查询串都解析出来了");

  record("① 解析：`#error=access_denied&error_code=otp_expired` → 判为失败并说清「重新申请」",
    (() => {
      const hash = "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid";
      const p = parseAuthCallback("https://010034.xyz/auth/confirm?next=/reset-password", hash);
      const m = authCallbackMessage(p);
      return m.ok === false && /重新申请一封重置邮件/.test(m.text) && /失效|过期/.test(m.text);
    })(),
    "过期链接有出路");

  record("① 解析：直接打开（既没会话也没错误）→ 明说「要从邮件链接进」",
    (() => {
      const p = parseAuthCallback("https://010034.xyz/auth/confirm", "");
      return hasSessionPayload(p) === false && authCallbackMessage(p).ok === false &&
        /邮件里的链接/.test(authCallbackMessage(p).text);
    })(),
    "空访问也有提示");

  record("① 解析：PKCE 的 ?code= 与旧式 ?token_hash=&type= 都要认",
    (() => {
      const a = parseAuthCallback("https://x/auth/confirm?code=abc&next=/reset-password", "");
      const b = parseAuthCallback("https://x/auth/confirm?token_hash=th&type=recovery", "");
      return a.code === "abc" && hasSessionPayload(a) && b.tokenHash === "th" && b.type === "recovery" && hasSessionPayload(b);
    })(),
    "两条旧路径都认");

  record("★① 解析：`next` 只认站内路径（挡住开放重定向）",
    safeNextPath("//evil.com") === "/" && safeNextPath("https://evil.com") === "/" &&
      safeNextPath("/reset-password") === "/reset-password" && safeNextPath(null) === "/",
    "站外一律回 /");

  const proxySrc = readFileSync("D:/my-website/my-toolbox/src/proxy.ts", "utf8");
  record("★契约：/forgot-password 是公开路径；/reset-password **故意不是**",
    /PUBLIC_PATHS = \["\/login", "\/signup", "\/forgot-password", "\/auth"\]/.test(proxySrc) &&
      !/PUBLIC_PATHS = \[[^\]]*\/reset-password/.test(proxySrc),
    "PUBLIC_PATHS OK");
}

/* ---------------------------------------------------------------------------
   起服务（后面两段要它）
   --------------------------------------------------------------------------- */
const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const killPort3000 = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
};

killPort3000();
await sleep(1500);
const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], { cwd: PROJECT, stdio: "ignore", env: { ...process.env } });
let up = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { if ((await fetch(`${BASE}/login`)).status === 200) { up = true; break; } } catch { /* 等 */ }
}
record("（准备）本地服务已起来", up);
if (!up) { summary(); process.exit(1); }

const cookie = await loginCookie(adminEmail, password);
record("（准备）拿到登录会话（rolea = 免费版/管理员）", !!cookie);

const getHtml = async (path, withCookie) => {
  const r = await fetch(BASE + path, {
    headers: withCookie ? { cookie } : {},
    redirect: "manual",
  });
  return { status: r.status, location: r.headers.get("location"), html: await r.text() };
};

let edge = null;
try {
  /* ======================================================================
     二、公开页 / 受保护页
     ====================================================================== */
  const forgotAnon = await getHtml("/forgot-password", false);
  record("② 未登录能打开 /forgot-password（否则忘了密码的人永远进不去）",
    forgotAnon.status === 200 && /忘记密码/.test(forgotAnon.html),
    `HTTP ${forgotAnon.status} location=${forgotAnon.location ?? "-"}`);
  record("② 该页有邮箱输入框 + 发送按钮 + 一句「不区分邮箱是否注册」的口径说明",
    /name="email"/.test(forgotAnon.html) &&
      /发送重置链接|发送中/.test(forgotAnon.html) &&
      /注册时用的邮箱/.test(forgotAnon.html),
    "表单在");

  const loginPage = await getHtml("/login", false);
  record("② 登录页有「忘记密码」入口（否则没人找得到那个页面）",
    loginPage.status === 200 && /忘记密码/.test(loginPage.html) && /\/forgot-password/.test(loginPage.html),
    "入口在");

  const resetAnon = await getHtml("/reset-password", false);
  record("② 未登录打开 /reset-password 被挡（它必须由邮件链接换出会话后才能进）",
    resetAnon.status === 307 || resetAnon.status === 302,
    `HTTP ${resetAnon.status} → ${resetAnon.location ?? "-"}`);

  const accountAnon = await getHtml("/account/password", false);
  record("② 未登录打开 /account/password 被挡并带回跳地址",
    (accountAnon.status === 307 || accountAnon.status === 302) &&
      /\/login/.test(String(accountAnon.location)) &&
      /redirectTo=%2Faccount%2Fpassword/.test(String(accountAnon.location)),
    `HTTP ${accountAnon.status} → ${accountAnon.location ?? "-"}`);

  const accountAuthed = await getHtml("/account/password", true);
  record("② 登录后能打开 /account/password，页面上写着当前账号邮箱",
    accountAuthed.status === 200 && /修改密码/.test(accountAuthed.html) &&
      accountAuthed.html.includes(adminEmail),
    `HTTP ${accountAuthed.status}`);

  /* ======================================================================
     三、页面结构（三个框、长度限制、不能提交空）
     ====================================================================== */
  record("③ 修改密码页有三个框：当前密码 / 新密码 / 再输一遍",
    /name="oldPassword"/.test(accountAuthed.html) &&
      /name="password"/.test(accountAuthed.html) &&
      /name="confirmPassword"/.test(accountAuthed.html),
    "三框 OK");
  record("③ 两个新密码框带 minLength（下限来自 lib/password-policy）",
    (accountAuthed.html.match(/minLength="6"|minlength="6"/g) || []).length >= 2,
    `出现 ${(accountAuthed.html.match(/minlength="6"/gi) || []).length} 次`);

  const resetAuthed = await getHtml("/reset-password", true);
  record("③ 登录后 /reset-password 能打开，且**没有**「当前密码」这一栏（否则就死锁了）",
    resetAuthed.status === 200 && !/name="oldPassword"/.test(resetAuthed.html) &&
      /name="reset"/.test(resetAuthed.html),
    `HTTP ${resetAuthed.status}`);

  /* ======================================================================
     四、真浏览器：空着当前密码提交 → 只出前端/动作第一道的提示，不写任何东西
     ====================================================================== */
  const b = await startBrowser(CDP_PORT, "D:/my-website/.edge-profile-password");
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, goto, login } = makePageApi(cdp, sessionId);
  const pageErrors = [];
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      pageErrors.push(`${String(d?.text)} ${String(d?.exception?.description ?? "").slice(0, 140)}`);
    }
  });

  record("④（准备）在浏览器里登录", await login(adminEmail, password));
  await goto("/account/password", 3500);

  /* ------------------------------------------------------------------------
     ④-0 ★ 被修的那个 bug 的**真行为**验证：把真会话放进 `#` 片段打开 /auth/confirm，
     必须换成 Cookie 并跳到 `?next=` 指定的页面（而不是停在原地或弹回登录页）。
     ------------------------------------------------------------------------ */
  // 拿一份**真会话**（和 Supabase 邮件的 verify 端点跳回来时带的那份同样形状）
  const supaUrl = readEnv().SUPABASE_URL;
  const supaKey = readEnv().ANON_KEY;
  const sess = await (await fetch(`${supaUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: supaKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password }),
  })).json();

  if (!sess?.access_token) {
    record("④-0（准备）拿到一份真会话用于片段测试", false, "登录接口没返回 access_token");
  } else {
    const ref = new URL(supaUrl).hostname.split(".")[0];
    // 先清掉浏览器里已有的会话 cookie，避免"本来就有会话"污染这一步
    await cdp.send("Network.clearBrowserCookies", {}, sessionId);
    const hash = `#access_token=${sess.access_token}&refresh_token=${sess.refresh_token}&type=recovery&expires_in=3600`;
    await cdp.send("Page.navigate", { url: `${BASE}/auth/confirm?next=/reset-password${hash}` }, sessionId);
    // 等它自己跳走（客户端换会话 → location.replace）
    let landed = "";
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      landed = String(await ev("location.pathname"));
      if (landed && landed !== "/auth/confirm") break;
    }
    record("④-0 ★片段里的会话被认下来，并跳到 /reset-password（这正是原来坏掉的那一跳）",
      landed === "/reset-password", `落点=${landed || "(没跳走)"}`);

    const pageText = String(await ev("document.body.innerText"));
    const hasForm = !!(await ev(`!!document.querySelector('form [name="password"]')`));
    const noOld = !(await ev(`!!document.querySelector('[name="oldPassword"]')`));
    record("④-0 重置页真的可用：有新密码表单、且没有「当前密码」那一栏",
      hasForm && noOld && /设置新密码/.test(pageText),
      `表单=${hasForm} 无旧密码栏=${noOld}`);

    // 清掉这次为测试建立的会话，别影响后面的步骤
    await cdp.send("Network.clearBrowserCookies", {}, sessionId);
    await login(adminEmail, password);
    await goto("/account/password", 3500);
  }

  let formReady = false;
  for (let i = 0; i < 30; i++) {
    formReady = !!(await ev(`!!document.querySelector('form input[name="oldPassword"]')`));
    if (formReady) break;
    await sleep(400);
  }
  record("④ 浏览器里看到「修改密码」表单", formReady, formReady ? "表单在" : "20 秒内没等到表单");

  if (formReady) {
    // ---- 第一段：浏览器原生的"必填"校验就该挡住空表单 ----
    // ⚠️ 第一版这里写错了：直接 `requestSubmit()` 会**被原生校验拦住**（input 上有 required），
    //    于是根本轮询不到任何提示，我误判成"服务端没给提示"。事实是"浏览器先挡住了"——
    //    而那也是**正确行为**。所以下面分两段测：原生挡 / 服务端也挡。
    const afterEmptySubmit = await ev(`(() => {
      const f = document.querySelector('form');
      f.requestSubmit();
      return { stillHere: location.pathname === '/account/password', invalid: f.checkValidity() === false };
    })()`);
    record("④ 空表单被浏览器原生校验挡住（required），不会真的提交",
      afterEmptySubmit?.stillHere === true && afterEmptySubmit?.invalid === true,
      JSON.stringify(afterEmptySubmit));

    // ---- 第二段：绕开原生校验，逼服务端动作真的跑一次 ----
    // ⚠️ 安全：只填两个新密码框、当前密码留空 ⇒ 服务端在**碰 Supabase 之前**
    //    就会返回「请把两个密码框都填上。」（`checkNewPassword` 里 password/confirm 之外
    //    还要求 oldPassword 非空 —— 空的话它先报"两个框都填上"）。
    //    所以这一段**不会改动账号密码**。
    await ev(`(() => {
      const f = document.querySelector('form');
      f.querySelectorAll('[required]').forEach((el) => el.removeAttribute('required'));
      const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
      set('password', 'abcdef1');
      set('confirmPassword', 'abcdef1');
      f.requestSubmit();
      return true;
    })()`);

    let msg = "";
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      msg = String(await ev(`(() => {
        const el = document.querySelector('[role="alert"]');
        return el ? el.textContent.trim() : '';
      })()`));
      if (msg) break;
    }
    record("④ 服务端那一层也挡：给出中文提示（不会静默什么都不发生）",
      /两个密码框|至少|不能和当前密码一样|当前密码不正确/.test(msg),
      msg || "15 秒内没等到提示");
    record("④ 这一步**没有真的改掉密码**：页面没有出现「密码已修改」",
      !/密码已修改/.test(String(await ev(`document.body.innerText`))),
      "仍是原密码");
  }

  record("④ 页面无真实 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ") || "0 条");
  try { await cdp.send("Browser.close"); } catch { /* ignore */ }
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
