# -*- coding: utf-8 -*-
"""把公司原件（一个文件里三个附件）切成三个独立模板。

做法：从原件**复制**一份，然后只删掉"不属于该附件"的块 ——
styles.xml / theme / fontTable / sectPr（页面与页边距）**原样保留**，
所以字体、表格线、合并格、行高与原件完全一致（这是"格式必须严格照抄"的关键）。

用法：
  python split-company-template.py <原件.docx> <输出目录>
"""
import os
import shutil
import sys

from docx import Document
from docx.oxml.ns import qn

SRC = sys.argv[1]
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)

# 附件号 -> 该附件对应的表格下标（0=附件1，1=附件2，2=附件3）
ATTACHMENTS = [("附件1", 0), ("附件2", 1), ("附件3", 2)]


def body_blocks(doc):
    """按顺序列出 body 下的 w:p / w:tbl 元素"""
    out = []
    for child in doc.element.body.iterchildren():
        if child.tag in (qn('w:p'), qn('w:tbl')):
            out.append(child)
    return out


for name, table_idx in ATTACHMENTS:
    dst = os.path.join(OUT, name + ".docx")
    shutil.copyfile(SRC, dst)                 # 先整份复制（保住所有零件）
    doc = Document(dst)

    tables = [b for b in body_blocks(doc) if b.tag == qn('w:tbl')]
    if len(tables) <= table_idx:
        raise SystemExit("原件里表格数量不对：%d" % len(tables))
    keep = tables[table_idx]

    removed = 0
    for b in body_blocks(doc):
        if b is keep:
            continue
        b.getparent().remove(b)
        removed += 1
    doc.save(dst)

    # 立刻复核
    chk = Document(dst)
    t = chk.tables[0]
    print("%s: 表格 %d行 x %d列 | 段落 %d 个 | 删掉 %d 个块 | 节 %d 个 | 页面 %.1fcm x %.1fcm %s"
          % (name, len(t.rows), len(t.columns), len(chk.paragraphs), removed,
             len(chk.sections), chk.sections[0].page_width.cm, chk.sections[0].page_height.cm,
             chk.sections[0].orientation))
print("输出目录:", OUT)
