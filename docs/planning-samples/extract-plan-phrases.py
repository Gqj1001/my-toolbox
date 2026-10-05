# -*- coding: utf-8 -*-
"""
阶段C：从 M 盘辅导方案 docx 里抽取「教学方法」与「逐次课表 · 教学目标」原文。
只读 M 盘；输出到 D:/my-website/.tmp-planning-samples/（仓库外，不进 git）。
"""
import os, json, re
from docx import Document

SRC = r"M:\学生文件"
OUT = r"D:\my-website\.tmp-planning-samples"
os.makedirs(OUT, exist_ok=True)

targets = []
for root, dirs, files in os.walk(SRC):
    for f in files:
        if f.lower().endswith(".docx") and "方案" in f:
            targets.append(os.path.join(root, f))
targets.sort()

def norm(s):
    return re.sub(r"\s+", "", s or "")

def rows_of(doc):
    """扁平化：按文档顺序返回 [(第一格文本, 整行去重单元格列表)]，含嵌套表"""
    out = []
    def walk(container):
        for child in container.iterchildren():
            if child.tag.split("}")[-1] == "tbl":
                from docx.table import Table
                tb = Table(child, doc)
                for r in tb.rows:
                    cells, prev = [], None
                    for c in r.cells:
                        t = c.text.strip()
                        if t != prev:
                            cells.append(t)
                        prev = t
                    if cells:
                        out.append(cells)
                    for c in r.cells:
                        walk(c._element)
    walk(doc.element.body)
    return out

def extract(path):
    doc = Document(path)
    rows = rows_of(doc)
    method_text = ""
    goals = []
    goal_col = None
    seen_goal_header = False

    for cells in rows:
        first = norm(cells[0]) if cells else ""
        # ---- 教学方法：第一格是「教学方法」，内容在最后一格 ----
        if first.startswith("教学方法") and not method_text:
            body = cells[-1] if len(cells) > 1 else ""
            if norm(body) != "教学方法":
                method_text = body.strip()
            continue
        # ---- 逐次课表表头：定位「教学目标」列 ----
        if any("教学目标" in norm(c) for c in cells):
            for i, c in enumerate(cells):
                if "教学目标" in norm(c):
                    goal_col = i
                    break
            seen_goal_header = True
            continue
        # ---- 课表数据行 ----
        if seen_goal_header and goal_col is not None and len(cells) > goal_col:
            g = cells[goal_col].strip()
            if not g:
                continue
            if g in ("教学目标",) or norm(g).startswith("每次课"):
                continue
            if norm(g).startswith(("合计", "本方案", "共")):
                continue
            goals.append(g)

    return method_text, goals

records = []
for p in targets:
    rel = os.path.relpath(p, SRC)
    try:
        m, g = extract(p)
        records.append({"file": rel, "method": m, "goals": g,
                        "method_len": len(m), "goal_count": len(g)})
    except Exception as e:
        records.append({"file": rel, "method": "", "goals": [], "method_len": 0,
                        "goal_count": 0, "error": str(e)[:200]})

with open(os.path.join(OUT, "raw-extract.json"), "w", encoding="utf-8") as f:
    json.dump(records, f, ensure_ascii=False, indent=1)

ok_m = sum(1 for r in records if r["method_len"] > 0)
ok_g = sum(1 for r in records if r["goal_count"] > 0)
print(f"total={len(records)} with_method={ok_m} with_goals={ok_g}")
