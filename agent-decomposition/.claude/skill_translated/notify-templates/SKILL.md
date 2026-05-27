---
name: notify-templates
description: Fixed-format templates for Slack alerts, supplier emails, and escalations. Load this whenever the task is "notify", "alert", "email", or "tell ops".
---
<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->


# 通知模板

通知是**填模板**，不是创意写作。**不要为此派 subagent**。从你已有的数据填占位符，然后把结果追加到 outbox。

## 低库存 Slack 告警

```
:warning: *Low stock* — {{sku}} ({{product_name}})
On hand: {{on_hand}} · Reorder point: {{reorder_point}} · Days of cover: {{days_cover}}
{{action_line}}
```

`action_line` 是 `PO {{po_id}} placed for {{qty}} units (ETA {{eta}})` 或 `Awaiting review — {{reason}}` 之一。

## 供应商邮件

```
Subject: PO {{po_id}} — {{qty}} × {{sku}}

Hi {{supplier_name}},

Please confirm PO {{po_id}} for {{qty}} units of {{sku}} ({{product_name}}) at ${{unit_price}}/unit.
Requested delivery: {{requested_date}}. {{expedite_note}}

Thanks,
StockPilot
```

## 升级（需要人工复核）

```
:octagonal_sign: *Review needed* — {{sku}}
Recommended qty: {{qty}} (confidence {{confidence}})
Flags: {{flags_csv}}
Reason: {{reason}}
```

## 路由（谁收什么）

| 收件方 | 什么时候 | 示例 |
|---|---|---|
| `ops` 频道（默认） | 低库存告警、补货建议、循环盘点调整、周报。 | 几乎所有事项。 |
| `ops` 加 `@here` | Top-100 SKU 正在或即将缺货，或 7 天内会导致缺货的供应商延期。 | "WH-EAST 在手为 0，全网 <1 天内断货" |
| 采购主管（私信/邮件，不发频道） | 单笔 PO > $25k、偏离评分推荐的供应商、或新供应商考量。 | |
| 财务 | 仅当单一供应商未关 PO 余额会超过 $100k、或疑似重复 PO 时。**不发例行事项**。 | |

升级超出默认频道时，加一行说明越过了哪个阈值。

## 批量发送，不要刷屏

巡检和每日检查时，**发一条汇总通知**，不是每个 SKU 一条。上面的低库存模板是给单 SKU 任务的；巡检时组成一条消息列出所有已处理（和未处理）的 SKU，**结尾发一次**。

**当任务明确要求每个 SKU 一条告警时**（如"对前 10 个分别发一条个性化告警"）：在一次 Bash heredoc 中给每个 SKU 填一次模板并把所有行写入 outbox：

```bash
python -c '
import json
rows = [...top-10 from batch_days_of_cover.py...]
with open("/mnt/user/sinks/outbox.jsonl", "a") as f:
    for r in rows:
        f.write(json.dumps({"channel": "ops", "sku": r["sku"],
                            "message": f":warning: Low stock — {r[\"sku\"]} ..."}) + "\n")
'
```

**不要**每个 SKU 调用一次 `send_slack_alert`（或任何 subagent）——那是 N 个回合的模型来回，只为了填模板。

批量发完后，最终回答应是**简短确认**（"✓ 10 条告警已发至 ops——见 outbox"）加一张 SKU + on-hand + 覆盖天数的紧凑表格。**不要在回复里复述全部告警正文**；它已经在 outbox 里。

## 怎么发

通过 Bash 直接向 `/mnt/user/sinks/outbox.jsonl` 追加——每行一个 JSON 对象，例如：

```bash
python -c 'import json; print(json.dumps({"channel": "ops", "sku": "SKU-0012", "message": "..."}))' \
  >> /mnt/user/sinks/outbox.jsonl
```

用 `json.dumps` 让消息里的换行被转义（裸 `echo` 会把 JSONL 弄坏）。整件事就是：（如果还没有数据）读一次需要的数据，然后追加一次。**如果发一条通知用了超过两次调用，那就过度设计了。**
