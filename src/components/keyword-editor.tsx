"use client";

import { useActionState, useEffect, useState } from "react";
import {
  addKeyword,
  addPhrase,
  deleteKeyword,
  deletePhrase,
  normalizeCategory,
  updateKeyword,
  updatePhrase,
  type KeywordActionResult,
} from "@/app/admin/feedback-keywords/actions";

const initial: KeywordActionResult = { status: "idle" };

type KeywordRow = { id: number; subject: string; category: string; keyword: string; sort_order: number };
type PhraseRow = { id: number; phrase: string; sort_order: number };

type Props = {
  subjects: { code: string; name: string }[];
  byCategory: Record<string, Record<string, KeywordRow[]>>;
  phrases: PhraseRow[];
};

function useResult(result: KeywordActionResult) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (result.status === "idle") return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 4000);
    return () => clearTimeout(t);
  }, [result]);
  if (!show || !result.message) return null;
  return (
    <span
      role={result.status === "error" ? "alert" : "status"}
      className={`text-xs ${
        result.status === "error"
          ? "text-red-600 dark:text-red-400"
          : "text-emerald-600 dark:text-emerald-400"
      }`}
    >
      {result.message}
    </span>
  );
}

/** 单个关键词：改文字 / 改排序 / 删除 */
function KeywordItem({ row }: { row: KeywordRow }) {
  const [updateState, updateAction, updating] = useActionState(updateKeyword, initial);
  const [deleteState, deleteAction, deleting] = useActionState(deleteKeyword, initial);
  const updateMsg = useResult(updateState);
  const deleteMsg = useResult(deleteState);

  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-zinc-100 py-1.5 last:border-0 dark:border-zinc-800">
      <form action={updateAction} className="flex flex-1 flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={row.id} />
        <input
          type="number"
          name="sortOrder"
          defaultValue={row.sort_order}
          className="h-7 w-14 rounded-md border border-zinc-300 px-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          aria-label="排序"
        />
        <input
          name="keyword"
          defaultValue={row.keyword}
          className="h-7 min-w-[12rem] flex-1 rounded-md border border-zinc-300 px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          aria-label="关键词"
        />
        <button
          type="submit"
          disabled={updating || deleting}
          className="h-7 rounded-md border border-zinc-300 px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {updating ? "保存中…" : "保存"}
        </button>
      </form>

      <form action={deleteAction}>
        <input type="hidden" name="id" value={row.id} />
        <button
          type="submit"
          disabled={updating || deleting}
          onClick={(e) => {
            if (!confirm(`删除关键词「${row.keyword}」？`)) e.preventDefault();
          }}
          className="h-7 rounded-md border border-red-300 px-2 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          {deleting ? "…" : "删除"}
        </button>
      </form>

      {updateMsg}
      {deleteMsg}
    </li>
  );
}

/** 一个分类：标题 + 新增表单 + 关键词列表 */
function CategoryBlock({
  subject,
  category,
  rows,
}: {
  subject: string;
  category: string;
  rows: KeywordRow[];
}) {
  const [addState, addAction, adding] = useActionState(addKeyword, initial);
  const [normState, normAction, normalizing] = useActionState(normalizeCategory, initial);
  const addMsg = useResult(addState);
  const normMsg = useResult(normState);
  const [open, setOpen] = useState(false);

  return (
    <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100"
        >
          <span className="text-xs text-zinc-400">{open ? "▼" : "▶"}</span>
          {category}
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {rows.length}
          </span>
        </button>

        <form action={normAction} className="flex items-center gap-2">
          <input type="hidden" name="subject" value={subject} />
          <input type="hidden" name="category" value={category} />
          <button
            type="submit"
            disabled={normalizing}
            className="h-7 rounded-md border border-zinc-300 px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {normalizing ? "重排中…" : "重排序号"}
          </button>
        </form>
      </header>

      {open ? (
        <div className="px-4 py-3">
          <form action={addAction} className="mb-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="subject" value={subject} />
            <input type="hidden" name="category" value={category} />
            <input
              name="keyword"
              placeholder="新增关键词…"
              className="h-8 min-w-[14rem] flex-1 rounded-md border border-zinc-300 px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="submit"
              disabled={adding}
              className="h-8 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {adding ? "添加中…" : "＋ 添加"}
            </button>
            {addMsg}
            {normMsg}
          </form>

          <ul className="flex flex-col">
            {rows.map((r) => (
              <KeywordItem key={r.id} row={r} />
            ))}
            {rows.length === 0 ? (
              <li className="py-2 text-xs text-zinc-400">该分类暂无关键词</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** 短语库 */
function PhraseBlock({ phrases }: { phrases: PhraseRow[] }) {
  const [addState, addAction, adding] = useActionState(addPhrase, initial);
  const addMsg = useResult(addState);

  return (
    <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <header className="border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          结尾短语库
          <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {phrases.length}
          </span>
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          出现在反馈末尾的常用语，所有用户共享
        </p>
      </header>

      <div className="px-4 py-3">
        <form action={addAction} className="mb-3 flex flex-wrap items-center gap-2">
          <input
            name="phrase"
            placeholder="新增短语…"
            className="h-8 min-w-[16rem] flex-1 rounded-md border border-zinc-300 px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            disabled={adding}
            className="h-8 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {adding ? "添加中…" : "＋ 添加"}
          </button>
          {addMsg}
        </form>

        <ul className="flex flex-col">
          {phrases.map((p) => (
            <PhraseItem key={p.id} row={p} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function PhraseItem({ row }: { row: PhraseRow }) {
  const [updateState, updateAction, updating] = useActionState(updatePhrase, initial);
  const [deleteState, deleteAction, deleting] = useActionState(deletePhrase, initial);
  const updateMsg = useResult(updateState);
  const deleteMsg = useResult(deleteState);

  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-zinc-100 py-1.5 last:border-0 dark:border-zinc-800">
      <form action={updateAction} className="flex flex-1 flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={row.id} />
        <input
          name="phrase"
          defaultValue={row.phrase}
          className="h-7 min-w-[16rem] flex-1 rounded-md border border-zinc-300 px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          disabled={updating || deleting}
          className="h-7 rounded-md border border-zinc-300 px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {updating ? "保存中…" : "保存"}
        </button>
      </form>
      <form action={deleteAction}>
        <input type="hidden" name="id" value={row.id} />
        <button
          type="submit"
          disabled={updating || deleting}
          onClick={(e) => {
            if (!confirm("删除该短语？")) e.preventDefault();
          }}
          className="h-7 rounded-md border border-red-300 px-2 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          {deleting ? "…" : "删除"}
        </button>
      </form>
      {updateMsg}
      {deleteMsg}
    </li>
  );
}

export default function KeywordEditor({ subjects, byCategory, phrases }: Props) {
  const [subject, setSubject] = useState(subjects[0]?.code ?? "math");
  const [filter, setFilter] = useState("");
  const cats = byCategory[subject] ?? {};
  const catNames = Object.keys(cats);
  const total = catNames.reduce((n, c) => n + cats[c].length, 0);

  const visible = catNames.filter((c) => {
    if (!filter.trim()) return true;
    const q = filter.trim().toLowerCase();
    return c.toLowerCase().includes(q) || cats[c].some((r) => r.keyword.toLowerCase().includes(q));
  });

  return (
    <div className="flex flex-col gap-6">
      {/* 科目切换 + 过滤 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {subjects.map((s) => (
            <button
              key={s.code}
              type="button"
              onClick={() => setSubject(s.code)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                subject === s.code
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索分类或关键词…"
            className="h-8 w-56 rounded-md border border-zinc-300 px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="text-xs text-zinc-500 dark:text-zinc-400">当前科目 {total} 个关键词</span>
        </div>
      </div>

      {/* 关键词分类 */}
      <div className="flex flex-col gap-3">
        {visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            没有匹配的分类。
          </p>
        ) : (
          visible.map((c) => (
            <CategoryBlock key={c} subject={subject} category={c} rows={cats[c]} />
          ))
        )}
      </div>

      {/* 短语库 */}
      <PhraseBlock phrases={phrases} />
    </div>
  );
}
