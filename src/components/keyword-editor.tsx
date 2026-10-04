"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addChapter,
  addKeyword,
  addPhrase,
  addTextbook,
  deleteChapter,
  deleteKeyword,
  deletePhrase,
  deleteTextbook,
  normalizeCategory,
  updateChapter,
  updateKeyword,
  updatePhrase,
  updateTextbook,
  type KeywordActionResult,
} from "@/app/admin/feedback-keywords/actions";

const initial: KeywordActionResult = { status: "idle" };

export type KeywordRowView = {
  id: number;
  subject: string;
  category: string;
  keyword: string;
  sort_order: number;
  chapter_id: number | null;
};

export type PhraseRow = { id: number; phrase: string; sort_order: number };
export type TextbookView = { id: number; version: string; name: string };
export type ChapterView = { id: number; name: string };

/** 册次占位符：该版本没有册次之分 */
const NO_VOLUME = "-";
const volumeLabel = (name: string) => (name === NO_VOLUME ? "" : name);
const displayName = (t: TextbookView) =>
  volumeLabel(t.name) ? `${t.version} · ${t.name}` : t.version;

type Props = {
  stage: "senior" | "junior";
  subject: string | null;
  textbookId: number | null;
  chapterId: number | null;
  /** 该学段可用的科目（含显示名） */
  subjects: { code: string; name: string }[];
  /** 当前学段+科目下的教材 */
  textbooks: TextbookView[];
  /** 当前教材下的章节 */
  chapters: ChapterView[];
  /** 当前维度的关键词（已按分类分组） */
  byCategory: Record<string, KeywordRowView[]>;
  /** 分类顺序（来自数据库） */
  categoryNames: string[];
  phrases: PhraseRow[];
  /** 全库统计（未选科目时展示） */
  summary: { total: number; archived: number; textbooks: number; chapters: number; categories: number };
};

const selCls =
  "h-9 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

function useResult(result: KeywordActionResult) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (result.status === "idle") return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 5000);
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

/** 级联选择器：学段 → 科目 → 教材 → 章节 */
function Picker({
  stage,
  subject,
  textbookId,
  chapterId,
  subjects,
  textbooks,
  chapters,
  generalOnly,
  onGeneralOnlyChange,
}: {
  stage: "senior" | "junior";
  subject: string | null;
  textbookId: number | null;
  chapterId: number | null;
  subjects: { code: string; name: string }[];
  textbooks: TextbookView[];
  chapters: ChapterView[];
  generalOnly: boolean;
  onGeneralOnlyChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const push = (next: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | null> = {
      stage,
      subject,
      textbook: textbookId ? String(textbookId) : null,
      chapter: chapterId ? String(chapterId) : null,
      ...next,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v) params.set(k, v);
    }
    if (params.get("stage") === "senior") params.delete("stage"); // 高中是默认值
    const qs = params.toString();
    startTransition(() => router.push(`/admin/feedback-keywords${qs ? `?${qs}` : ""}`));
  };

  // 当前选中的教材
  const current = textbookId ? textbooks.find((t) => t.id === textbookId) ?? null : null;
  // 版本 → 该版本下的册次
  const versions: string[] = [];
  for (const t of textbooks) if (!versions.includes(t.version)) versions.push(t.version);
  const currentVersion = current?.version ?? "";
  const volumesOfVersion = currentVersion ? textbooks.filter((t) => t.version === currentVersion) : [];

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      {/* 学段 */}
      <div className="flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
        {(["senior", "junior"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => push({ stage: s === "senior" ? null : s, subject: null, textbook: null, chapter: null })}
            className={`h-9 px-3 text-sm font-medium transition ${
              stage === s
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            {s === "senior" ? "高中" : "初中"}
          </button>
        ))}
      </div>

      {/* 科目 */}
      <select
        value={subject ?? ""}
        onChange={(e) => push({ subject: e.target.value || null, textbook: null, chapter: null })}
        className={selCls}
        aria-label="科目"
      >
        <option value="">选择科目…</option>
        {subjects.map((s) => (
          <option key={s.code} value={s.code}>
            {s.name}
          </option>
        ))}
      </select>

      {/* 教材版本 */}
      {subject && textbooks.length > 0 ? (
        <select
          value={currentVersion}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return push({ textbook: null, chapter: null });
            const inVersion = textbooks.filter((t) => t.version === v);
            // 该版本只有一本 → 直接选中；否则先选中第一本（册次下拉会跟着出现）
            push({ textbook: inVersion[0] ? String(inVersion[0].id) : null, chapter: null });
          }}
          className={`${selCls} min-w-[11rem]`}
          aria-label="教材版本"
        >
          <option value="">选择教材版本…</option>
          {versions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : null}

      {/* 册次（该版本只有一本且无册次名时不显示） */}
      {currentVersion && volumesOfVersion.filter((t) => volumeLabel(t.name)).length > 1 ? (
        <select
          value={textbookId ? String(textbookId) : ""}
          onChange={(e) => push({ textbook: e.target.value || null, chapter: null })}
          className={`${selCls} min-w-[11rem]`}
          aria-label="册次"
        >
          {volumesOfVersion.map((t) => (
            <option key={t.id} value={t.id}>
              {volumeLabel(t.name) || t.version}
            </option>
          ))}
        </select>
      ) : null}

      {/* 章节（选了教材才出现） */}
      {textbookId && chapters.length > 0 ? (
        <select
          value={chapterId ? String(chapterId) : ""}
          onChange={(e) => push({ chapter: e.target.value || null })}
          className={`${selCls} min-w-[13rem]`}
          aria-label="章节"
        >
          <option value="">选择章节…</option>
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      ) : null}

      {current ? (
        <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {displayName(current)}
        </span>
      ) : null}

      {subject ? (
        <label className="ml-auto flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={generalOnly}
            onChange={(e) => onGeneralOnlyChange(e.target.checked)}
            className="size-4"
          />
          只看通用分类
        </label>
      ) : null}

      {pending ? <span className="text-xs text-zinc-400">载入中…</span> : null}
    </div>
  );
}

/** 单个关键词：改文字 / 改排序 / 删除 */
function KeywordItem({ row, scope }: { row: KeywordRowView; scope: Record<string, string> }) {
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
          className="h-7 w-16 rounded-md border border-zinc-300 px-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
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
      <span className="hidden">{Object.keys(scope).length}</span>
    </li>
  );
}

/** 一个分类：标题 + 新增表单 + 关键词列表 */
function CategoryBlock({
  subject,
  category,
  rows,
  scopeFields,
}: {
  subject: string;
  category: string;
  rows: KeywordRowView[];
  scopeFields: Record<string, string>;
}) {
  const [addState, addAction, adding] = useActionState(addKeyword, initial);
  const [normState, normAction, normalizing] = useActionState(normalizeCategory, initial);
  const addMsg = useResult(addState);
  const normMsg = useResult(normState);
  const [open, setOpen] = useState(rows.length > 0);

  const hidden = Object.entries(scopeFields).map(([k, v]) => (
    <input key={k} type="hidden" name={k} value={v} />
  ));

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
          {hidden}
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
            {hidden}
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
              <KeywordItem key={r.id} row={r} scope={scopeFields} />
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

/** 教材 / 章节管理（改名、删、加） */
function TextbookAdmin({
  stage,
  subject,
  textbooks,
  chapters,
  textbookId,
}: {
  stage: string;
  subject: string;
  textbooks: TextbookView[];
  chapters: ChapterView[];
  textbookId: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [addTbState, addTbAction, addingTb] = useActionState(addTextbook, initial);
  const [addChState, addChAction, addingCh] = useActionState(addChapter, initial);
  const tbMsg = useResult(addTbState);
  const chMsg = useResult(addChState);

  return (
    <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <header className="border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100"
        >
          <span className="text-xs text-zinc-400">{open ? "▼" : "▶"}</span>
          教材与章节管理
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {textbooks.length} 本 / {chapters.length} 章
          </span>
        </button>
      </header>

      {open ? (
        <div className="flex flex-col gap-4 px-4 py-3">
          <div>
            <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
              教材（可改名/改排序/删除；删除会级联删除其章节）
            </p>
            <form action={addTbAction} className="mb-2 flex flex-wrap items-center gap-2">
              <input type="hidden" name="stage" value={stage} />
              <input type="hidden" name="subject" value={subject} />
              <input
                name="version"
                list="tb-version-options"
                placeholder="版本（如 人教版）"
                className="h-8 w-40 rounded-md border border-zinc-300 px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <datalist id="tb-version-options">
                {[...new Set(textbooks.map((t) => t.version))].map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
              <input
                name="name"
                placeholder="册次（如 必修第一册；留空表示无册次）"
                className="h-8 min-w-[16rem] flex-1 rounded-md border border-zinc-300 px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="submit"
                disabled={addingTb}
                className="h-8 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {addingTb ? "添加中…" : "＋ 添加教材"}
              </button>
              {tbMsg}
            </form>
            <ul className="flex flex-col">
              {textbooks.map((t) => (
                <TextbookRow key={t.id} row={t} isCurrent={t.id === textbookId} />
              ))}
            </ul>
          </div>

          {textbookId ? (
            <div>
              <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                章节（属于当前选中的教材）
              </p>
              <form action={addChAction} className="mb-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="textbookId" value={textbookId} />
                <input
                  name="name"
                  placeholder="新增章节名…"
                  className="h-8 min-w-[14rem] flex-1 rounded-md border border-zinc-300 px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
                <button
                  type="submit"
                  disabled={addingCh}
                  className="h-8 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  {addingCh ? "添加中…" : "＋ 添加章节"}
                </button>
                {chMsg}
              </form>
              <ul className="flex flex-col">
                {chapters.map((c) => (
                  <ChapterRowItem key={c.id} row={c} />
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-zinc-400">先选择一个教材，才能管理它的章节。</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function TextbookRow({ row, isCurrent }: { row: TextbookView; isCurrent: boolean }) {
  const [updateState, updateAction, updating] = useActionState(updateTextbook, initial);
  const [deleteState, deleteAction, deleting] = useActionState(deleteTextbook, initial);
  const updateMsg = useResult(updateState);
  const deleteMsg = useResult(deleteState);

  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-zinc-100 py-1.5 last:border-0 dark:border-zinc-800">
      <form action={updateAction} className="flex flex-1 flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={row.id} />
        <input
          name="version"
          defaultValue={row.version}
          placeholder="版本"
          className="h-7 w-36 rounded-md border border-zinc-300 px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <input
          name="name"
          defaultValue={volumeLabel(row.name)}
          placeholder="册次（留空表示无册次）"
          className="h-7 min-w-[14rem] flex-1 rounded-md border border-zinc-300 px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
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
            if (!confirm(`删除教材「${displayName(row)}」？其章节会一并删除。`)) e.preventDefault();
          }}
          className="h-7 rounded-md border border-red-300 px-2 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          {deleting ? "…" : "删除"}
        </button>
      </form>
      {isCurrent ? <span className="text-xs text-emerald-600 dark:text-emerald-400">当前</span> : null}
      {updateMsg}
      {deleteMsg}
    </li>
  );
}

function ChapterRowItem({ row }: { row: ChapterView }) {
  const [updateState, updateAction, updating] = useActionState(updateChapter, initial);
  const [deleteState, deleteAction, deleting] = useActionState(deleteChapter, initial);
  const updateMsg = useResult(updateState);
  const deleteMsg = useResult(deleteState);

  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-zinc-100 py-1.5 last:border-0 dark:border-zinc-800">
      <form action={updateAction} className="flex flex-1 flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={row.id} />
        <input
          name="name"
          defaultValue={row.name}
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
            if (!confirm(`删除章节「${row.name}」？该章节的关键词不会被删除。`)) e.preventDefault();
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
          出现在反馈末尾的常用语，所有用户共享、不分科目
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

export default function KeywordEditor({
  stage,
  subject,
  textbookId,
  chapterId,
  subjects,
  textbooks,
  chapters,
  byCategory,
  categoryNames,
  phrases,
  summary,
}: Props) {
  const [generalOnly, setGeneralOnly] = useState(false);

  const scopeFields: Record<string, string> = {};
  if (stage) scopeFields.stage = stage;
  if (subject) scopeFields.subject = subject;
  if (textbookId) scopeFields.textbookId = String(textbookId);
  if (chapterId) scopeFields.chapterId = String(chapterId);
  const chapterName = chapters.find((c) => c.id === chapterId)?.name;
  if (chapterName) scopeFields.chapterName = chapterName;

  // ---------- 未选科目：显示全库概况 + 短语库 ----------
  if (!subject) {
    return (
      <div className="flex flex-col gap-6">
        <Picker
          stage={stage}
          subject={subject}
          textbookId={textbookId}
          chapterId={chapterId}
          subjects={subjects}
          textbooks={textbooks}
          chapters={chapters}
          generalOnly={generalOnly}
          onGeneralOnlyChange={setGeneralOnly}
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: "关键词", value: summary.total },
            { label: "已归档", value: summary.archived },
            { label: "通用分类", value: summary.categories },
            { label: "教材", value: summary.textbooks },
            { label: "章节", value: summary.chapters },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{s.label}</p>
              <p className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{s.value}</p>
            </div>
          ))}
        </div>
        <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          请先在上方选择「学段 → 科目」开始编辑关键词。
        </p>
        <PhraseBlock phrases={phrases} />
      </div>
    );
  }

  const isChapterMode = !generalOnly && chapterId !== null;
  const contentCats = categoryNames.filter((c) => c === "课堂内容" || c === "下节课内容");
  const otherCats = categoryNames.filter((c) => c !== "课堂内容" && c !== "下节课内容");
  const visibleCats = generalOnly ? categoryNames : textbookId || chapterId ? contentCats : categoryNames;

  const totalInScope = visibleCats.reduce((n, c) => n + (byCategory[c]?.length ?? 0), 0);

  return (
    <div className="flex flex-col gap-6">
      <Picker
        stage={stage}
        subject={subject}
        textbookId={textbookId}
        chapterId={chapterId}
        subjects={subjects}
        textbooks={textbooks}
        chapters={chapters}
        generalOnly={generalOnly}
        onGeneralOnlyChange={setGeneralOnly}
      />

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {isChapterMode ? (
          <>
            正在编辑章节「<span className="font-medium text-zinc-700 dark:text-zinc-200">{chapterName}</span>
            」的关键词（课堂内容 / 下节课内容 两个分类）。这两个分类的章节词在数据库中成对存在，新增时会一起补齐。
          </>
        ) : textbookId ? (
          <>已选教材，显示该教材下全部章节的关键词。再选一个具体章节可编辑该章。</>
        ) : (
          <>未选教材，显示该科目的通用分类关键词。{contentCats.length ? "「课堂内容 / 下节课内容」这里是「不分章节」的通用内容词。" : ""}</>
        )}{" "}
        当前共 {totalInScope} 个。
      </p>

      {!generalOnly && textbookId && chapters.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => {
              const params = new URLSearchParams();
              params.set("stage", stage);
              params.set("subject", subject);
              params.set("textbook", String(textbookId));
              const qs = params.toString();
              window.location.href = `/admin/feedback-keywords?${qs}`;
            }}
            className={`rounded-lg px-2.5 py-1 text-xs ${
              chapterId === null
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            全部章节
          </button>
          {chapters.map((c) => {
            const params = new URLSearchParams();
            params.set("stage", stage);
            params.set("subject", subject);
            params.set("textbook", String(textbookId));
            params.set("chapter", String(c.id));
            return (
              <a
                key={c.id}
                href={`/admin/feedback-keywords?${params.toString()}`}
                className={`rounded-lg px-2.5 py-1 text-xs ${
                  chapterId === c.id
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                }`}
              >
                {c.name}
              </a>
            );
          })}
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        {visibleCats.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            没有可显示的分类。
          </p>
        ) : (
          visibleCats.map((c) => (
            <CategoryBlock
              key={c}
              subject={subject}
              category={c}
              rows={byCategory[c] ?? []}
              scopeFields={scopeFields}
            />
          ))
        )}
      </div>

      {!generalOnly ? (
        <TextbookAdmin
          stage={stage}
          subject={subject}
          textbooks={textbooks}
          chapters={chapters}
          textbookId={textbookId}
        />
      ) : null}

      <PhraseBlock phrases={phrases} />
    </div>
  );
}
