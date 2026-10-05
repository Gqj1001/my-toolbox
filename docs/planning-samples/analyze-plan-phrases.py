# -*- coding: utf-8 -*-
"""阶段C：更严谨的高频措辞统计（只看教学方法正文 + 教学目标列）"""
import os, re, json, io, sys
from collections import Counter

OUT = r"D:\my-website\.tmp-planning-samples"
recs = json.load(open(os.path.join(OUT, "raw-extract.json"), encoding="utf-8"))
buf = io.StringIO()

def norm(s):
    return re.sub(r"\s+", "", s or "")

methods = [(r["file"], r["method"]) for r in recs if r.get("method")]
goals_all = []
for r in recs:
    for g in r.get("goals", []):
        goals_all.append((r["file"], g))

print(f"教学方法样本: {len(methods)} 份；教学目标样本: {len(goals_all)} 条", file=buf)

# ---------- 1. 修辞/固定表达（人工可读的措辞清单） ----------
PHRASES = [
    "本方案针对", "此方案为", "本方案核心目标", "核心短板为", "核心痛点在于", "核心痛点",
    "学情", "学情诊断", "基础扎实", "基础不错", "基础一般", "基础薄弱", "零基础",
    "无明显漏洞", "知识盲区", "不是知识盲区", "而非知识盲区",
    "课堂采用", "教学模式", "教学策略是", "五环节流程", "标准流程", "2小时标准流程",
    "知识梳理", "知识框架梳理", "核心模型梳理", "重点知识梳理", "典例精讲", "变式训练",
    "变式题组", "限时小测", "归纳总结", "订正小结", "典型错题溯源", "典型错误溯源",
    "错题重做", "错题本", "错题溯源", "错因归类", "重复失分", "重复性失分", "易错点清零",
    "每节课围绕", "核心模型", "解题模型", "解题模板", "高分解题模板",
    "每节课后布置", "限时作业", "下次课", "检查订正", "当堂批改",
    "正确率", "得分率", "步骤分", "踩分", "规范书写", "答题规范", "书写规范",
    "压轴题", "压轴", "中档题", "基础题", "选填", "大题", "解答题",
    "一轮复习", "二轮复习", "三轮", "一轮", "二轮", "同步", "总复习",
    "限时套卷", "套卷", "综合性小测", "阶段检测", "查漏补缺", "滚动复习", "滚动纳入",
    "模块化专题复习", "专题", "模型归纳", "多解法拓展", "限时提速",
    "取舍", "应试", "考场节奏", "时间分配", "答题顺序",
    "校内疑难", "校内错题", "校内进度", "不重复基础概念", "不再赘述基础概念",
    "精准突破", "精准", "强化", "巩固", "突破", "提升", "补齐", "固化", "清除失分漏洞",
    "目标分", "目标", "稳定在", "冲刺", "拔高", "保底",
]
pc = Counter()
for _, m in methods:
    t = norm(m)
    for p in PHRASES:
        if p in t:
            pc[p] += 1
print("\n=== 教学方法：固定措辞覆盖率（按出现份数排序，≥3 份）===", file=buf)
for p, n in pc.most_common():
    if n >= 3:
        print(f"  {n:>2}/{len(methods)}  {p}", file=buf)

# ---------- 2. 句式骨架：开头 25 字 + 课堂流程句 ----------
print("\n=== 教学方法：开头骨架（前 22 字，多份同构的可作为模板）===", file=buf)
head = Counter()
for _, m in methods:
    t = norm(m)
    # 数字参数化，便于看同构
    key = re.sub(r"\d+(\.\d+)?", "N", t[:22])
    head[key] += 1
for k, n in head.most_common(18):
    print(f"  {n:>2}x  {k}", file=buf)

print("\n=== 教学方法：课堂流程句（含「课堂采用」的原文）===", file=buf)
flow = Counter()
for _, m in methods:
    t = norm(m)
    mm = re.search(r"课堂采用[^。]{10,200}", t)
    if mm:
        key = re.sub(r"\d+(\.\d+)?", "N", mm.group(0))
        flow[key] += 1
for k, n in flow.most_common(14):
    print(f"  {n:>2}x  {k[:150]}", file=buf)

# ---------- 3. 高频 5-gram（英文/数字混杂已参数化） ----------
print("\n=== 教学方法：6 字滑窗高频（≥12 份，前 30）===", file=buf)
g6 = Counter()
for _, m in methods:
    t = re.sub(r"\d+(\.\d+)?", "N", norm(m))
    for i in range(len(t) - 6 + 1):
        g6[t[i:i + 6]] += 1
shown = 0
for g, n in g6.most_common():
    if n < 12 or shown >= 30:
        break
    print(f"  {n:>2}x  {g}", file=buf)
    shown += 1

# ---------- 4. 教学目标：句式归类 ----------
print(f"\n=== 教学目标：{len(goals_all)} 条，按句式模板归类（≥3 次）===", file=buf)
gc = Counter()
gfiles = {}
for f, g in goals_all:
    key = norm(re.sub(r"\d+(\.\d+)?", "N", g))
    gc[key] += 1
    gfiles.setdefault(key, []).append(f)
for k, n in gc.most_common():
    if n < 3:
        break
    print(f"  {n:>2}x  {k[:96]}", file=buf)

# 教学目标里的高频「验收指标」词
print("\n=== 教学目标：验收指标类措辞出现条数 ===", file=buf)
IND = ["正确率", "得分率", "≥", "不超过", "零失误", "满分", "稳定", "清零", "杜绝",
       "熟练", "掌握", "能独立", "能完整", "形成", "明确", "构建", "完成"]
ic = Counter()
for _, g in goals_all:
    for w in IND:
        if w in g:
            ic[w] += 1
for w, n in ic.most_common():
    print(f"  {n:>4}/{len(goals_all)}  {w}", file=buf)

open(os.path.join(OUT, "analysis-report2.txt"), "w", encoding="utf-8").write(buf.getvalue())
print("written analysis-report2.txt (写在文件里，见 analysis-report2.txt)")
