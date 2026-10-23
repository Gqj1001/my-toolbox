"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BACKFILL_KINDS, MAX_MATERIAL_CHARS, type BackfillKind } from "@/lib/backfill";
import { parseDisplayDate } from "@/lib/date-input";

const field =
  "h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100";
const area =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed text-zinc-900 outline-none transition focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100";
const label = "text-xs text-zinc-500 dark:text-zinc-400";
const btn =
  "inline-flex h-9 items-center justify-center rounded-lg px-3.5 text-sm font-medium transition disabled:opacity-60";

type Facts = { examDate: string; examName: string; score: string; fullScore: string; hours: string };
type Preview = {
  kind: BackfillKind;
  tool: string;
  text: string;
  facts: Facts;
  uncertain: string[];
  missing: string[];
  suspiciousLength: boolean;
  rawFallback: boolean;
};

/**
 * 「📥 补录历史材料」（2026-10 第十八批；用户拍板见 `docs/manual-backfill-plan.md`）
 *
 * 干什么：工具上线**之前**的试卷分析 / 辅导方案 / 课后反馈散在老师手里（Word、PDF、纸），
 * 这里让 AI 把它们**整理成与现有工具相同的正文格式**，老师**核对修改后**入档 ——
 * 于是学情分析能用上"全部历史"，而 `student-report.ts` **一行都不用改**。
 *
 * ⚠️ 三条设计口径（用户拍板，别自己改）：
 *   1. **零迁移**：复用已有 `tool` 值（paper / math-plan / feedback），不新增表、不加新 tool；
 *   2. **一期只做文字**：粘贴 / Word / 文字版 PDF；照片与扫描件是二期（`docs/manual-backfill-plan.md` §6）；
 *   3. **必须人核**：AI 只整理不创作；预览可编辑，**点确认才写库**（不让人工智能静默进档案）。
 *
 * ⚠️ 与"手动补录成绩"（`tool='manual'`）是**两件事**：那是只有数字的一条记录，这是带正文的。
 */
export default function BackfillPanel({ name }: { name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<BackfillKind>("paper");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"" | "read" | "ai" | "save">("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [edited, setEdited] = useState("");
  /**
   * ★ 2026-10 用户线上验收后加的：**这条记录是哪天的**，由老师自己定。
   *
   * 为什么必须补这一格：原来只靠 AI 从材料里抽「考试日期」，抽不到就传空串，
   * 于是存进库是 NULL ⇒ 档案详情页显示「未填日期」、学情分析也没法按时间排
   * （用户截图里三条补录记录都是「未填日期」）。
   * 口径：**补录必须让老师选哪天**；默认今天，AI 抽到就自动带过来（老师可改）。
   */
  const [dateValue, setDateValue] = useState<string>(() => todayIso());
  /** 粘贴后自动整理的定时器（连着粘几段只跑最后一次，别把 AI 调爆） */
  const pasteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 文件 → dataURL（走已有的 parse-file 抽文字；服务器只抽**文字层**） */
  async function readFiles(files: FileList | null) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setBusy("read");
    setMsg(null);
    try {
      const parts: string[] = [];
      for (const f of list) {
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result ?? ""));
          r.onerror = () => reject(new Error("读取文件失败"));
          r.readAsDataURL(f);
        });
        const res = await fetch("/api/paper-analysis/parse-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: f.name, data }),
        });
        const j = (await res.json().catch(() => null)) as { ok?: boolean; text?: string; note?: string; error?: string } | null;
        if (!res.ok || !j?.ok) {
          setMsg({ kind: "err", text: `${f.name}：${j?.error || `读取失败（HTTP ${res.status}）`}` });
          continue;
        }
        const got = String(j.text ?? "").trim();
        if (!got) {
          setMsg({ kind: "err", text: `${f.name}：${j.note || "这个文件里没抽到文字（可能是扫描图片版）"}` });
          continue;
        }
        parts.push(list.length > 1 ? `===== ${f.name} =====\n${got}` : got);
      }
      if (parts.length) {
        // ⭐ 用户要的「少点一次」：文件读完就**自动**整理，不用再点「让 AI 整理」
        const next = (text ? text + "\n\n" : "") + parts.join("\n\n");
        setText(next);
        setMsg({ kind: "ok", text: `已读取 ${parts.length} 个文件，正在自动整理…` });
        setBusy("");
        void runAi(next);
        return;
      }
    } catch (e) {
      setMsg({ kind: "err", text: "读取失败：" + String((e as Error)?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  /**
   * 让 AI 整理成统一格式（**不写库**）。
   *
   * ⭐ 2026-10 用户验收要求「少点一次」：上传文件或粘贴文字之后**自动调用**它，
   *    老师不用再点「让 AI 整理」。按钮仍然留着（手动重跑/换类型后重跑）。
   * ⚠️ `textArg` 是给自动调用用的：React 的 `setText` 是异步的，
   *    紧接着调 runAi() 读到的还是**旧的 text**（会白跑一次、或者整理出上一份材料）。
   */
  async function runAi(textArg?: string) {
    const body = String(textArg ?? text);
    if (!body.trim()) {
      setMsg({ kind: "err", text: "请先粘贴文字或上传文件。" });
      return;
    }
    setBusy("ai");
    setMsg(null);
    try {
      const r = await fetch("/api/students/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, text: body }),
      });
      const j = (await r.json().catch(() => null)) as (Preview & { ok?: boolean; error?: string }) | null;
      if (!r.ok || !j?.ok) {
        setMsg({ kind: "err", text: j?.error || `整理失败（HTTP ${r.status}）` });
        return;
      }
      setPreview({
        kind: j.kind, tool: j.tool, text: j.text, facts: j.facts,
        uncertain: j.uncertain ?? [], missing: j.missing ?? [],
        suspiciousLength: !!j.suspiciousLength, rawFallback: !!j.rawFallback,
      });
      setEdited(j.text);
      // ★ AI 抽到了日期就带过来（抽不到**保留老师已经选的**，不回退成空）
      const aiDate = parseDisplayDate(j.facts?.examDate);
      if (aiDate) setDateValue(aiDate);
      // ★ AI 整理成功 = 立刻把结果填进预览框（用户要的"少点一次"：不用再点确认才看到内容）
      if (!j.rawFallback) {
        setMsg({ kind: "ok", text: "整理好了，已经填进下面的预览框 —— 逐项核对后点「存入档案」即可。" });
      } else {
        setMsg({
          kind: "err",
          text: "AI 没按格式返回，下面是它的原文 —— 请**重点核对并手工整理**后再存入。",
        });
      }
      setBusy("");
      // 顺手把预览区滚进视野（省一次"结果在哪"的找）
      if (typeof document !== "undefined") {
        setTimeout(() => {
          const el = document.getElementById("backfill-preview");
          if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
        }, 60);
      }
      return;
    } catch (e) {
      setMsg({ kind: "err", text: "整理失败：" + String((e as Error)?.message ?? e) });
      setBusy("");
    }
  }

  /** 确认入档：走**已有的** /api/students 导入接口（一行没改） */
  async function save() {
    if (!preview) return;
    if (!edited.trim()) {
      setMsg({ kind: "err", text: "正文是空的，不能保存。" });
      return;
    }
    // ★ 补录**必须有日期**：没有日期的记录进档案就是「未填日期」，学情分析排不了序
    if (!dateValue) {
      setMsg({ kind: "err", text: "请先选这条记录的日期（补录的历史材料必须写明是哪天）。" });
      return;
    }
    setBusy("save");
    setMsg(null);
    try {
      const title = defaultTitle(preview);
      const r = await fetch("/api/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "import",
          items: [{
            student_name: name,
            tool: preview.tool,
            title,
            // ★ 用老师选/确认的日期（原来是 `preview.facts.examDate || ""` ⇒ 抽不到就空）
            date: dateValue,
            text: edited,
            score: numOrNull(preview.facts.score),
            full_score: numOrNull(preview.facts.fullScore),
          }],
        }),
      });
      const j = (await r.json().catch(() => null)) as { ok?: boolean; inserted?: number; error?: string } | null;
      if (r.ok && j?.ok && (j.inserted ?? 0) > 0) {
        setMsg({ kind: "ok", text: `已存入档案（${BACKFILL_KINDS[preview.kind].label}，日期 ${dateValue}）。学情分析下次生成时会把它算进去。` });
        setPreview(null);
        setText("");
        setDateValue(todayIso());   // 下一条回到"今天"，不把上一条的日期带过去
        router.refresh();
      } else if (j?.ok && (j.inserted ?? 0) === 0) {
        setMsg({ kind: "err", text: "档案里已有一条同名的同日期记录，本次没有重复保存（可改标题后重试）。" });
      } else {
        setMsg({ kind: "err", text: j?.error || `保存失败（HTTP ${r.status}）` });
      }
    } catch (e) {
      setMsg({ kind: "err", text: "保存失败：" + String((e as Error)?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="rounded-xl border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">补录历史材料</p>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            工具上线**之前**做的试卷分析 / 辅导方案 / 课后反馈，可以在这里补进档案
            —— 让学情分析用上全部历史（AI 只做整理，**要你核对后才入档**）。
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setOpen((v) => !v); setMsg(null); }}
          className={`${btn} h-9 shrink-0 border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800`}
        >
          {open ? "收起" : "📥 补录历史材料"}
        </button>
      </div>

      {open ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={`${label} flex flex-col gap-1`}>
              <span>① 这是哪种材料？</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as BackfillKind)} className={field}>
                {(Object.keys(BACKFILL_KINDS) as BackfillKind[]).map((k) => (
                  <option key={k} value={k}>{BACKFILL_KINDS[k].label}</option>
                ))}
              </select>
            </label>
            <label className={`${label} flex flex-col gap-1`}>
              <span>② 上传文件（.docx / 文字版 PDF，可多选）</span>
              <input
                type="file"
                multiple
                accept=".docx,.pdf,.txt,.md"
                disabled={busy !== ""}
                onChange={(e) => { readFiles(e.target.files); e.currentTarget.value = ""; }}
                className="text-xs text-zinc-500 file:mr-2 file:rounded-lg file:border file:border-zinc-300 file:bg-white file:px-2.5 file:py-1.5 file:text-xs dark:border-zinc-700 dark:file:border-zinc-700 dark:file:bg-zinc-900"
              />
            </label>
          </div>

          <label className={`${label} flex flex-col gap-1`}>
            <span>③ 或直接粘贴文字（{text.length} / {MAX_MATERIAL_CHARS} 字）</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              maxLength={MAX_MATERIAL_CHARS}
              placeholder="把老材料的文字复制到这里（Word 里 Ctrl+A 复制即可）"
              className={area}
              onPaste={(e) => {
                // ⭐ 用户要的「少点一次」：**粘贴完就自动整理**（不用再点「让 AI 整理」）。
                //    等 900ms 是为了让粘贴的内容先落到 textarea 里（连续粘几段只跑最后一次）。
                const el = e.currentTarget;
                if (pasteTimer.current) clearTimeout(pasteTimer.current);
                pasteTimer.current = setTimeout(() => {
                  const now = String(el.value ?? "");
                  if (now.trim()) { setText(now); void runAi(now); }
                }, 900);
              }}
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => { void runAi(); }}
              disabled={busy !== "" || !text.trim()}
              className={`${btn} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`}
            >
              {busy === "ai" ? "⏳ 正在整理…" : busy === "read" ? "⏳ 正在读取文件…" : "🤖 重新整理"}
            </button>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              上传文件或粘贴后**会自动整理**，不用点这里；换过材料类型想重跑时才需要点。
            </span>
            {text ? (
              <button
                type="button"
                onClick={() => { setText(""); setPreview(null); setMsg(null); }}
                disabled={busy !== ""}
                className={`${btn} border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
              >
                清空
              </button>
            ) : null}
            {msg ? (
              <span
                role={msg.kind === "err" ? "alert" : "status"}
                className={"text-xs " + (msg.kind === "err" ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}
              >
                {msg.text}
              </span>
            ) : null}
          </div>

          {preview ? (
            <div id="backfill-preview" className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-3 dark:border-amber-900 dark:bg-amber-950/30">
              <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                🔎 核对清单（**请对照原材料逐项看**）
              </p>
              <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-amber-900 dark:text-amber-200">
                {factLine("考试日期", preview.facts.examDate, preview.kind === "paper")}
                {factLine("考试名称", preview.facts.examName, preview.kind !== "feedback")}
                {factLine("得分", preview.facts.score, preview.kind === "paper")}
                {factLine("满分", preview.facts.fullScore, preview.kind === "paper")}
                {factLine("总课时", preview.facts.hours, preview.kind === "plan")}
              </ul>
              {preview.missing.length ? (
                <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                  ⚠️ 材料里**没有**这几项（不会猜，也不会进统计）：{preview.missing.join("；")}
                </p>
              ) : null}
              {preview.uncertain.length ? (
                <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">
                  ⚠️ 有看不清/有歧义的地方：{preview.uncertain.join("；")}
                </p>
              ) : null}
              {preview.suspiciousLength ? (
                <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                  ⚠️ 整理后的字数是原文的 1.5 倍以上，**可能被扩写了** —— 请特别仔细核对。
                </p>
              ) : null}
            </div>
          ) : null}

          {preview ? (
            <>
              {/* ★ 2026-10 用户验收后加：「这条记录是哪天的」必须让老师定。
                  原来只靠 AI 抽，抽不到就存 NULL ⇒ 详情页「未填日期」、学情分析排不了序。 */}
              <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
                <label className={`${label} flex flex-wrap items-center gap-2`}>
                  <span className="font-medium text-zinc-700 dark:text-zinc-200">④ 这条记录是哪天的？</span>
                  <input
                    type="date"
                    value={dateValue}
                    onChange={(e) => setDateValue(e.target.value)}
                    className={`${field} w-44`}
                    aria-label="记录日期"
                  />
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">
                    补录必须选；默认今天。AI 从材料里抽到会自动带过来，可改。
                  </span>
                </label>
                {!dateValue ? (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    ⚠️ 没选日期存进去会变成「未填日期」，学情分析就没法按时间排 —— 请选一个。
                  </p>
                ) : null}
              </div>
              <label className={`${label} flex flex-col gap-1`}>
                <span>⑤ 整理结果（可直接改；**以你改完的为准**）</span>
                <textarea value={edited} onChange={(e) => setEdited(e.target.value)} rows={12} className={`${area} font-mono text-xs`} />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={save}
                  disabled={busy !== "" || !edited.trim() || !dateValue}
                  className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}
                >
                  {busy === "save" ? "⏳ 保存中…" : "💾 存入档案"}
                </button>
                <button
                  type="button"
                  onClick={() => { setPreview(null); setMsg(null); }}
                  disabled={busy !== ""}
                  className={`${btn} border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
                >
                  放弃这次
                </button>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  存入后可在下面的记录里看到，也会被学情分析算进去。
                </span>
              </div>
            </>
          ) : null}

          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            说明：照片 / 扫描件（没有文字层的 PDF）请先用手机自带的"扫描/文字识别"转成文字再粘进来
            —— 直接拍纸质材料这条路在**二期**做。
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** 核对清单里的一项：没取到时用灰色标出来（**不隐藏**，让老师知道没取到） */
function factLine(labelText: string, value: string, relevant: boolean) {
  if (!relevant) return null;
  return (
    <li key={labelText}>
      {labelText}：{value ? <b>{value}</b> : <span className="text-red-600 dark:text-red-400">（没取到）</span>}
    </li>
  );
}

function numOrNull(v: string): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 今天的 ISO 日期（**本地时区**，不能用 toISOString —— 那是 UTC，晚上会差一天） */
function todayIso(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 记录标题：优先用材料里的考试名，否则按类型给一个干净标题（不再把补录日期写进标题） */
function defaultTitle(p: Preview): string {
  if (p.kind === "plan") return "辅导方案";
  if (p.kind === "feedback") return "课后反馈";
  const exam = String(p.facts.examName || "").trim();
  return exam || "试卷分析";
}
