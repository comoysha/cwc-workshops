---
name: forecasting
description: How to produce a demand forecast for a SKU, and when to delegate that to a subagent vs. compute it yourself. Load this for any task involving "forecast", "how much will we sell", "next month", promos, or seasonal SKUs.
---
<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->


# 需求预测

预测有两条路径。**选对路径**——本可以自己算却开了 subagent，是浪费回合；本该开 subagent 却没开，得到的就是一个错的数字。

## 路径 A —— 自己算（代码执行）

**当以下条件全部满足时**使用：
- 预测时间窗 ≤ 14 天
- 产品的 `is_seasonal` 标志为 0
- 产品的 `promo_next_month` 标志为 0
- 任务没有提到促销、节假日或趋势变化

此时预测就是一个滚动均值。本 skill 自带一个脚本：

```bash
python .claude/skills/forecasting/rolling_mean.py SKU-0057 14
```

就这样——一次 Bash 调用，约 200 tokens，无需 subagent。脚本约 20 行，想改可以直接读源码。

**巡检场景的批量变体：** 如果需要对*很多* SKU 一次性算覆盖天数（如每日低库存巡检），**不要循环调用工具**——跑批量脚本：

```bash
python .claude/skills/forecasting/batch_days_of_cover.py 20
```

返回按覆盖天数升序排列的 20 个最紧急 SKU（JSON 格式）。这就替代了旧 agent 在 F1 任务里 100+ 次 `get_stock_level` / `get_sales_velocity` 调用。

## 路径 B —— 派出 forecaster subagent

**当以下任一条件成立时**使用：
- 预测时间窗 > 14 天
- `is_seasonal` 为 1
- `promo_next_month` 为 1，或任务提到了促销
- 近期销售出现明显趋势断点

**为什么要 subagent：** forecaster 需要把完整的 90 天历史放进上下文，才能识别季节性和促销效应。那大约是 90 行 × 多个 SKU。把这些塞进*你自己*的上下文会挤掉任务的其它部分。subagent 有自己的上下文窗口，在那里完成分析，**只把一个小 JSON 交回来**。

**如何调用：** 委派给 `forecaster` 这个 callable agent。**只传给它 SKU、产品标志、时间窗——不要传历史行**。forecaster 有 Bash 权限可访问相同的 `/mnt/user/data/`，会在自己的上下文里基于完整历史计算（这就是要点：90 行数据存活在那边，不在这边）。它返回 `{forecast_qty, confidence, method, flags}` 这个 JSON——**严格解析**；如果 JSON 格式错误那就是错误，不是可以蒙过去的事。

如果 `callable_agents` 不可用（这是研究预览功能），**降级**为自己算滚动均值，并把 `confidence` 设到 **≤ 0.55**，这样 reorder-policy skill 就会触发人工复核而不是基于一个你没法验证的数字自动下单。

## 季节日历（用来给你的数字做合理性检查）

户外装备季节性很强。预测时间窗跨越季节切换时，滚动均值会滞后于拐点——这时倾向走路径 B，并在理由中提及季节。

| 时间窗 | 上升的品类 | 相对基线 |
|---|---|---|
| 3–5 月 | 鞋类、背包、雨壳、登山杖 | 1.3–1.6× |
| 6–8 月 | 帐篷、睡具、炉具、净水 | 1.5–2.0×（全年峰值季度） |
| 9–10 月 | 保暖服装、光学、头灯 | 上升；帐篷/鞋类回落 |
| 11–12 月 | 礼品价位品类；促销最密集 | 务必确认促销标志 |
| 1–2 月 | 重置——全年最低量 | 适合循环盘点 |

## 促销处理

**促销是订少的最常见原因**。当 `promo_next_month=1` 或任务提到促销时：

- **不要**只依赖滚动均值——那是促销前的需求。
- 寻找历史类比（同一 SKU 在过去 12 个月里有过类似促销），用*那次*的提升倍数。如果找不到类比，subagent 应该设置 `flags: ["promo_uplift_uncertain"]` 并给一个远低于 0.6 的 confidence。
- 提升不确定时，**默认标记人工复核，而不是自动下单**。促销订多了是可挽回的；订少了就是流量高峰期的缺货。
- 如果促销结束日期已知，也要考虑促销后的下跌——别让渠道在促销后一周积压。

**要避免的失败模式：** 在散文里说"可能是 ~3×"，但返回的 `forecast_qty` 仍然是没加提升的基线均值。**把数字锚定，不只是叙述**。

## 拿到结果之后怎么用

把 `{forecast_qty, confidence, flags}` 喂给 reorder-policy skill。特别要注意：**如果 `confidence < 0.6`，reorder-policy 规定要升级人工，不要自动下单。** 不要把 confidence 和 flags 扔在地上——它们是契约的一部分。

## 完整示例（路径 B）

任务："为下个月的促销补 SKU-0091。" → `promo_next_month=1`，时间窗=30 → 走路径 B。

Subagent 返回：`{"forecast_qty": 2100, "confidence": 0.41, "method": "baseline_mean_no_comparable_promo", "flags": ["promo_uplift_uncertain"]}`

confidence 0.41 < 0.6 → 按 reorder-policy，**不要**创建 PO。通过 notify-templates 升级人工，带上 flags，建议约 2,100 件基线 + 备注促销提升可能为 2–3 倍、需要人工决策。
