---
name: weekly-report
description: Structure and data sources for the weekly inventory report. Load this when the task is "weekly report", "Monday report", or "summarize inventory status".
---
<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->


# 每周库存报告

生成报告的方式是**通过代码执行写一个 Python 脚本**，读 CSV 并输出 markdown。**不要做按 SKU 的工具调用**。

## 结构

```markdown
# Inventory Report — {{warehouse or "All Warehouses"}} — week of {{date}}

## Stockouts (on_hand = 0)
| SKU | Product | Warehouse | Days out |
...

## Low Stock (below reorder point)
| SKU | On hand | Reorder pt | Days cover | Action |
... 按紧迫度排前 15（覆盖天数升序）...

## Open POs
| PO | SKU | Qty | Supplier | ETA |
... 来自 /mnt/user/sinks/purchase_orders.jsonl ...

## Forecast Risk
promo_next_month=1 或 is_seasonal=1 且 on_hand < 14 天覆盖的 SKU。
每条一行：SKU、原因、建议行动。
```

## 运营节奏（在被问的是哪份报告）

| 节奏 | 触发词 | 内容 |
|---|---|---|
| **每日** | "跑一下检查"、"巡检" | 低库存清单加每个 SKU 的处理动作；结尾一条汇总通知。 |
| **每周**（周一） | "那份报告"、"周回顾" | 按仓库：最关注项、**超过交付周期的未关闭 PO**、连续 5 个工作日以上低于补货点的 SKU。 |
| **每月** | "供应商回顾" | 准时率下滑的供应商；可能需要更换主供应商的 SKU。 |
| **临时** | 其他 | 范围按被问的来。 |

请求没说哪种时，从措辞推断。下面的结构是**每周**格式；日报去掉 Open-POs 和 Forecast-Risk 两节，开头放当日已采取的动作。

## 老化 PO 检查（仅每周）

对每个未关闭 PO，比较下单至今的天数与供应商的 `lead_time_days`。把 elapsed > lead_time 的 PO 列为 **老化**，并附上供应商与超期天数，便于运营跟进。

## 数据源

- 缺货与低库存：`/mnt/user/data/stock_levels.csv` 中最新日期的行，关联 `/mnt/user/data/products.csv`
- 覆盖天数：`on_hand / avg_daily_sales`（来自 `/mnt/user/data/sales_history.csv` 最近 14 天）
- 未关闭 PO：`/mnt/user/sinks/purchase_orders.jsonl`
- 预测风险：`/mnt/user/data/products.csv` 的标志 + 上面算出的覆盖天数

## 用代码做这件事

CSV 文件很大（`stock_levels` 约 6.7 万行）。**写一个单独的脚本**，加载一次，把所有计算都做完，然后打印 markdown。**不要用工具调用一页一页翻数据**——那正是本 skill 要替代的模式。
