---
name: supplier-selection
description: How to rank and pick a supplier for a SKU. Load this whenever a task involves choosing a supplier, comparing quotes, or creating a purchase order.
---
<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->


# 供应商选择

供应商打分是**算术**，不是判断。**用代码执行在 Python 里算——不要在散文里推理。**

## 方法

对给定 SKU：

1. 读 `/mnt/user/data/supplier_catalog.csv`，过滤匹配该 SKU 的行。得到每个候选的 `(supplier_id, unit_price, min_order_qty)`。
2. 按 `supplier_id` 关联 `/mnt/user/data/suppliers.csv`，拿到 `lead_time_days` 和 `reliability`。
3. 在候选间归一化价格和交付周期（min-max 到 [0,1]，0 最优）。`reliability` 已经在 [0,1]，越高越好。
4. 给每个候选打分：
   ```
   score = 0.5 × (1 − norm_price) + 0.3 × (1 − norm_lead_time) + 0.2 × reliability
   ```
5. 取最高分。**平手时：** 取最低 `unit_price`，再取最低 `lead_time_days`，再按 `supplier_id` 字母序。

## 用代码做这件事

写一个短 Python 脚本跑——**不要**每个供应商调一次工具，**不要**靠描述报价来比较。脚本骨架示例：

```python
import csv
sku = "SKU-0057"
catalog = [r for r in csv.DictReader(open("/mnt/user/data/supplier_catalog.csv")) if r["sku"] == sku]
suppliers = {r["supplier_id"]: r for r in csv.DictReader(open("/mnt/user/data/suppliers.csv"))}
# 关联、归一化、打分、排序——把胜者打成 JSON 输出
```

## 供应商专属覆盖项

这些怪癖**不在目录数据里**。打分后再应用；如果某条覆盖项改变了你的选择，**在理由里说明**。

| 供应商 | 覆盖项 |
|---|---|
| SUP-01 Cascade Distribution | 超过 500 件的订单需要 48 小时通知，否则会自动拆成两批——大额 PO 要把这个算进交付周期。 |
| SUP-02 Alpine Wholesale | 12 月 20 日 – 1 月 3 日歇业。该窗口内的 PO 要到 1 月 4 日才会被确认。节假日补货应在 12 月 15 日前到货。 |
| SUP-03 Backcountry Supply Co | 今年帐篷与庇护所类有过两次短发。该品类若交付周期相当，优先用其他供应商。 |
| SUP-04 Sierra Outfitters | ≥250 件有 3% 价格折扣（未列入目录）。推荐量在 200–249 时，常常值得向上取整。 |
| SUP-05 Granite Gear Partners | 只从西海岸 DC 发货。到 WH-EAST 的交付周期比目录上多 2–3 天。 |
| SUP-07 Ridgecrest Imports | 仅进口；交付周期对港口拥堵敏感。紧急单不要依赖其标注的交付周期。 |
| SUP-09 Summit Source | MOQ 严格执行——低于 MOQ 直接拒单（不会向上取整）。 |
| SUP-12 Trailhead Mercantile | 名册上的新成员。在我们攒到 6 个月历史前，把可靠性当作比标注低一档处理。 |

## 仓库交付周期调整

- **WH-WEST（Reno）**：大多数供应商从东海岸 DC 发货——除非供应商备注另说，**经验法则在目录交付周期上 +2 天**。
- **WH-EAST（Carlisle）**：两班制收货码头；需要当日入库排班的加急 PO 的最佳目的地。
- **WH-CENTRAL（Kansas City）**：溢出/调拨枢纽。如果你考虑的是仓间调拨而非 PO，源仓几乎总是 WH-CENTRAL。

## 加急覆盖

如果 reorder-policy skill 标记了 **加急**，**忽略评分**，从 `min_order_qty` ≤ 目标订货量的候选里选 `lead_time_days` 最低的。

## 输出

返回 `{"supplier_id": "SUP-03", "unit_price": 21.40, "lead_time_days": 7, "score": 0.81}`，并在 PO 中使用该 `supplier_id`。
