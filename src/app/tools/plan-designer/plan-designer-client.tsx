"use client";

import { useEffect, useMemo, useState } from "react";
import {
  LIBRARY,
  setActiveLibrary,
  LEVELS,
  WINDOWS,
  allocateHours,
  analysisDefaults,
  buildRows,
  cycleForWindow,
  defaultCourseIds,
  defaultModules,
  goalFor,
  moduleCourses,
  totalGoal,
  windowByKey,
  type PlanForm,
  type PlanRow,
  type PlanLibrary,
  type WindowKey,
} from "@/lib/plan-designer";

const field =
  "h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const area =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed text-zinc-900 outline-none transition focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const label = "text-xs text-zinc-500 dark:text-zinc-400";
const btn =
  "inline-flex h-9 items-center justify-center rounded-lg px-3.5 text-sm font-medium transition disabled:opacity-50";
const card =
  "rounded-xl border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900/40";

const emptyForm = (): PlanForm => ({
  name: "",
  grade: "高三",
  school: "",
  teacher: "郭老师",
  teacherLevel: "—",
  subject: "数学",
  level: "一轮强化提升",
  current: 60,
  target: 90,
  totalHours: 60,
  usedHours: 0,
  accuracy: "85%",
  weakModules: [],
  keywords: "",
  family: "",
  schoolEnv: "",
  windowKey: "winter",
  year: 2027,
});

const dims = [
  ["knowledge", "知识储备"],
  ["ability", "学科能力"],
  ["method", "学习方法"],
  ["habit", "行为习惯"],
  ["attitude", "内在态度"],
  ["family", "家庭环境"],
  ["school", "学校环境"],
] as const;

export default function PlanDesignerClient({ isVip }: { isVip: boolean }) {
  const [form, setForm] = useState<PlanForm>(emptyForm);
  const [lib, setLib] = useState<PlanLibrary>(LIBRARY);
  const [libMsg, setLibMsg] = useState("");

  useEffect(() => { setActiveLibrary(lib); }, [lib]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`plan-designer-library-${form.windowKey}`);
      setLib(raw ? (JSON.parse(raw) as PlanLibrary) : LIBRARY);
      setSelectedModules([]);
      setCourseSel({});
      setRows([]);
      setLibMsg(raw ? "已载入本窗口上次导入的课程库。" : (form.windowKey === "winter" ? "当前使用内置寒假集训课程库。" : `当前窗口（${windowByKey(form.windowKey).label}）尚未导入课程库，暂用内置寒假库；请先导入。`));
    } catch {
      setLib(LIBRARY);
    }
  }, [form.windowKey]);
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  const [courseSel, setCourseSel] = useState<Record<string, number[]>>({});
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [analysis, setAnalysis] = useState(() => analysisDefaults(emptyForm()));
  const [goalText, setGoalText] = useState("");
  const [busy, setBusy] = useState<"" | "ai" | "export" | "generate">("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [expanded, setExpanded] = useState<string>("函数");

  const cycle = useMemo(
    () => cycleForWindow(form.windowKey, form.year, form.totalHours),
    [form.windowKey, form.year, form.totalHours],
  );
  const window = windowByKey(form.windowKey);
  const totalPlanned = rows.reduce((a, r) => a + Number(r.hours || 0), 0);
  const diff = totalPlanned - form.totalHours;

  function patch<K extends keyof PlanForm>(key: K, value: PlanForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function loadStudent(name: string) {
    const s = lib.students.find((x) => x.name === name);
    if (!s) return;
    const weak = String(s.weak || "").split("、").filter(Boolean);
    setForm((f) => ({
      ...f,
      name: s.name,
      grade: s.grade,
      school: s.campus,
      level: s.level,
      current: s.current,
      target: s.target,
      totalHours: s.totalHours,
      accuracy: s.accuracy || "85%",
      weakModules: weak,
    }));
    setSelectedModules(defaultModules({ ...form, name: s.name, grade: s.grade, level: s.level, current: s.current, target: s.target, totalHours: s.totalHours, weakModules: weak }));
    setMsg({ kind: "ok", text: `已载入 ${s.name} 的档案，可直接生成。` });
  }

  async function uploadLibrary(file: File | null) {
    if (!file) return;
    setBusy("generate");
    setLibMsg("正在读取课程库…");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/plan-designer/library", { method: "POST", body: fd });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; library?: PlanLibrary } | null;
      if (!res.ok || !j?.ok || !j.library) {
        setLibMsg(j?.error || `导入失败（HTTP ${res.status}）`);
        return;
      }
      setLib(j.library);
      setActiveLibrary(j.library);
      try { localStorage.setItem(`plan-designer-library-${form.windowKey}`, JSON.stringify(j.library)); } catch { /* ignore */ }
      setSelectedModules([]);
      setRows([]);
      setLibMsg(`已导入 ${j.library.modules.length} 个模块 / ${j.library.courses.length} 门课程，覆盖当前窗口。`);
    } catch (e) {
      setLibMsg("导入失败：" + String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  function toggleModule(name: string) {
    if (selectedModules.includes(name)) {
      setSelectedModules((list) => list.filter((x) => x !== name));
      return;
    }
    if (!courseSel[name]) {
      setCourseSel((m) => ({ ...m, [name]: defaultCourseIds(name, form.level) }));
    }
    setSelectedModules((list) => [...list, name]);
  }

  function toggleCourse(module: string, id: number) {
    setCourseSel((m) => {
      const cur = m[module] ?? defaultCourseIds(module, form.level);
      return { ...m, [module]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    });
  }

  function generate() {
    if (!form.name.trim()) { setMsg({ kind: "err", text: "请先填写学生姓名。" }); return; }
    if (!selectedModules.length) { setMsg({ kind: "err", text: "请至少选择一个知识模块。" }); return; }
    const r = buildRows(form, selectedModules, courseSel);
    setRows(r);
    const a = analysisDefaults(form);
    setAnalysis(a);
    setGoalText(totalGoal(form, cycle));
    setMsg({ kind: "ok", text: `已生成 ${r.length} 个模块，共 ${r.reduce((x, y) => x + y.hours, 0)} 课时，可逐行修改。` });
  }

  function moveRow(index: number, dir: -1 | 1) {
    setRows((list) => {
      const j = index + dir;
      if (j < 0 || j >= list.length) return list;
      const copy = [...list];
      [copy[index], copy[j]] = [copy[j], copy[index]];
      return copy;
    });
  }

  function updateRow(index: number, patchRow: Partial<PlanRow>) {
    setRows((list) => list.map((r, i) => (i === index ? { ...r, ...patchRow } : r)));
  }

  function removeRow(index: number) {
    setRows((list) => list.filter((_, i) => i !== index));
  }

  function addModule(name: string) {
    if (!name || selectedModules.includes(name)) return;
    toggleModule(name);
    const module = lib.modules.find((m) => m.name === name);
    if (!module) return;
    const ids = courseSel[name] ?? defaultCourseIds(name, form.level);
    const courses = lib.courses.filter((c) => ids.includes(c.id));
    setRows((list) => [...list, {
      id: `m-${Date.now()}`,
      module: name,
      points: [...new Set(courses.flatMap((c) => c.points.split(/[；;]/).map((s) => s.trim()).filter(Boolean)))].join("；"),
      examScore: module.scoreText,
      hours: 2,
      goal: goalFor(module, form),
      effect: "—",
      adjustment: "—",
      courseIds: ids,
    }]);
  }

  async function ai(action: "analysis" | "goals") {
    if (!isVip) { setMsg({ kind: "err", text: "AI 润色是会员功能，请先开通会员。" }); return; }
    setBusy("ai");
    setMsg(null);
    try {
      const res = await fetch("/api/plan-designer/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          form,
          analysis,
          rows,
          cycleText: cycle.text,
        }),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; analysis?: Record<string, string>; goals?: string[] } | null;
      if (!res.ok || !j?.ok) { setMsg({ kind: "err", text: j?.error || `AI 请求失败（HTTP ${res.status}）` }); return; }
      if (action === "analysis" && j.analysis) {
        setAnalysis((a) => ({
          ...a,
          ...Object.fromEntries(Object.entries(j.analysis ?? {}).filter(([k]) => ["knowledge", "ability", "method", "habit", "attitude"].includes(k))),
        }));
        setMsg({ kind: "ok", text: "前 5 个分析维度已由 AI 润色；家庭/学校环境保留你填写的内容。" });
      } else if (action === "goals" && Array.isArray(j.goals)) {
        setRows((list) => list.map((r, i) => ({ ...r, goal: j.goals?.[i] || r.goal })));
        setMsg({ kind: "ok", text: "每行目标已由 AI 润色，可继续手改。" });
      }
    } catch (e) {
      setMsg({ kind: "err", text: "网络错误：" + String((e as Error)?.message ?? e) });
    } finally { setBusy(""); }
  }

  async function exportXlsx() {
    if (!rows.length) { setMsg({ kind: "err", text: "请先生成方案。" }); return; }
    if (diff !== 0) { setMsg({ kind: "err", text: `规划课时合计 ${totalPlanned}，与总课时 ${form.totalHours} 不一致，请先调整。` }); return; }
    setBusy("export");
    setMsg(null);
    try {
      const res = await fetch("/api/plan-designer/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          level: form.level,
          analysis,
          rows,
          totalGoal: goalText,
          cycleText: cycle.text,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setMsg({ kind: "err", text: j?.error || `导出失败（HTTP ${res.status}）` });
        return;
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${form.name}-个性化辅导计划表.xlsx`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1200);
      setMsg({ kind: "ok", text: "已导出 xlsx，可直接打开检查/打印。" });
    } catch (e) {
      setMsg({ kind: "err", text: "导出失败：" + String((e as Error)?.message ?? e) });
    } finally { setBusy(""); }
  }

  return (
    <main className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-[390px]">
        <section className={card}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">1. 基本信息</h2>
            <select
              className="h-8 max-w-[150px] rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              defaultValue=""
              onChange={(e) => { if (e.target.value) loadStudent(e.target.value); e.currentTarget.value = ""; }}
            >
              <option value="">载入示例学生</option>
              {lib.students.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={label}>学生姓名<input className={`${field} mt-1`} value={form.name} onChange={(e) => patch("name", e.target.value)} /></label>
            <label className={label}>学校/校区<input className={`${field} mt-1`} value={form.school} onChange={(e) => patch("school", e.target.value)} /></label>
            <label className={label}>年级<input className={`${field} mt-1`} value={form.grade} onChange={(e) => patch("grade", e.target.value)} /></label>
            <label className={label}>教师<input className={`${field} mt-1`} value={form.teacher} onChange={(e) => patch("teacher", e.target.value)} /></label>
            <label className={label}>教师级别<input className={`${field} mt-1`} value={form.teacherLevel} onChange={(e) => patch("teacherLevel", e.target.value)} /></label>
            <label className={label}>学科<input className={`${field} mt-1`} value={form.subject} onChange={(e) => patch("subject", e.target.value)} /></label>
            <label className={label}>层次
              <select className={`${field} mt-1`} value={form.level} onChange={(e) => patch("level", e.target.value)}>
                {LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </select>
            </label>
            <label className={label}>当前分<input type="number" className={`${field} mt-1`} value={form.current} onChange={(e) => patch("current", Number(e.target.value))} /></label>
            <label className={label}>目标分<input type="number" className={`${field} mt-1`} value={form.target} onChange={(e) => patch("target", Number(e.target.value))} /></label>
            <label className={label}>总课时<input type="number" className={`${field} mt-1`} value={form.totalHours} onChange={(e) => patch("totalHours", Number(e.target.value))} /></label>
            <label className={label}>已上课时<input type="number" className={`${field} mt-1`} value={form.usedHours} onChange={(e) => patch("usedHours", Number(e.target.value))} /></label>
            <label className={label}>基础题正确率<input className={`${field} mt-1`} value={form.accuracy} onChange={(e) => patch("accuracy", e.target.value)} /></label>
            <label className={label}>窗口期
              <select className={`${field} mt-1`} value={form.windowKey} onChange={(e) => patch("windowKey", e.target.value as WindowKey)}>
                {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.month} 月 · {w.label}</option>)}
              </select>
            </label>
            <label className={label}>年份<input type="number" className={`${field} mt-1`} value={form.year} onChange={(e) => patch("year", Number(e.target.value))} /></label>
          </div>
          <p className="mt-2 text-xs text-zinc-400">{window.label} · {cycle.text}</p>
        </section>

        <section className={card}>
          <h2 className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">2. 学情关键词</h2>
          <label className={label}>失分模块（可多选）</label>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {lib.modules.filter((m) => m.score != null).map((m) => (
              <button key={m.name} type="button" onClick={() => patch("weakModules", form.weakModules.includes(m.name) ? form.weakModules.filter((x) => x !== m.name) : [...form.weakModules, m.name])}
                className={`rounded-full border px-2.5 py-1 text-xs ${form.weakModules.includes(m.name) ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900" : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"}`}>
                {m.name}
              </button>
            ))}
          </div>
          <label className={`${label} mt-3 block`}>老师补充关键词
            <textarea className={`${area} mt-1`} rows={2} value={form.keywords} onChange={(e) => patch("keywords", e.target.value)} placeholder="如：计算粗心、导数含参不会讨论、做题慢" />
          </label>
          <label className={`${label} mt-2 block`}>家庭环境（最后两行手动）
            <textarea className={`${area} mt-1`} rows={2} value={form.family} onChange={(e) => patch("family", e.target.value)} />
          </label>
          <label className={`${label} mt-2 block`}>学校环境（最后两行手动）
            <textarea className={`${area} mt-1`} rows={2} value={form.schoolEnv} onChange={(e) => patch("schoolEnv", e.target.value)} />
          </label>
        </section>

        <section className={card}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">3. 课程选择</h2>
            <span className="text-xs text-zinc-400">{selectedModules.length} 个模块</span>
          </div>
          <p className="mb-2 text-xs text-zinc-400">预科/插班可只勾需要的内容；生成后还能在右侧调整顺序和课时。</p>
          <label className="mb-2 flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-2.5 py-2 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            <span>📚 导入当前窗口课程库（.xlsx）</span>
            <input type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => { uploadLibrary(e.target.files?.[0] ?? null); e.currentTarget.value = ""; }} />
            <span className="ml-auto underline">选择文件</span>
          </label>
          {libMsg ? <p className="mb-2 text-[11px] text-zinc-400">{libMsg}</p> : null}
          <div className="flex max-h-[520px] flex-col gap-1.5 overflow-y-auto pr-1">
            {lib.modules.map((m) => {
              const courses = moduleCourses(m.name);
              const on = selectedModules.includes(m.name);
              const open = expanded === m.name;
              return (
                <div key={m.name} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <input type="checkbox" checked={on} onChange={() => toggleModule(m.name)} aria-label={`选择 ${m.name}`} />
                    <button type="button" className="flex-1 text-left text-xs font-medium text-zinc-700 dark:text-zinc-200" onClick={() => setExpanded(open ? "" : m.name)}>
                      {m.name} <span className="font-normal text-zinc-400">{m.scoreText}</span>
                    </button>
                    <span className="text-[11px] text-zinc-400">{courses.length} 课</span>
                  </div>
                  {open ? (
                    <div className="border-t border-zinc-100 px-2 py-1.5 dark:border-zinc-800">
                      {courses.map((c) => {
                        const ids = courseSel[m.name] ?? defaultCourseIds(m.name, form.level);
                        return (
                          <label key={c.id} className="flex items-start gap-2 py-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                            <input type="checkbox" checked={ids.includes(c.id)} onChange={() => toggleCourse(m.name, c.id)} />
                            <span>{c.name} <span className="text-zinc-400">（{c.hours}课时）</span></span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <div className="flex flex-col gap-2">
          <button type="button" onClick={generate} disabled={!!busy} className={`${btn} bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900`}>
            {busy === "generate" ? "生成中…" : "生成/重新规划方案"}
          </button>
          {msg ? <p className={`text-xs ${msg.kind === "ok" ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</p> : null}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <section className={card}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{form.name || "未命名学生"} · {window.label}个性化辅导计划</h1>
              <p className="mt-1 text-xs text-zinc-500">{form.school} {form.grade} · {form.subject} · 总课时 {form.totalHours} · 已上 {form.usedHours}</p>
            </div>
            <button type="button" onClick={exportXlsx} disabled={!!busy || !rows.length} className={`${btn} bg-emerald-600 text-white`}>
              {busy === "export" ? "导出中…" : "⬇ 导出新模板 xlsx"}
            </button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className={label}>预期总目标<textarea className={`${area} mt-1`} rows={4} value={goalText} onChange={(e) => setGoalText(e.target.value)} /></label>
            <label className={label}>辅导周期<textarea className={`${area} mt-1`} rows={4} value={cycle.text} readOnly /></label>
          </div>
        </section>

        <section className={card}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">一、学生整体学情分析</h2>
            <div className="flex gap-2">
              <button type="button" onClick={() => ai("analysis")} disabled={!!busy} className={`${btn} border border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-200`}>✨ AI 润色前 5 项</button>
              <button type="button" onClick={() => ai("goals")} disabled={!!busy || !rows.length} className={`${btn} border border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-200`}>✨ AI 润色目标</button>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {dims.map(([key, name]) => (
              <label key={key} className={label}>{name}
                <textarea className={`${area} mt-1`} rows={3} value={analysis[key]} onChange={(e) => setAnalysis((a) => ({ ...a, [key]: e.target.value }))} />
              </label>
            ))}
          </div>
        </section>

        <section className={card}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">二、辅导计划及结果验收</h2>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-xs ${diff === 0 ? "text-emerald-600" : "text-red-600"}`}>课时合计 {totalPlanned} / {form.totalHours}{diff !== 0 ? `（差 ${diff > 0 ? "+" : ""}${diff}）` : " ✓"}</span>
              <select className={`${field} h-8 w-36`} defaultValue="" onChange={(e) => { addModule(e.target.value); e.currentTarget.value = ""; }}>
                <option value="">+ 加模块</option>
                {lib.modules.filter((m) => !selectedModules.includes(m.name)).map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] border-collapse text-xs">
              <thead>
                <tr className="bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  <th className="border border-zinc-200 px-2 py-1.5 dark:border-zinc-700">知识模块</th>
                  <th className="border border-zinc-200 px-2 py-1.5 dark:border-zinc-700">具体知识点</th>
                  <th className="border border-zinc-200 px-2 py-1.5 dark:border-zinc-700">考试分值</th>
                  <th className="border border-zinc-200 px-2 py-1.5 dark:border-zinc-700">规划课时</th>
                  <th className="border border-zinc-200 px-2 py-1.5 dark:border-zinc-700">可达成的目标</th>
                  <th className="border border-zinc-200 px-2 py-1.5 dark:border-zinc-700">已完成效果</th>
                  <th className="border border-zinc-200 px-2 py-1.5 dark:border-zinc-700">计划调整</th>
                  <th className="border border-zinc-200 px-2 py-1.5 dark:border-zinc-700">顺序</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} className="align-top">
                    <td className="border border-zinc-200 p-1 dark:border-zinc-700"><input className={`${field} min-w-[120px]`} value={r.module} onChange={(e) => updateRow(i, { module: e.target.value })} /></td>
                    <td className="border border-zinc-200 p-1 dark:border-zinc-700"><textarea className={`${area} min-w-[230px]`} rows={3} value={r.points} onChange={(e) => updateRow(i, { points: e.target.value })} /></td>
                    <td className="border border-zinc-200 p-1 dark:border-zinc-700"><input className={`${field} w-20`} value={r.examScore} onChange={(e) => updateRow(i, { examScore: e.target.value })} /></td>
                    <td className="border border-zinc-200 p-1 dark:border-zinc-700"><input type="number" className={`${field} w-16`} value={r.hours} onChange={(e) => updateRow(i, { hours: Number(e.target.value) })} /></td>
                    <td className="border border-zinc-200 p-1 dark:border-zinc-700"><textarea className={`${area} min-w-[240px]`} rows={3} value={r.goal} onChange={(e) => updateRow(i, { goal: e.target.value })} /></td>
                    <td className="border border-zinc-200 p-1 dark:border-zinc-700"><input className={`${field} w-20`} value={r.effect} onChange={(e) => updateRow(i, { effect: e.target.value })} /></td>
                    <td className="border border-zinc-200 p-1 dark:border-zinc-700"><input className={`${field} w-20`} value={r.adjustment} onChange={(e) => updateRow(i, { adjustment: e.target.value })} /></td>
                    <td className="border border-zinc-200 p-1 text-center dark:border-zinc-700">
                      <div className="flex flex-col gap-1">
                        <button type="button" className="rounded border px-1" onClick={() => moveRow(i, -1)}>↑</button>
                        <button type="button" className="rounded border px-1" onClick={() => moveRow(i, 1)}>↓</button>
                        <button type="button" className="rounded border px-1 text-red-600" onClick={() => removeRow(i)}>删</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length ? <p className="mt-3 text-sm text-zinc-500">左侧选好模块后，点「生成/重新规划方案」。</p> : null}
        </section>
      </section>
    </main>
  );
}
