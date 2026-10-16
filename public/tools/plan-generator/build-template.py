# -*- coding: utf-8 -*-
"""把老师给的物理辅导计划样例，改造成本工具的**占位符模板**。

用法：
    python public/tools/plan-generator/build-template.py            # 生成模板（改 模板-占位符.docx）
    python public/tools/plan-generator/build-template.py --check    # 只核对，不写文件

它干三件事：
  1) 源模板（`模板-物理.docx`，由老师那份《锐满分全年班组辅导计划.docx》改制）
     → 把**值**换成 `{{占位符}}`，标签一个字不动
  2) 进度表**只留一行样板行**（第 1 个数据行），其余样例数据行**整行删掉**
     —— 否则那些样例文字会残留在模板里（"宁留空不填错"）
  3) 自检：把生成结果解回来，逐条核对占位符落在**对的格**里、且**没有样例文字残留**

⚠️ 三条硬口径（与 math-plan 的模板同一套）：
  · **只改文字，不动任何格式**：不新建段落/表格、不碰 tblPr/tcW/tblGrid/边框/合并格
  · **标签与占位符必须落在不同的格/run 上**（math-plan 历史上把标签格覆盖掉过一次）
  · 模板里的**每个** `{{...}}` 都必须被程序认识，且程序要填的每个键都必须在模板里有位置
"""
import sys, os, re, json, shutil, zipfile
from docx import Document
from docx.oxml.ns import qn

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "模板-物理.docx")          # 源（老师样例改制而来，格式基准）
OUT = os.path.join(HERE, "模板-占位符.docx")             # 产物
CHECK_ONLY = "--check" in sys.argv

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def q(tag):
    return W + tag


def run_text(r):
    """一个 run 的文字（含 tab/br 的近似表示，仅用于显示）"""
    out = []
    for ch in r:
        if ch.tag == q("t"):
            out.append(ch.text or "")
        elif ch.tag == q("tab"):
            out.append("\t")
        elif ch.tag == q("br"):
            out.append("\n")
    return "".join(out)


def set_run_text(r, text):
    """把 run 的文字改成 text；**保留 run 的全部属性（rPr）**。
    每个 run 只留一个 w:t；多余的 w:t 清空（不删元素，格式与结构最稳）。"""
    ts = r.findall(q("t"))
    if not ts:
        return False
    ts[0].text = text
    # 保留空格（Word 里连续空格会被吞）
    ts[0].set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    for extra in ts[1:]:
        extra.text = ""
    # 顺手清掉同一个 run 里的 tab/br（占位符不该带换行）
    for ch in list(r):
        if ch.tag in (q("tab"), q("br")):
            r.remove(ch)
    return True


def para_runs(p):
    return p.findall(q("r"))


def cell_paras(tc):
    return tc.findall(q("p"))


def cell_runs(tc):
    out = []
    for p in cell_paras(tc):
        out.extend(para_runs(p))
    return out


def cell_text(tc):
    return "".join(t.text or "" for t in tc.iter(q("t")))


def row_cells(tr):
    return tr.findall(q("tc"))


def cell_set_placeholder(tc, placeholder):
    """把整格的内容换成**一个**占位符。

    ⚠️ 三个坑（本轮全踩到了，记下来）：
      ① 不能"把每个 run 都写成占位符" —— 一个格里可能有多个 run，
         那样同一格里会出现 N 个 {{xxx}}（自检会报"重复出现"）。
      ② 「内容」那一格在样例里是**多段**（每个小节一行，有的行还不止一个 run）。
         附件3 里它是**一格纯文本**，所以这里合并成一段。
      ③ **不能只认"第 1 段的第 1 个 run"**：抬头那几格的**值是第 2 段**，
         而首段是个空 run（本轮就把年级值写空了）。所以要找**第一个非空 run**。
    """
    paras = cell_paras(tc)
    if not paras:
        return False
    target = None
    for p in paras:
        for r in para_runs(p):
            if run_text(r).strip():
                target = r
                break
        if target is not None:
            break
    if target is None:      # 整格本来是空的：退化为"第一段的第一个 run"
        for p in paras:
            rs = para_runs(p)
            if rs:
                target = rs[0]
                break
    if target is None:
        return False
    set_run_text(target, placeholder)
    for p in paras:
        for r in para_runs(p):
            if r is not target:
                set_run_text(r, "")
    return True


# ============================================================================
# 1) 逐格替换：{定位条件: 占位符}
# ============================================================================
# 结构（与 inspect-physics-template.py 打出来的完全对应）：
#   正文 para[0]                 标题
#   r00 tc2[1]=年级值 tc4=学科值 tc6=教材版本值 tc7[0]="教师：xxx"
#   r01 tc0                      课时分配（需要课时 {{hours}}h；辅导时间 {{period}}；{{freq}}次/周，{{per}}课时/次）
#   r02 tc1                      「教学方法」那一大段
#   r03                          阶段行（一轮专题复习）—— 删掉（阶段由程序按模块分组填）
#   r04                          表头（固定文字，不动）
#   r05..                         数据行 —— 只留第一行当样板，其余删掉
#   「教管主任签字 / 家长或学员签字」那一行 —— 留着不动（打印后手签）

def build(template_path, out_path, check_only=False):
    doc = Document(template_path)
    tbl = doc.tables[0]
    trs = tbl._tbl.findall(q("tr"))

    log = []

    # ---- 标题：把整段（可能两个 run）变成 {{title}} ----
    # 正文段落里第一段是标题
    title_p = None
    for p in doc.paragraphs:
        if p.text.strip():
            title_p = p._p
            break
    if title_p is not None:
        prs = para_runs(title_p)
        # 第一个 run 放占位符，其余清空（保留格式）
        for i, r in enumerate(prs):
            set_run_text(r, "{{title}}" if i == 0 else "")
        log.append("标题 → {{title}}")

    # ---- r00：年级 / 学科 / 教材版本 / 教师 ----
    r00 = row_cells(trs[0])
    cell_set_placeholder(r00[2], "{{grade}}")      # 年级值
    cell_set_placeholder(r00[4], "{{subj}}")       # 学科值
    cell_set_placeholder(r00[6], "{{book}}")       # 教材版本值
    # tc7 = "教师：王宇晨"（连标签一起换成占位符）：
    #   ⚠️ 标签只能有一个来源 —— 这里定"由程序写标签「教师：」"，模板这格不再自带标签。
    cell_set_placeholder(r00[7], "{{teacher}}")
    log.append("抬头：年级/学科/教材版本/教师 四格 → 占位符")

    # ---- r01：课时分配那句话 ----
    cell_set_placeholder(row_cells(trs[1])[0], "{{hoursLine}}")
    log.append("课时分配那句 → {{hoursLine}}（整句由程序拼，标签只有一个来源）")

    # ---- r02：教学方法（那一大段） ----
    r02 = row_cells(trs[2])
    cell_set_placeholder(r02[1] if len(r02) > 1 else r02[0], "{{method}}")
    log.append("教学方法 → {{method}}")

    # ---- 数据行范围：表头是含「课时数」的那一行；数据行从它下面开始 ----
    header_idx = None
    for i, tr in enumerate(trs):
        txt = "".join(cell_text(tc) for tc in row_cells(tr))
        if "课时数" in txt and "教学目标" in txt:
            header_idx = i
            break
    if header_idx is None:
        raise SystemExit("找不到进度表表头行（含「课时数」与「教学目标」）")

    # 表头上面那一段里，样例的阶段分隔行（"一轮专题复习"）—— 删掉（阶段由程序按模块分组填）
    if header_idx >= 2:
        prev = trs[header_idx - 1]
        if len(row_cells(prev)) <= 2 and "{{" not in cell_text(prev):
            prev.getparent().remove(prev)
            log.append("删掉表头上面的阶段分隔行（阶段由程序按模块分组填）")

    # 表头下面的行：可能是 ① 真实数据行（≥4 格）② 样例的阶段分隔行（≤2 格）
    # ③ 签字行（≤2 格，但**要留着**）
    # ⚠️ 判据（本轮踩过）：**不能只看格数** —— 样例里「二轮大专题复习：…」那种阶段分隔行
    #    也在表头下面，只按"≥4 格"筛会把它漏掉 ⇒ 样例文字残留在模板里。
    #    真正的判据是"里面有没有占位符"：阶段分隔行**没有**占位符 ⇒ 一律删掉。
    below = trs[header_idx + 1:]
    real_rows = [tr for tr in below if len(row_cells(tr)) >= 4]
    if not real_rows:
        raise SystemExit("找不到进度表数据行（4 格的行）")

    # ---- 第一个数据行 → 样板行（s1）：阶段/课时数/内容/目标都放占位符 ----
    # ⚠️ 一律走 `cell_set_placeholder`（找第一个**非空** run，其余清空）——
    #    这里第一版是"每段首个 run 都写占位符"，于是「内容」那格（4 段）出现 4 个 {{s1_ct}}。
    keep = real_rows[0]
    kcs = row_cells(keep)
    for tc, ph in ((kcs[0], "{{s1_st}}"), (kcs[1], "{{s1_ct}}"),
                   (kcs[2], "{{s1_hr}}"), (kcs[3], "{{s1_ob}}")):
        cell_set_placeholder(tc, ph)
    log.append("第一个数据行 → 样板行 {{s1_st}} / {{s1_ct}} / {{s1_hr}} / {{s1_ob}}")

    # ---- 其余真实数据行 + 表头下面的所有阶段分隔行：整行删掉（样例文字一个字不留） ----
    removed_data, removed_sep = 0, 0
    for tr in below:
        if tr is keep:
            continue
        if len(row_cells(tr)) >= 4:
            tr.getparent().remove(tr)
            removed_data += 1
        elif "{{" not in cell_text(tr):
            tr.getparent().remove(tr)
            removed_sep += 1
    log.append("删掉其余 %d 个样例数据行 + %d 个阶段分隔行（只留一行样板 + 签字行）"
               % (removed_data, removed_sep))

    if check_only:
        return doc, log

    doc.save(out_path)
    return doc, log


# ============================================================================
# 2) 自检：把产物解回来，逐条核对
# ============================================================================
REQUIRED_PLACEHOLDERS = ["{{title}}", "{{grade}}", "{{subj}}", "{{book}}", "{{teacher}}",
                         "{{hoursLine}}", "{{method}}",
                         "{{s1_st}}", "{{s1_ct}}", "{{s1_hr}}", "{{s1_ob}}"]
# 模板里**不该残留**的样例文字（老师那份里的原文片段）
SAMPLE_LEAKS = ["锐满分", "王宇晨", "213h", "运动的描述", "1.1质点", "2026年9月",
                "一轮专题复习", "高考真题"]


def check(path):
    problems = []
    d = Document(path)
    t = d.tables[0]
    trs = t._tbl.findall(q("tr"))

    # 全文字（含段落与所有单元格）
    alltext_parts = [p.text for p in d.paragraphs]
    for tr in trs:
        for tc in row_cells(tr):
            alltext_parts.append(cell_text(tc))
    alltext = "\n".join(alltext_parts)

    # ① 该有的占位符一个不少
    for ph in REQUIRED_PLACEHOLDERS:
        if ph not in alltext:
            problems.append("缺少占位符 %s" % ph)

    # ② 数据行只剩 1 个 4 格的样板行
    hi = None
    for i, tr in enumerate(trs):
        txt = "".join(cell_text(tc) for tc in row_cells(tr))
        if "课时数" in txt and "教学目标" in txt:
            hi = i
            break
    if hi is None:
        problems.append("找不到表头行")
    else:
        datarows = [tr for tr in trs[hi + 1:] if len(row_cells(tr)) >= 4]
        if len(datarows) != 1:
            problems.append("数据行应该只剩 1 个样板行，实际 %d 个" % len(datarows))

    # ③ 没有样例文字残留
    for s in SAMPLE_LEAKS:
        if s in alltext:
            problems.append("样例文字残留：%r" % s)

    # ④ 表头标签还在（标签由模板提供，不能被覆盖掉）
    for label in ["阶段（章节/单元/模块）", "内容（包括阶段检测）", "课时数", "教学目标"]:
        if label not in alltext:
            problems.append("表头标签丢了：%s" % label)
    # ⚠️ 抬头标签以**源模板实际写法**为准：老师那份写的是「学生年级」（不是「学段」）
    for label in ["学生年级", "教材版本"]:
        if label not in alltext:
            problems.append("抬头标签丢了：%s" % label)

    # ⑤ 占位符必须落在 run 的完整文字里（不能被 Word 拆散到多个 run），
    #    而且**同一个格里同一个占位符不许出现两次**（本轮踩过：一格 4 个 run 全被写成 {{s1_ct}}）
    split = []
    for tr in trs:
        for tc in row_cells(tr):
            seen_in_cell = {}
            for p in cell_paras(tc):
                for r in para_runs(p):
                    txt = run_text(r)
                    if "{{" in txt and "}}" not in txt:
                        split.append(txt)
                    if "}}" in txt and "{{" not in txt:
                        split.append(txt)
                    for ph in re.findall(r"\{\{[^}]+\}\}", txt):
                        seen_in_cell[ph] = seen_in_cell.get(ph, 0) + 1
            for ph, n in seen_in_cell.items():
                if n > 1:
                    split.append("%s 在同一个格里出现 %d 次" % (ph, n))
    if split:
        problems.append("占位符有问题：%s" % split[:3])

    # ⑥ 格式指纹：表格边框 / 页面尺寸 / 合并格数量
    docxml = zipfile.ZipFile(path).read("word/document.xml").decode("utf-8")
    fp = {
        "tblBorders": docxml.count("<w:tblBorders>"),
        "gridSpan": docxml.count("<w:gridSpan"),
        "vMerge": docxml.count("<w:vMerge"),
        "tbl": docxml.count("<w:tbl>"),
        "tr": docxml.count("<w:tr>") + docxml.count("<w:tr "),
        "tc": docxml.count("<w:tc>"),
        "pgSz": docxml.count("<w:pgSz"),
        "占位符个数": len(re.findall(r"\{\{[^}]+\}\}", docxml)),
    }
    return problems, fp, alltext


# 「格式」相关的零件：只改了文字的话，这些**必须逐字节不变**
FORMAT_PARTS = ["word/styles.xml", "word/theme/theme1.xml", "word/fontTable.xml",
                "word/settings.xml", "[Content_Types].xml", "_rels/.rels",
                "word/_rels/document.xml.rels"]


def canon_xml(text):
    """把 XML 归一化成"可比较的语义形式"：
      · 去掉声明与注释
      · 压掉标签之间的空白与多余空格
      · **把顶层元素排序** —— `[Content_Types].xml` 里 `<Default>` 的顺序会被 python-docx 调换，
        但语义完全一样（本轮就因为"只比字符串"假红过一次）。
    """
    t = re.sub(r"<\?xml[^>]*\?>", "", text)
    t = re.sub(r"<!--.*?-->", "", t, flags=re.S)
    t = re.sub(r">\s+<", "><", t)
    t = re.sub(r"\s+", " ", t).strip()
    # 顶层元素（shape：<Types>…</Types>）里把同级子元素排序
    m = re.match(r"^(<([A-Za-z:]+)[^>]*>)(.*)(</\2>)$", t)
    if m:
        head, body, tail = m.group(1), m.group(3), m.group(4)
        # 按"非嵌套的 '<...>' 段"切开再排序（这些文件里子元素都是自闭合/单层）
        parts = re.findall(r"<[^>]+>", body)
        if "".join(parts) == body:
            t = head + "".join(sorted(parts)) + tail
    return t


def verify_docx_readable(path):
    """用标准库证明产物是**结构完好**的 docx（不是坏文件）：
      · 能被 zipfile 打开、且所有零件 CRC 正确（`testzip()` 返回 None）
      · 每个 `.xml` / `.rels` 零件都能被 `xml.etree` 解析（标签闭合、命名空间合法）
      · `word/document.xml` 的根元素是 `w:document`
    ⚠️ 本机没有 LibreOffice，所以没法"渲染成 PDF 看一眼"；
       Word 能否打开最终要**用户在 Word 里目测**（这一点在交付时要说清）。
    """
    import xml.etree.ElementTree as ET
    problems = []
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        return ["打不开这个 docx：%s" % e]
    bad = z.testzip()
    if bad is not None:
        problems.append("零件 CRC 校验失败：%s" % bad)
    for n in z.namelist():
        if not n.endswith("/") and re.search(r"\.(xml|rels)$", n, re.I):
            try:
                ET.fromstring(z.read(n))
            except Exception as e:
                problems.append("零件 XML 不合法 %s：%s" % (n, e))
    try:
        root = ET.fromstring(z.read("word/document.xml"))
        tag = root.tag.split("}")[-1]
        if tag != "document":
            problems.append("word/document.xml 的根元素是 %s（应为 document）" % tag)
    except Exception as e:
        problems.append("读不了 word/document.xml：%s" % e)
    return problems


def compare_parts(src_path, out_path):
    """对比"格式类零件"的内容是否**等价**。

    ⚠️ 不能说"逐字节不变"（第一版就这么断言，结果假红了）：
       `python-docx` 保存时会**重写整个包** —— XML 声明、标签间空白、属性顺序都会变，
       连 `[Content_Types].xml` / `.rels` 都会被重新序列化。
       但那只影响**字节**，不影响**内容**。所以这里比的是**归一化后的 XML**：
         · 除了 `word/document.xml`（编辑发生在这里），其余零件的 XML 必须等价
         · `word/document.xml` 另比"格式指纹"（边框/合并格/页面尺寸/表格数）
    """
    a = zipfile.ZipFile(src_path)
    b = zipfile.ZipFile(out_path)
    names_a = sorted(n for n in a.namelist() if not n.endswith("/"))
    names_b = sorted(n for n in b.namelist() if not n.endswith("/"))
    problems = []
    if names_a != names_b:
        only_a = [n for n in names_a if n not in names_b]
        only_b = [n for n in names_b if n not in names_a]
        problems.append("零件清单变了：少了 %s / 多了 %s" % (only_a, only_b))

    changed = []
    for n in FORMAT_PARTS:
        if n in names_a and n in names_b:
            da, db = a.read(n), b.read(n)
            if da == db:
                continue      # 一模一样最好
            # 不一样就比 XML 归一化后的内容（都是 .xml/.rels，按 utf-8 解）
            if canon_xml(da.decode("utf-8", "ignore")) != canon_xml(db.decode("utf-8", "ignore")):
                changed.append(n)
    if changed:
        problems.append("格式类零件的内容真的被改动了：%s" % changed)
    return problems


# ============================================================================
def main():
    if not os.path.exists(TEMPLATE):
        raise SystemExit("找不到源模板：%s\n（请先把老师那份《锐满分全年班组辅导计划.docx》复制成 模板-物理.docx）" % TEMPLATE)

    if CHECK_ONLY:
        # ⚠️ 检查的是**产物**（模板-占位符.docx），不是源模板 ——
        #    源模板本来就是老师那份样例，里面当然全是样例文字（第一版指错了对象，白红一片）。
        target = OUT if os.path.exists(OUT) else TEMPLATE
        problems, fp, _ = check(target)
        print("检查对象：", target)
        print("占位符/格式指纹：", json.dumps(fp, ensure_ascii=False))
        if target == OUT:
            problems += compare_parts(TEMPLATE, OUT) + verify_docx_readable(OUT)
        if problems:
            print("[FAIL] 问题：")
            for p in problems:
                print("   -", p)
            raise SystemExit(1)
        print("[OK] 模板检查通过")
        return

    doc, log = build(TEMPLATE, OUT)
    print("改造步骤：")
    for x in log:
        print("   ·", x)
    print("已写出：", OUT, os.path.getsize(OUT), "字节")

    problems, fp, _ = check(OUT)
    print()
    print("格式指纹：", json.dumps(fp, ensure_ascii=False))

    # 与源模板比"格式类零件"的内容等价性
    fmt_problems = compare_parts(TEMPLATE, OUT)
    if fmt_problems:
        print()
        print("[FAIL] 格式零件检查：")
        for p in fmt_problems:
            print("   -", p)
        problems = problems + fmt_problems

    # 产物必须是"结构完好"的 docx（能被解析、CRC 正确）
    readable = verify_docx_readable(OUT)
    if readable:
        print()
        print("[FAIL] 产物不是完好的 docx：")
        for p in readable:
            print("   -", p)
        problems = problems + readable

    print()
    if problems:
        print("[FAIL] 自检失败：")
        for p in problems:
            print("   -", p)
        raise SystemExit(1)
    print("[OK] 自检通过：占位符齐全、落在单个 run 里、样例文字零残留、表头标签完整、"
          "格式类零件内容等价（只改了 document.xml 的文字）、产物是结构完好的 docx")
    print()
    print("注意：本机没有 LibreOffice，无法渲染成 PDF 目测；Word 里的排版效果请老师在 Word 里开一眼。")


if __name__ == "__main__":
    main()
