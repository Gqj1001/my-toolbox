/**
 * HAR 诊断：为什么 feedback.html 下载慢
 *
 * 用法：& <node> tests\_analyze-har.mjs "<har 路径>" ["<har 路径 2>" ...]
 *
 * 只读 HAR，不发任何请求。重点看：
 *   ① feedback.html 这个请求本身的 timing 分解（哪一段慢）
 *   ② 同一页里其他请求的对比（是只有它慢，还是整体都慢）
 *   ③ 响应头（缓存/压缩/CDN）+ 是否走了远端
 */
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法：node tests/_analyze-har.mjs <har> [<har> ...]");
  process.exit(2);
}

/** 把毫秒数按"人话"格式化：-1 表示该阶段没发生 */
const ms = (v) => (v == null || v < 0 ? "—" : Math.round(v) + "ms");
const kb = (v) => (v == null ? "?" : (v / 1024).toFixed(1) + "KB");
const secs = (v) => (v == null ? "?" : (v / 1000).toFixed(2) + "s");

for (const f of files) {
  console.log("\n" + "=".repeat(78));
  console.log("文件：" + f);
  console.log("=".repeat(78));
  let har;
  try {
    har = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    console.log("读不了或不是合法 JSON：" + e.message);
    continue;
  }
  const entries = har?.log?.entries ?? [];
  console.log(`浏览器：${har?.log?.browser?.name ?? "?"} ${har?.log?.browser?.version ?? ""}`);
  console.log(`页面：${har?.log?.pages?.map((p) => p.title).filter(Boolean).join(" | ") || "?"}`);
  console.log(`请求总数：${entries.length}`);

  if (!entries.length) continue;

  // ---------------- ① 每个请求的耗时排行 ----------------
  const rows = entries.map((e) => {
    const t = e.timings ?? {};
    const dur = e.time ?? (e.timings ? Object.values(e.timings).filter((x) => x > 0).reduce((a, b) => a + b, 0) : 0);
    return {
      url: e.request?.url ?? "?",
      status: e.response?.status,
      size: e.response?.content?.size ?? e.response?.bodySize ?? 0,
      dur,
      ttfb: t.receive != null && t.wait != null ? t.wait : t.wait,   // 等待服务器（首字节前）
      blocked: t.blocked, dns: t.dns, connect: t.connect, ssl: t.ssl,
      send: t.send, wait: t.wait, receive: t.receive,
      e,
    };
  }).sort((a, b) => b.dur - a.dur);

  console.log("\n--- ① 耗时最长的 12 个请求 ---");
  console.log("  耗时      等待(服务器)  接收(下载)    大小      状态  路径");
  for (const r of rows.slice(0, 12)) {
    const p = new URL(r.url).pathname + (new URL(r.url).search || "");
    console.log(`  ${secs(r.dur).padStart(8)}  ${ms(r.wait).padStart(10)}  ${ms(r.receive).padStart(10)}  ${kb(r.size).padStart(9)}  ${String(r.status).padStart(4)}  ${p.slice(0, 60)}`);
  }

  // ---------------- ② feedback.html 专项 ----------------
  const fb = entries.filter((e) => /feedback\.html(\?|$)/.test(e.request?.url ?? ""));
  console.log(`\n--- ② feedback.html 共 ${fb.length} 次请求 ---`);
  for (const e of fb) {
    const t = e.timings ?? {};
    const total = e.time;
    const dl = t.receive;
    const speed = dl > 0 ? (e.response?.content?.size ?? 0) / 1024 / (dl / 1000) : 0;
    console.log(`  URL：${e.request.url}`);
    console.log(`  总耗时 ${secs(total)}　= 排队 ${ms(t.blocked)} + DNS ${ms(t.dns)} + 连接 ${ms(t.connect)} + TLS ${ms(t.ssl)}`
      + ` + 发送 ${ms(t.send)} + **等待服务器 ${ms(t.wait)}** + **接收/下载 ${ms(t.receive)}**`);
    console.log(`  响应大小：${kb(e.response?.content?.size)}（压缩后 ${kb(e.response?.bodySize)}）`);
    console.log(`  实测下载速度：约 ${speed.toFixed(1)} KB/s`);
    console.log(`  远端 IP：${e.serverIPAddress ?? "?"}　连接复用：${e.connection ?? "?"}`);
    console.log(`  状态：${e.response?.status} ${e.response?.statusText ?? ""}   HTTP：${e.response?.httpVersion ?? "?"}`);
    console.log("  响应头（挑关键）：");
    for (const h of e.response?.headers ?? []) {
      if (/cache|content-encoding|content-length|content-type|age|cf-|server|vary|x-vercel|etag|last-modified/i.test(h.name)) {
        console.log(`    ${h.name}: ${String(h.value).slice(0, 100)}`);
      }
    }
  }

  // ---------------- ③ 同页其他大文件对比 ----------------
  console.log('\n--- ③ 其它 >50KB 的响应（用来对比「是不是只有 feedback.html 慢」）---');
  const big = rows.filter((r) => r.size > 50 * 1024);
  if (!big.length) console.log("  （没有超过 50KB 的响应）");
  for (const r of big) {
    const p = new URL(r.url).pathname;
    const speed = r.receive > 0 ? r.size / 1024 / (r.receive / 1000) : 0;
    console.log(`  ${kb(r.size).padStart(9)}  下载 ${ms(r.receive).padStart(9)}  约 ${speed.toFixed(1).padStart(6)} KB/s  ${p.slice(0, 55)}`);
  }

  // ---------------- ④ 有没有失败的请求 ----------------
  const bad = entries.filter((e) => (e.response?.status ?? 0) >= 400 || e.response?.status === 0);
  console.log(`\n--- ④ 失败/异常请求：${bad.length} 个 ---`);
  for (const e of bad.slice(0, 10)) {
    console.log(`  ${e.response?.status} ${new URL(e.request.url).pathname.slice(0, 70)}`);
  }
}
console.log("\n（分析结束，未修改任何东西）");
