// 阶段③（阶段B）补充验证：VIP 已开通后的配置分支
//
// 背景：本地 .env.local 没有 AI_KEY，而默认测试脚本是在「无 Key」的环境下起服务的，
//       因此只能验证到 503。本脚本额外做一件事：
//         用**假 AI_KEY** 重新起一次服务，让 VIP 请求通过 503 这道配置闸，
//         真正打到上游 —— 证明「VIP + 有 Key」之后的代码路径是通的
//         （上游会以假 Key 拒绝，因此应用返回 502，而**不是** 503）。
//
// 结论口径：
//   · 不设 AI_KEY  → VIP 得到 503「服务端未配置 AI Key」  = 配置缺失分支正确
//   · 设假 AI_KEY  → VIP 得到 502「AI 服务暂时不可用」    = 503 之后的路径可达且错误不透传
//
// 断言「AI Key 绝不回传前端」两组都要过。
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer, startBrowser, makePageApi, makeRecorder, readUsers } from "./_helpers.mjs";

const { adminEmail, userEmail, password } = readUsers();
const { record, summary } = makeRecorder();

const API = "/api/math-plan/ai-sections";
const BODY = {
  section: "method",
  context: {
    grade: "高三", band: 3, score: 105, target: 125, totalHours: 120,
    paragraphs: ["（1）方案与总量。本方案共 120 课时。", "（2）学情诊断。学生压轴题得分率不高。"],
  },
};

const NODE_BIN = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = "D:\\my-website\\my-toolbox\\node_modules\\next\\dist\\bin\\next";
const PROJECT = "D:\\my-website\\my-toolbox";

/** 起一个可以附加环境变量的生产服务（假 AI_KEY 用） */
async function startServerWithEnv(extraEnv) {
  const pid = spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess"],
    { encoding: "utf8" }).stdout.trim();
  if (pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
  await sleep(2000);
  const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], {
    cwd: PROJECT, stdio: "ignore", env: { ...process.env, ...extraEnv },
  });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch("http://127.0.0.1:3000/login")).status === 200) break; } catch { /* wait */ }
  }
  return srv;
}

let srv = null, edge = null;
try {
  // ============ A. 无 AI_KEY（默认环境）============
  srv = await startServer();
  const b = await startBrowser(9460, "D:/my-website/.edge-profile-mp-vip");
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, goto, login } = makePageApi(cdp, sessionId);

  const callApi = (bodyObj) =>
    ev(`fetch(${JSON.stringify(API)}, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: ${JSON.stringify(JSON.stringify(bodyObj))}
      }).then(async r => ({ status: r.status, text: String(await r.text()).slice(0, 200) }))
      .catch(e => ({ status: -1, text: String(e && e.message) }))`);

  // ---- 非会员对照用 rolea-（仍为免费版）；roleb- 已开通 VIP ----
  const inAdminFree = await login(adminEmail, password);
  record("rolea（免费版）登录成功", inAdminFree);
  if (inAdminFree) {
    const r = await callApi(BODY);
    record("免费版账号被挡在 VIP 门禁（403）", r.status === 403, `HTTP ${r.status} ${r.text.slice(0, 80)}`);
  }

  // ---- 关键：roleb 已被开通 VIP，用它验证「VIP + 无 Key → 503」 ----
  const inVip = await login(userEmail, password);
  record("roleb（已开通 VIP）登录成功", inVip);
  if (inVip) {
    // 会员状态在 `/tools`（= 个人中心）的**会员状态卡**上看。
    // ⚠️ 2026-10 起**顶栏不再显示会员等级**：邮箱/会员徽标/退出按钮都搬到会员卡上了
    //    （原来顶栏和 /dashboard 正文各显示一遍，同一页重复两三处）。
    //    所以这条断言改到 `/tools` 上查 —— **要验的东西没变**：roleb 的 VIP 真的生效了。
    //    ⚠️ `login()` 落点也是 `/tools`（登录后即个人中心），这里显式走一遍更不容易被落点变化弄坏。
    await goto("/tools", 3000);
    const pcTxt = await ev(`document.body.innerText.replace(/\\s+/g,' ')`);
    const lookVip = /会员版/.test(pcTxt) && /\d+ 天/.test(pcTxt);
    record("roleb 的会员状态已生效（个人中心会员卡显示「会员版 · 剩 N 天」）", lookVip, pcTxt.slice(0, 110));
    // 顺带钉住「顶栏不再承担会员信息」这件事，防止有人又把它加回去造成重复
    const headerTxt = await ev(`(document.querySelector('header')||document.body).innerText.replace(/\\s+/g,' ')`);
    record("顶栏只管导航（不再重复显示会员等级）",
      !/会员版|免费版/.test(headerTxt), headerTxt.slice(0, 90));

    const noKey = await callApi(BODY);
    record("VIP + 无 AI_KEY → 503「服务端未配置 AI Key」",
      noKey.status === 503 && /服务端未配置/.test(noKey.text), `HTTP ${noKey.status} ${noKey.text.slice(0, 90)}`);
    record("503 响应体不含 AI Key 内容", !/sk-/.test(noKey.text), noKey.text.slice(0, 70));
  }

  try { await cdp.send("Browser.close"); } catch { /* ignore */ }
  try { edge.kill(); } catch { /* ignore */ }
  edge = null;
  srv.kill();
  srv = null;
  await sleep(2500);

  // ============ B. 假 AI_KEY：验证 503 之后的路径可达 ============
  srv = await startServerWithEnv({ AI_KEY: "sk-dummy-local-test-not-a-real-key" });
  const b2 = await startBrowser(9461, "D:/my-website/.edge-profile-mp-vip2");
  edge = b2.edge;
  const p2 = makePageApi(b2.cdp, b2.sessionId);

  const inVip2 = await p2.login(userEmail, password);
  record("（假 Key 环境）roleb 登录成功", inVip2);
  if (inVip2) {
    const r = await p2.ev(`fetch(${JSON.stringify(API)}, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: ${JSON.stringify(JSON.stringify(BODY))}
      }).then(async x => ({ status: x.status, text: String(await x.text()).slice(0, 300) }))
      .catch(e => ({ status: -1, text: String(e && e.message) }))`);

    // 有 Key 时不会再是 503；上游用假 Key 拒绝 → 502
    record("配了 AI_KEY 时不再返回 503（配置闸已通过）", r.status !== 503, `HTTP ${r.status} ${r.text.slice(0, 90)}`);
    record("假 Key 被上游拒绝时返回 502（503 之后的路径可达）",
      r.status === 502, `HTTP ${r.status} ${r.text.slice(0, 90)}`);
    record("上游错误原文不透传（不出现鉴权/账号等细节）",
      !/Unauthorized|invalid_api_key|Authentication|401/.test(r.text),
      r.text.slice(0, 90));
    record("（假 Key 环境）响应体仍不含 Key 内容", !/sk-dummy/.test(r.text), r.text.slice(0, 70));

    // goals 分支同样应走到上游
    const g = await p2.ev(`fetch(${JSON.stringify(API)}, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: ${JSON.stringify(JSON.stringify({ section: "goals", context: { grade: "高三", lessons: [{ stage: "数列", goal: "正确率≥90%" }] } }))}
      }).then(async x => ({ status: x.status, text: String(await x.text()).slice(0, 120) }))
      .catch(e => ({ status: -1, text: String(e && e.message) }))`);
    record("goals 分支同样走到上游（非 503、非 400）",
      g.status === 502 || g.status === 200, `HTTP ${g.status} ${g.text.slice(0, 80)}`);

    // ---- 有 Key 之后，入参校验分支才真正可达 → 补测 400 系列 ----
    const post2 = (body) => p2.ev(`fetch(${JSON.stringify(API)}, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: ${JSON.stringify(typeof body === "string" ? body : JSON.stringify(body))}
      }).then(async x => ({ status: x.status, text: String(await x.text()).slice(0, 120) }))
      .catch(e => ({ status: -1, text: String(e && e.message) }))`);

    const badSection = await post2({ section: "nope", context: { paragraphs: ["x"] } });
    record("（有 Key）section 非法 → 400", badSection.status === 400, `HTTP ${badSection.status} ${badSection.text.slice(0, 80)}`);

    const emptyCtx = await post2({ section: "method", context: {} });
    record("（有 Key）段落为空 → 400", emptyCtx.status === 400, `HTTP ${emptyCtx.status} ${emptyCtx.text.slice(0, 80)}`);

    const badJson = await post2("{ not json");
    record("（有 Key）非 JSON 请求体 → 400", badJson.status === 400, `HTTP ${badJson.status} ${badJson.text.slice(0, 80)}`);

    const goalsEmpty = await post2({ section: "goals", context: { lessons: [] } });
    record("（有 Key）课表为空 → 400", goalsEmpty.status === 400, `HTTP ${goalsEmpty.status} ${goalsEmpty.text.slice(0, 80)}`);

    const arrBody = await post2([1, 2, 3]);
    record("（有 Key）JSON 顶层不是对象 → 400", arrBody.status === 400, `HTTP ${arrBody.status} ${arrBody.text.slice(0, 80)}`);

    try { await b2.cdp.send("Browser.close"); } catch { /* ignore */ }
  }
} catch (e) {
  record("测试执行未异常中断", false, e.message);
  console.error("测试异常:", e.message);
} finally {
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  if (srv) { try { srv.kill(); } catch { /* ignore */ } }
}

const pass = summary();
process.exit(pass ? 0 : 1);
