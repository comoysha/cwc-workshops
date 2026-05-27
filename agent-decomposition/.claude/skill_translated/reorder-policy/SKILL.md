---
name: reorder-policy
description: How to decide whether and how much to reorder a SKU. Load this whenever a task involves reorder recommendations, purchase orders, or "should we restock" questions.
---
<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->


# 补货策略

本 skill 编码了 StockPilot 的补货规则。**何时**要补、**补多少**——任何这类决策都用它。

## 你需要的输入

| 数值 | 从哪取 |
|---|---|
| `on_hand` | `/mnt/user/data/stock_levels.csv` 中该 SKU 的最新行（除非任务针对特定仓库，否则按仓库求和） |
| `reorder_point` | `/mnt/user/data/products.csv` |
| `avg_daily_sales` | `/mnt/user/data/sales_history.csv` 最近 14 天的 `units_sold` 均值 |
| `lead_time_days` | 来自选定的供应商（见 supplier-selection skill） |
| `forecast_qty`、`confidence`、`flags` | 来自 forecasting skill，**仅当**任务展望超过 14 天或提到促销/季节时 |

## 决策规则

1. **要不要补货？** 当 `on_hand < reorder_point` 时补货。如果 `on_hand ≥ reorder_point`，答案是"无需补货"——到此为止。

2. **补多少？** 目标订货量是 **30 天覆盖** 加安全库存，再减去已在手：

   ```
   safety_stock = 1.5 × avg_daily_sales × lead_time_days
   order_qty    = (avg_daily_sales × 30) + safety_stock − on_hand
   ```

   向上取整到供应商 `min_order_qty` 的倍数。

3. **置信度护栏。** 如果你拿到了预测且 `confidence < 0.6`，**不要自动下 PO**。改为：
   - 用 notify-templates skill（升级模板）把一条升级消息写入 `/mnt/user/sinks/outbox.jsonl`，并带上预测的 `flags`。
   - 在最终答复中说明推荐数量并指出需要人工复核，附上原因。

4. **加急？** 如果 `on_hand / avg_daily_sales < lead_time_days`（在订单到货前就会断货），选**交付周期最短**的供应商，即使不是最便宜的，并在 PO 上备注"expedited"。

## 完整示例

SKU-0057：`on_hand = 38`、`reorder_point = 120`、`avg_daily_sales = 18.2`、选定供应商 `lead_time_days = 7`、`min_order_qty = 50`。

- 38 < 120 → 补货。
- safety_stock = 1.5 × 18.2 × 7 = **191.1**
- order_qty = (18.2 × 30) + 191.1 − 38 = 546 + 191.1 − 38 = **699.1** → 向上取到 50 的倍数 → **700**
- 38 / 18.2 = 2.1 天覆盖，交付周期 7 天 → **加急**。

## 优先级（多个 SKU 同时告急时）

按层级排序，同层级内按覆盖天数升序：

1. **缺货** —— 任一仓库 `on_hand = 0`。永远第一处理。
2. **将在 PO 到货前断货** —— `days_of_cover < lead_time_days`。加急或调拨。
3. **高速 SKU 低于补货点** —— Top-100 畅销品低于补货点。
4. **例行补货** —— 其他低于补货点的。
5. **趋近补货点** —— 仅记录，不行动。

如果一轮处理不完所有 SKU，说明你处理了多少、剩多少，并列出剩余 SKU ID，方便下一轮接上。

## 调拨 vs 补货

一个仓库低、另一个有富余时：

- **调拨**：富余仓库自身 > 30 天覆盖，3–5 天的调拨周期短于最佳供应商交付周期，所需数量 ≲200 件。源仓默认是 WH-CENTRAL。
- **补货**：没有仓库有富余，或所需数量大，或供应商交付周期与调拨周期相当。
- **两者都做**：缺口紧急且量大——立即调拨一批做过桥，剩余部分下 PO。

**说明你选了哪条路径以及为什么**。

## 合规

- 单笔 PO 超过 **$10,000** 需要在 PO 里附一行理由，方便运营拷到 ERP。
- 一次任务下了 **超过 5 个 PO**，结尾用一行汇总总承诺支出。
- **不要**对已经有未关 PO 覆盖需求的 SKU 再下一单。

## 输出

实际下单时，向 `/mnt/user/sinks/purchase_orders.jsonl` 追加：
```json
{"sku": "SKU-0057", "supplier_id": "SUP-03", "qty": 700, "expedite": true, "reason": "below reorder point; 2.1d cover"}
```

只是建议（没有副作用请求）时，返回结构化的 `ReorderDecision`：
```json
{"sku": "...", "reorder": true, "qty": 700, "supplier_id": "SUP-03", "expedite": true, "confidence": 0.85, "notes": "..."}
```
