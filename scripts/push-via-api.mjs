#!/usr/bin/env node
/**
 * push-via-api.mjs —— 当 `git push` 连不上 github.com 时，改用 GitHub REST API 推送。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 什么时候用
 * ══════════════════════════════════════════════════════════════════════
 * 本机网络对 `github.com:443` 会**反复被重置**（实测：`Connection was reset`，
 * 或连续多次 `Failed to connect to github.com:443 after 21063 ms`），
 * 但 **`api.github.com` 一直是通的**。这种情况下 `git push` 无论重试多少次都没用，
 * 用本脚本走 API 把当前分支推上去。
 *
 * 先用一条命令确认到底是哪种情况：
 *
 *   git push origin main          # 若报 Connection was reset / Failed to connect → 用本脚本
 *
 * ══════════════════════════════════════════════════════════════════════
 * 怎么用
 * ══════════════════════════════════════════════════════════════════════
 *   node scripts/push-via-api.mjs --dry     # 演练：只打印将要发生什么，绝不写 GitHub
 *   node scripts/push-via-api.mjs           # 真推（当前分支 → origin 同名分支）
 *
 * 推完建议再跑一次 `git push origin main`：网络恢复时会回一句
 * `Everything up-to-date`，那就是「远端确实已经是你这个提交」的最强佐证。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 安全性（为什么敢用）
 * ══════════════════════════════════════════════════════════════════════
 * 1. **凭据不硬编码**：token 现取现用，从本机 git 凭据管理器读
 *    （`git credential fill`，host=github.com）。脚本不打印 token。
 *    缺凭据时直接报错退出，不会静默失败。
 * 2. **只做快进推送**：远端 HEAD 必须是本地 HEAD 的祖先（`git merge-base --is-ancestor`），
 *    否则直接中止 —— 不可能覆盖别人的提交。移动 ref 时还带 `force:false`。
 * 3. **硬闸：tree sha 必须一致**。脚本用远端 HEAD 的 tree 作 base、只放变更的条目，
 *    构造完之后**要求构造出的 tree sha 与本地 tree sha 完全相同**，不一致就中止。
 *    tree sha 覆盖全部文件的**内容与权限位**，所以这道闸等于「推上去的东西与本地逐字节一致」。
 * 4. **默认推完自动核对**：把远端整棵树拉下来，逐路径比对 blob sha，报「多/少/不同」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 已知副作用（重要，别被吓到）
 * ══════════════════════════════════════════════════════════════════════
 * **这样推上去的 commit sha 与本地不同。**
 * 原因是 GitHub 的 Git Data API 会重新生成 commit 对象，且它会把
 *   · commit message 结尾的换行去掉；
 *   · 提交时间改写成 UTC（同一时刻，只是写法从 +0800 变 +0000）。
 * commit sha 覆盖这些元数据，所以 sha 必然变。**文件内容不受影响**（tree sha 不变）。
 *
 * 想验证「内容真的一样」，看脚本结尾的逐文件比对结果即可 ——
 * 那比对比 commit sha 更强（commit sha 只覆盖元数据）。
 *
 * 推完本地会与远端 sha 分叉。要消除分叉，可在核对通过后执行（脚本会提示）：
 *   git update-ref refs/remotes/origin/main <远端新sha>
 *   git update-ref refs/heads/main <远端新sha>      # 两棵树相同，不会动任何文件
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry") || argv.includes("--dry-run");
const NO_VERIFY = argv.includes("--no-verify");
const repoArgIdx = argv.indexOf("--repo");
const REPO = repoArgIdx >= 0 ? argv[repoArgIdx + 1] : "Gqj1001/my-toolbox";
const branchArgIdx = argv.indexOf("--branch");

/** 脚本放在 <repo>/scripts/ 下，所以仓库根是它的上一级 */
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com";

// ---------------------------------------------------------------- git 工具
/**
 * 找到 git 可执行文件。
 *
 * ⚠️ 本机 **git 不在 PATH 上**（`git` 直接敲会 CommandNotFound；文档里也写了这一点），
 *    所以 Node 的 spawnSync 会 ENOENT。这里按顺序找：
 *      1. 环境变量 GIT_BIN（需要时覆盖）
 *      2. PATH 里的 git（正常机器）
 *      3. 本机已知的绝对路径（兜底）
 */
const GIT_BIN = (() => {
  if (process.env.GIT_BIN && existsSync(process.env.GIT_BIN)) return process.env.GIT_BIN;
  const candidates = [
    "git", // 交给 PATH 解析
    "D:\\my-website\\.tools\\git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\cmd\\git.exe",
  ];
  for (const c of candidates) {
    if (c === "git") {
      try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
        return "git";
      } catch {
        continue;
      }
    }
    if (existsSync(c)) return c;
  }
  return "git"; // 最后再交给 PATH，失败时报错信息更直白
})();

const git = (...a) =>
  execFileSync(GIT_BIN, ["-C", PROJECT, ...a], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
const gitRaw = (...a) =>
  execFileSync(GIT_BIN, ["-C", PROJECT, ...a], { encoding: "buffer", maxBuffer: 1 << 28 });
const gitOk = (...a) => {
  try {
    execFileSync(GIT_BIN, ["-C", PROJECT, ...a], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- 凭据
function readGitHubToken() {
  let out;
  try {
    out = execFileSync(GIT_BIN, ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      env: { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (e) {
    // 不要吞掉真实错误：凭据读不出来时，罪魁祸首往往就在 stderr 里
    const stderr = e?.stderr ? String(e.stderr).trim() : "";
    const stdout = e?.stdout ? String(e.stdout).trim() : "";
    die(
      "读取 git 凭据失败（`git credential fill` 没能返回）。\n" +
        `  exit=${e?.status ?? "?"}\n` +
        (stderr ? `  stderr: ${stderr}\n` : "") +
        (stdout ? `  stdout: ${stdout}\n` : "") +
        "  请先确认本机能正常 push 过（凭据管理器里有 github.com 的 token）。",
    );
  }
  const token = (out.match(/^password=(.+)$/m) ?? [])[1];
  if (!token) {
    die(
      "git 凭据管理器里没有 github.com 的 token。\n" +
        "  先用一次 `git push`（走 GitHub 登录授权）把凭据存下来，或者手动配置 credential.helper。",
    );
  }
  return token;
}

const TOKEN = readGitHubToken();

// ---------------------------------------------------------------- API 封装
async function api(method, p, body) {
  if (DRY && method !== "GET") {
    console.log(`   [dry] ${method} ${p}`);
    if (body) console.log(`         ${JSON.stringify(body).slice(0, 140)}${JSON.stringify(body).length > 140 ? " …" : ""}`);
    if (p.endsWith("/git/blobs")) return { sha: "<dry-blob>" };
    if (p.endsWith("/git/trees")) return { sha: body?.base_tree ?? "<dry-tree>" };
    if (p.endsWith("/git/commits")) return { sha: "<dry-commit>" };
    return {};
  }
  const res = await fetch(API + p, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "push-via-api",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    die(`${method} ${p} → HTTP ${res.status}\n  ${text.slice(0, 400)}`);
  }
  return json;
}

// ---------------------------------------------------------------- sha 计算
/** git 对象（commit/tree/blob）的 sha = sha1("<type> <len>\0" + 内容) */
const objectSha = (type, buf) =>
  createHash("sha1").update(`${type} ${buf.length}\0`).update(buf).digest("hex");

/**
 * 按 GitHub API 的规则重写一个 commit 对象的字节，用来**预先算出** API 会生成的 sha。
 * 规则（实测得出）：message 去掉尾部换行；author/committer 时间改写成 UTC（同一时刻）。
 * 这样即使 sha 变了，我们也知道它「本来该是什么」，从而校验 API 没有乱来。
 */
function rewriteCommitObjectBytes(localSha) {
  const text = gitRaw("cat-file", "commit", localSha).toString("utf8");
  const i = text.indexOf("\n\n");
  const header = text.slice(0, i);
  const body = text.slice(i + 2);
  const toUtc = (line) =>
    line.replace(/(\d+) ([+-]\d{4})$/, (_, secs) => `${secs} +0000`);
  const newHeader = header
    .split("\n")
    .map((l) => (/^(author|committer) /.test(l) ? toUtc(l) : l))
    .join("\n");
  const buf = Buffer.from(`${newHeader}\n\n${body.replace(/\n+$/, "")}`, "utf8");
  return { buf, message: body.replace(/\n+$/, ""), tree: git("rev-parse", `${localSha}^{tree}`) };
}

// ---------------------------------------------------------------- 主流程
const branch =
  branchArgIdx >= 0 ? argv[branchArgIdx + 1] : git("rev-parse", "--abbrev-ref", "HEAD");
if (!branch || branch === "HEAD") die("当前处于 detached HEAD，请用 --branch <名字> 指定要推的分支。");

/** 要推送的**本地引用**（用它，而不是 HEAD —— 否则 --branch 只改了远端路径、内容还是 HEAD 的） */
const localRef = `refs/heads/${branch}`;
if (!gitOk("rev-parse", "--verify", localRef)) {
  die(`本地没有分支 ${branch}。可用的分支：\n  ${git("branch", "--format=%(refname:short)").split("\n").join("\n  ")}`);
}
const localHead = git("rev-parse", localRef);

console.log(`仓库      : ${PROJECT}`);
console.log(`目标      : ${REPO} 分支 ${branch}`);
console.log(`本地 ${branch.padEnd(6)}: ${localHead}`);
if (DRY) console.log("模式      : --dry（只演练，不会写任何东西到 GitHub）");

const refPath = `/repos/${REPO}/git/ref/heads/${branch}`;
let remoteHead = null;
{
  const res = await fetch(API + refPath, {
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "push-via-api",
    },
  });
  if (res.status === 200) {
    remoteHead = (await res.json()).object.sha;
  } else if (res.status === 404) {
    remoteHead = null; // 分支还不存在：这是正常情况，不是错误
  } else {
    die(`读取远端分支失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
console.log(`远端 HEAD : ${remoteHead ?? "(分支不存在，将新建)"}`);

const localTree = git("rev-parse", `${localHead}^{tree}`);

if (remoteHead === localHead) {
  console.log("\n远端已经是这个提交，无需推送。");
  process.exit(0);
}

// ---------- 确定「基点」：新分支必须接在远端已有提交之上，不能从根重放 ----------
let baseCommit;
if (remoteHead) {
  if (!gitOk("merge-base", "--is-ancestor", remoteHead, localHead)) {
    die(
      "远端不是本地的祖先 —— 这不是快进推送。\n" +
        "  说明远端有你本地没有的提交。请先想办法 fetch/rebase（例如换个网络直连 git），\n" +
        "  本脚本**不会**强推，以免覆盖别人的工作。",
    );
  }
  baseCommit = remoteHead;
  console.log("快进检查  : 通过（远端是本地分支的祖先）");
} else {
  // 分支不存在：以「本地分支与远端默认分支的合并基」为基点，
  // 这样新分支会接在远端已有历史之上，而不是把整个仓库重放一遍。
  const defaultBranch = (await api("GET", `/repos/${REPO}`)).default_branch;
  const remoteDefault = (await api("GET", refPath.replace(/heads\/.*$/, `heads/${defaultBranch}`))).object.sha;
  const mb = gitOk("merge-base", localHead, remoteDefault)
    ? git("merge-base", localHead, remoteDefault)
    : null;
  if (!mb) {
    die(
      `新分支 ${branch} 与远端 ${defaultBranch} 没有共同祖先，无法安全地只推增量。\n` +
        "  这种情况请先用直连 git push 建立初始关系。",
    );
  }
  baseCommit = mb;
  console.log(`新分支    : 以与远端 ${defaultBranch} 的合并基作为基点 ${baseCommit.slice(0, 8)}`);
}

const baseTree = git("rev-parse", `${baseCommit}^{tree}`);
console.log(`基点 tree : ${baseTree}`);
console.log(`本地 tree : ${localTree}`);

// ---------- 要推的提交（基点..本地，老的在前） ----------
const commitList = git("rev-list", "--reverse", `${baseCommit}..${localHead}`)
  .split("\n")
  .filter(Boolean);
if (!commitList.length) {
  console.log("\n基点就是本地分支顶端，无需推送。");
  process.exit(0);
}
console.log(`\n需要推送 ${commitList.length} 个提交：`);
for (const c of commitList) console.log(`  ${c.slice(0, 8)}  ${git("log", "-1", "--pretty=%s", c)}`);

// ---------- 上传所有涉及变更的 blob ----------
// 对每个提交都要构造 tree，所以把「本地对象 → 远端 blob sha」做成缓存，避免重复上传。
const blobCache = new Map();
async function uploadBlob(localBlobSha, label) {
  if (blobCache.has(localBlobSha)) return blobCache.get(localBlobSha);
  const size = Number(git("cat-file", "-s", localBlobSha));
  if (size > 40 * 1024 * 1024) die(`文件过大（${size} 字节），不适合走 API：${label}`);
  if (DRY) {
    console.log(`   [dry] 上传 blob ${label} (${size} 字节)`);
  } else {
    const content = gitRaw("cat-file", "blob", localBlobSha).toString("base64");
    const created = await api("POST", `/repos/${REPO}/git/blobs`, { content, encoding: "base64" });
    if (created.sha !== localBlobSha) {
      die(`上传的 blob sha 与本地不一致（${created.sha} ≠ ${localBlobSha}）：${label}`);
    }
  }
  blobCache.set(localBlobSha, localBlobSha);
  return localBlobSha;
}

let parentForNext = baseCommit;
let lastNewSha = null;

for (const localSha of commitList) {
  // 该提交相对其父的变更
  const strongParent = git("rev-parse", `${localSha}^`).trim();
  const diffBase = strongParent === baseCommit ? baseCommit : strongParent;
  const changed = git("diff", "--name-status", diffBase, localSha).split("\n").filter(Boolean);

  const entries = [];
  for (const line of changed) {
    const [status, file] = line.split("\t");
    if (status === "D") continue; // 不进 tree 即删除
    const mode = git("ls-tree", localSha, "--", file).split(/\s+/)[0];
    const blobSha = await uploadBlob(git("rev-parse", `${localSha}:${file}`), file);
    entries.push({ path: file, mode, type: "blob", sha: blobSha });
  }

  // ---------- 构造 tree（硬闸在这里） ----------
  const treeBody = { tree: entries, ...(parentForNext ? { base_tree: git("rev-parse", `${parentForNext}^{tree}`) } : {}) };
  const tree = await api("POST", `/repos/${REPO}/git/trees`, treeBody);
  const expectedTree = git("rev-parse", `${localSha}^{tree}`);
  if (DRY) {
    console.log(`   [dry] 构造 tree（本地应为 ${expectedTree}）`);
  } else if (tree.sha !== expectedTree) {
    die(
      `构造出的 tree（${tree.sha}）与本地 tree（${expectedTree}）不一致 —— 已中止，**没有**改动远端。\n` +
        `  这是本脚本最重要的安全闸：tree sha 覆盖全部文件内容与权限位。`,
    );
  } else {
    console.log(`  ✓ ${localSha.slice(0, 8)} tree 校验通过 ${tree.sha}`);
  }

  // ---------- 建 commit（元数据按 API 口径，便于预告 sha） ----------
  const { buf, message } = rewriteCommitObjectBytes(localSha);
  const expectedSha = objectSha("commit", buf);
  const authorName = git("log", "-1", "--pretty=%an", localSha);
  const authorEmail = git("log", "-1", "--pretty=%ae", localSha);
  const authorEpoch = Number(git("log", "-1", "--pretty=%at", localSha));
  const committerName = git("log", "-1", "--pretty=%cn", localSha);
  const committerEmail = git("log", "-1", "--pretty=%ce", localSha);
  const committerEpoch = Number(git("log", "-1", "--pretty=%ct", localSha));

  const commit = await api("POST", `/repos/${REPO}/git/commits`, {
    message,
    tree: expectedTree,
    parents: parentForNext ? [parentForNext] : [],
    author: { name: authorName, email: authorEmail, date: new Date(authorEpoch * 1000).toISOString() },
    committer: {
      name: committerName,
      email: committerEmail,
      date: new Date(committerEpoch * 1000).toISOString(),
    },
  });

  if (DRY) {
    console.log(`   [dry] 建 commit（预告 sha ${expectedSha}）`);
  } else {
    console.log(`  ✓ 建 commit ${commit.sha}${commit.sha === expectedSha ? "（与预告一致）" : `（预告 ${expectedSha}，以实际为准）`}`);
  }
  parentForNext = DRY ? expectedSha : commit.sha;
  lastNewSha = parentForNext;
}

if (DRY) {
  console.log("\n--- 演练结束：以上是将会发生的写操作，**没有**改动 GitHub ---");
  process.exit(0);
}

// ---------- 移动 ref（带 old_sha 保护，force:false） ----------
if (!remoteHead) {
  await api("POST", `/repos/${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: lastNewSha });
} else {
  await api("PATCH", `/repos/${REPO}/git/refs/heads/${branch}`, {
    sha: lastNewSha,
    force: false,
  });
}
const after = (await api("GET", refPath)).object.sha;
console.log(`\n✓ 已把 ${branch} 指向 ${after}`);
if (after !== lastNewSha) die(`移动后的远端 sha（${after}）与预期（${lastNewSha}）不一致！`);

// ---------- 核对：逐文件比对远端与本地 ----------
if (!NO_VERIFY) {
  console.log("\n--- 核对：远端整棵树 vs 本地 HEAD ---");
  const remoteCommit = await api("GET", `/repos/${REPO}/git/commits/${after}`);
  const remoteFiles = new Map();
  const walk = async (sha, prefix) => {
    const t = await api("GET", `/repos/${REPO}/git/trees/${sha}`);
    for (const e of t.tree) {
      const p = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === "tree") await walk(e.sha, p);
      else remoteFiles.set(p, e.sha);
    }
  };
  const remoteTreeSha =
    typeof remoteCommit.tree === "string" ? remoteCommit.tree : remoteCommit.tree.sha;
  await walk(remoteTreeSha, "");

  // ⚠️ 必须关掉 core.quotePath，否则中文路径会被输出成八进制转义，导致假报差异
  const localFiles = new Map();
  for (const line of git("-c", "core.quotePath=false", "ls-tree", "-r", localRef).split("\n").filter(Boolean)) {
    const m = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/);
    if (m) localFiles.set(m[2], m[1]);
  }

  const onlyRemote = [...remoteFiles.keys()].filter((k) => !localFiles.has(k));
  const onlyLocal = [...localFiles.keys()].filter((k) => !remoteFiles.has(k));
  const differ = [...localFiles.keys()].filter(
    (k) => remoteFiles.has(k) && remoteFiles.get(k) !== localFiles.get(k),
  );
  console.log(`远端 ${remoteFiles.size} 个文件 / 本地 ${localFiles.size} 个文件`);
  console.log(`  远端多出 ${onlyRemote.length}，本地多出 ${onlyLocal.length}，内容不同 ${differ.length}`);
  if (onlyRemote.length || onlyLocal.length || differ.length) {
    console.log("  远端多出:", onlyRemote.slice(0, 5));
    console.log("  本地多出:", onlyLocal.slice(0, 5));
    console.log("  内容不同:", differ.slice(0, 5));
  }

  console.log(
    remoteTreeSha === localTree
      ? "\n✓ 远端 tree sha 与本地完全一致（内容 + 权限位逐字节相同）"
      : `\n⚠️ 远端 tree ${remoteTreeSha} ≠ 本地 tree ${localTree}（请看上面的差异清单）`,
  );
}

console.log(`
—— 接下来 ——
1. commit sha 与本地不同是**正常的**（见文件头「已知副作用」）。内容已由 tree sha 证明一致。
2. 想消除 sha 分叉（两棵树相同，不会动任何文件）：
     git update-ref refs/heads/${branch} ${after}
   若本地 ${branch} 就是当前分支，可改用：
     git reset --hard ${after}
3. 网络恢复后可以再跑一次 \`git push origin ${branch}\`，回 "Everything up-to-date" 即为最强佐证。
`);
