---
name: submit-solution
description: Guide a workshop attendee through committing their starter-agent decomposition and opening a PR with their solution + workshop feedback. Invoke when the user says "submit", "I'm done", "open a PR", or asks how to share their solution.
---
<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->


# 提交你的 StockPilot 解决方案

你正在帮一位 workshop 参与者把他们的 `agents/starter/agent.py` 拆解打包并开 PR。**PR 是讲师看到大家做法的渠道**，PR 描述兼作 workshop 的反馈表。

## 第 1 步 —— 先问体验

动 git 之前先问这三个问题（用 AskUserQuestion 或对话形式都行）：

1. **Cycle 3 的 subagent 方案你选了哪个？**
   （callable_agents / spawn_subagent / inline / 其他）
2. **Workshop 最难的部分是什么？**
   （某个具体 cycle、某个概念、工具链、时间安排）
3. **想改进的一点是？**

**记住他们的回答**——会用在 PR 正文里。

## 第 2 步 —— 让他们看清要提交什么

```bash
git diff main -- agent-decomposition/agents/starter/agent.py
```

简要走一遍 diff：他们删了哪些工具、启用了哪些 skill、接入了哪种 subagent 方案。如果 diff 是空的，说明他们没改 starter——问他们是不是改了别的文件。

也拿到他们最终的 eval 分数：

```bash
ls -t evals/reports/*/starter.json | head -1 | xargs cat | python -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"score\"]:.0%}')"
```

## 第 3 步 —— 提交并推送

```bash
git checkout -b solution/<their-name-or-handle>
git add agent-decomposition/agents/starter/agent.py
git commit -m "Workshop solution: <subagent approach>, <score>%"
git push -u origin solution/<their-name-or-handle>
```

没拿到名字/handle 就问。如果他们对 `anthropics/cwc-workshops` 没有推送权限，让他们先 fork（`gh repo fork --clone=false`）并推到自己的 fork。

## 第 4 步 —— 开 PR，把反馈放正文

```bash
gh pr create --title "Workshop solution — <name>" --body-file -
```

PR 正文模板（用第 1 步 + 第 2 步的内容填）：

```markdown
## My decomposition

- Subagent approach: <callable_agents | spawn_subagent | inline | other>
- Final eval score: <NN>%
- Tools I dropped: <list>
- Skills I enabled: <list>

## Workshop feedback

**Hardest part:** <他们的回答>

**One thing I'd change:** <他们的回答>

**Anything else:** <自由文本——没有就留空>
```

## 第 5 步 —— 确认

把 PR URL 给他们并致谢。提一句：**讲师会读每一份 PR**，反馈会直接影响这门 workshop 的下一轮迭代。

## 不要

- 在他们看 diff 和正文之前就开 PR
- 为"省时间"跳过反馈问题——那是这个 skill 存在的意义
- 把 `evals/reports/` 或 `.stockpilot_ids.json` 包进提交
