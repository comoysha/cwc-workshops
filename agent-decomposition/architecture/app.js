/* ──────────────────────────────────────────────────────────────────
   StockPilot Architecture · app.js
   纯 vanilla JS。所有视觉元素由这里渲染，方便在不联网时也能跑。
   数据来源：本仓库 agents/before/、agents/starter/agent.py、
              .claude/skills/、README.md
   ────────────────────────────────────────────────────────────────── */

// ─────────────────────── 数据 ───────────────────────

const TOOLS = [
  { name: "get_stock_level",        desc: "查询某 SKU 在某仓库的当前在手数量。", fate: "code", note: "用 Bash 直接读 CSV 等价。" },
  { name: "list_low_stock",         desc: "返回所有当前低于补货点的 SKU/仓库组合（原始 CSV）。", fate: "code", note: "约 400 行 CSV 倒进 context——F1 的 token 炸点。改用 batch_days_of_cover.py。" },
  { name: "get_sales_velocity",     desc: "返回 SKU 在 N 天窗口的日均销量。", fate: "code", note: "本质是一次均值。Bash 一句 awk 就够。" },
  { name: "forecast_demand",        desc: "调用 forecasting subagent 返回散文。", fate: "skill", note: "改成 callable forecaster + forecasting skill 的强类型 JSON 契约。" },
  { name: "get_supplier_catalog",   desc: "返回供应某 SKU 的所有供应商及价格、MOQ。", fate: "code", note: "读 CSV + 关联即可。" },
  { name: "compare_supplier_quotes",desc: "调用 procurement subagent 推荐供应商。", fate: "skill", note: "本质是排序：supplier-selection skill 提供权重和归一化方法，Python 算。" },
  { name: "create_purchase_order",  desc: "落 PO 到 purchase_orders.jsonl。", fate: "keep", note: "确实有副作用的写操作，保留为 Bash append。" },
  { name: "update_erp_record",      desc: "更新 ERP 某 SKU 的字段。", fate: "keep", note: "同上，写操作。" },
  { name: "send_slack_alert",       desc: "调用 writing subagent 填模板再发到 #ops-inventory。", fate: "skill", note: "填模板不需要模型回合：notify-templates skill + Bash append outbox.jsonl。" },
  { name: "draft_email_to_supplier",desc: "调用 writing subagent 起草供应商邮件。", fate: "skill", note: "同上，模板填充。" },
  { name: "generate_weekly_report", desc: "生成某仓库的周报。", fate: "skill", note: "weekly-report skill 给结构，Python 脚本读 CSV 算指标。" },
  { name: "search_web_for_disruptions", desc: "查最近供应链相关新闻头条（缓存版）。", fate: "del", note: "应由独立的市场情报 agent 提供，不属于库存 agent。" },
];

const SUBAGENTS_V1 = [
  { name: "forecasting_subagent",  desc: "看完整 90 天历史，返回 30 天需求估计（散文）。" },
  { name: "procurement_subagent",  desc: "对比供应商报价，给一段推荐文字（散文）。" },
  { name: "writing_subagent",      desc: "起草 Slack 文案或供应商邮件（散文）。" },
];

const SKILLS = [
  { name: "reorder-policy",       desc: "要不要补、补多少、是否加急、调拨 vs 补货。把 prompt 里的补货公式抽出来。" },
  { name: "forecasting",          desc: "两条路径：≤14 天稳态 → 自带脚本算；促销/季节/长 horizon → 派 callable forecaster。" },
  { name: "supplier-selection",   desc: "供应商打分公式 + 12 家供应商的目录外覆盖项（节假日、阶梯折扣等）。" },
  { name: "notify-templates",     desc: "Slack/邮件/升级三种固定模板，明确禁止为此派 subagent。" },
  { name: "weekly-report",        desc: "周报结构 + 数据源。要求用单脚本聚合 ~6.7 万行的 stock_levels.csv。" },
];

const TERMS = [
  { zh: "补货点", en: "reorder point", desc: "当某 SKU 的在手数量跌到这个水平，就该评估补货。是商品主数据里的字段。" },
  { zh: "安全库存", en: "safety stock", desc: "为应对需求和交付周期的波动而多备的缓冲。", fx: "1.5 × 日均销量 × 交付周期(天)" },
  { zh: "覆盖天数", en: "days of cover", desc: "按当前节奏，库存还能撑多少天。", fx: "on_hand / 日均销量" },
  { zh: "交付周期", en: "lead time", desc: "从下 PO 到货物可拣货的日历天数。WH-WEST 一般要加 2 天。" },
  { zh: "MOQ", en: "min order quantity", desc: "供应商接受的最小订单量。低于会被拒（不是四舍五入向上）。" },
  { zh: "销售速度", en: "velocity", desc: "回看窗口内的日均销量。稳定品类用 14 天，季节品类用 30 天。" },
  { zh: "PO", en: "purchase order", desc: "采购订单。一个 PO 包含 SKU、供应商、数量、单价。" },
  { zh: "ERP", en: "—", desc: "企业资源规划系统。库存 agent 的写操作（PO、调整、状态）最终都要落到 ERP。" },
];

// 402 行 prompt 按章节切片（行数为大致估计，文件实际为 416 行包含 docstring 等）
const PROMPT_SECTIONS = [
  { name: "角色 + 职责",          lines: 14, dest: "keep",    label: "→ SHORT" },
  { name: "工具使用指南 + gotchas",lines: 28, dest: "delete",  label: "✕ agent_toolset 自带" },
  { name: "运营节奏",              lines: 10, dest: "move",    label: "→ skill 描述" },
  { name: "多 SKU 优先级",         lines: 12, dest: "move",    label: "→ reorder-policy" },
  { name: "调拨 vs 补货",          lines: 10, dest: "move",    label: "→ reorder-policy" },
  { name: "促销处理",              lines: 12, dest: "move",    label: "→ forecasting" },
  { name: "补货策略 + 公式",       lines: 14, dest: "move",    label: "→ reorder-policy" },
  { name: "供应商选择 + 权重",     lines: 12, dest: "move",    label: "→ supplier-selection" },
  { name: "供应商专属备注 (12 家)",lines: 16, dest: "move",    label: "→ supplier-selection" },
  { name: "季节日历",              lines: 12, dest: "move",    label: "→ forecasting" },
  { name: "输出格式",              lines:  8, dest: "keep",    label: "→ SHORT" },
  { name: "示例 1–8（约 100 行）", lines: 100,dest: "delete",  label: "✕ 模型已能学会" },
  { name: "重要准则 + 处理不确定", lines: 18, dest: "move",    label: "→ 跨 skill" },
  { name: "沟通语气",              lines:  6, dest: "move",    label: "→ notify-templates" },
  { name: "升级矩阵",              lines: 12, dest: "move",    label: "→ notify-templates" },
  { name: "边缘情况 + 失败恢复",   lines: 16, dest: "move",    label: "→ 各 skill" },
  { name: "数据新鲜度",            lines:  4, dest: "delete",  label: "✕ 直接观察沙箱时间戳" },
  { name: "多仓库 + 仓库备注",     lines: 14, dest: "move",    label: "→ supplier-selection" },
  { name: "合规与审计",            lines:  8, dest: "move",    label: "→ reorder-policy" },
  { name: "术语表",                lines: 10, dest: "delete",  label: "✕ 模型已掌握" },
  { name: "What NOT to do + 清单", lines: 16, dest: "move",    label: "→ 各 skill" },
];

// 业务策略搬家路线
const POLICY_MAP = [
  {
    label: "补货决策（要不要补 / 补多少）",
    before: "在 LEGACY_PROMPT § 'Reorder policy' 里写了一段自然语言公式，主 agent 每次任务都把这段进 context。",
    after:  "搬到 .claude/skills/reorder-policy/SKILL.md。skill 触发词包含 'reorder'、'restock'、'purchase order'。agent 看到任务命中关键词时才加载这份 skill。"
  },
  {
    label: "需求预测（含促销/季节）",
    before: "tool forecast_demand → 起一个 subagent 把 90 天历史全塞进去，返回散文。主 agent 自己提取数字（经常丢 confidence）。",
    after:  "skill forecasting 给路径判断 + Path A 脚本；超出 Path A 时调 callable forecaster。返回 {forecast_qty, confidence, method, flags} JSON。"
  },
  {
    label: "供应商打分公式",
    before: "在 LEGACY_PROMPT § 'Supplier selection' 用自然语言说 '权衡价格、交付、可靠性'，权重不明。procurement_subagent 凭感觉给推荐。",
    after:  "supplier-selection skill 写明 score=0.5×price+0.3×lead+0.2×reliability，要求<strong>用 Python 算</strong>而不是散文推理。"
  },
  {
    label: "12 家供应商的目录外规则",
    before: "在 LEGACY_PROMPT § 'Supplier-specific notes' 列了 8 段（节假日、阶梯折扣、品类短发等），常驻 context。",
    after:  "搬到 supplier-selection/SKILL.md 表格里。除非任务涉及供应商选择，否则这 8 段不进 context。"
  },
  {
    label: "Slack / 邮件 / 升级模板",
    before: "writing_subagent 每条消息都起一个 model round trip 来填模板，外加 prompt 里的 'Communication tone' 段。",
    after:  "notify-templates/SKILL.md 给三个固定模板 + 路由矩阵 + 'do not spawn subagent for this' 的明确禁令。"
  },
  {
    label: "周报结构",
    before: "tool generate_weekly_report 是按仓库的；prompt § 'Operating cadence' 描述周报结构。",
    after:  "weekly-report/SKILL.md 描述四种节奏（日/周/月/临时）和数据源。一个 Python 脚本读 ~6.7 万行 stock_levels.csv 输出 markdown。"
  },
  {
    label: "巡检时的告警批量化",
    before: "prompt 提了一句 'send one summary alert, not one per SKU'，但 send_slack_alert 工具是单 SKU 的，agent 容易循环调用。",
    after:  "notify-templates/SKILL.md 显式给出 Bash heredoc 模板，一次写入多行到 outbox.jsonl。"
  },
  {
    label: "调拨 vs PO 决策",
    before: "在 LEGACY_PROMPT § 'Transfer vs reorder' 写了三档条件。常驻 context。",
    after:  "搬到 reorder-policy/SKILL.md。和补货决策属于同一类问题，自然合并。"
  },
];

// Before F1 trace —— 把 102 次调用按组别压缩展示
const F1_BEFORE = [
  { kind:"group", text:"轮 1：拿全网低库存清单"},
  { kind:"step", text:"list_low_stock() → 返回 ~400 行 CSV 直接进 context", tk:"≈8k tok" },
  { kind:"group", text:"轮 2–40：对前 39 个 SKU 逐个查库存（每个 SKU × 3 仓库 = 117 次调用 ≈ 39 个 SKU）"},
  { kind:"step", text:"get_stock_level(SKU-0042, WH-EAST)", tk:"≈250 tok" },
  { kind:"step", text:"get_stock_level(SKU-0042, WH-WEST)", tk:"≈250 tok" },
  { kind:"step", text:"get_stock_level(SKU-0042, WH-CENTRAL)", tk:"≈250 tok" },
  { kind:"step", text:"...（继续 36 个 SKU × 3 仓库 = 108 次）", tk:"≈27k tok" },
  { kind:"group", text:"轮 41–60：算各自销售速度"},
  { kind:"step", text:"get_sales_velocity(SKU-0042, days=14)", tk:"≈200 tok" },
  { kind:"step", text:"...（每个 SKU 一次，共 39 次）", tk:"≈8k tok" },
  { kind:"group", text:"轮 61–75：要预测，subagent 把 90 天历史塞进自己 context"},
  { kind:"step", text:"forecast_demand(SKU-0042) → subagent 调用 ≈4k tok in / 600 tok out 散文", tk:"≈5k tok" },
  { kind:"step", text:"主 agent 解析散文，confidence 关键词丢失", tk:"风险" },
  { kind:"step", text:"...（前 15 个 SKU 都跑一遍）", tk:"≈75k tok" },
  { kind:"group", text:"轮 76–95：找供应商并起草告警"},
  { kind:"step", text:"get_supplier_catalog(SKU-0042)", tk:"≈600 tok" },
  { kind:"step", text:"compare_supplier_quotes(SKU-0042) → procurement subagent 出散文", tk:"≈3k tok" },
  { kind:"step", text:"...（×15）", tk:"≈54k tok" },
  { kind:"group", text:"轮 96–102：起 Slack 告警 + 下 PO"},
  { kind:"step", text:"send_slack_alert(SKU-0042) → writing subagent × 10 次（每 SKU 一条，违反 prompt 但工具诱使）", tk:"≈10k tok" },
  { kind:"step", text:"create_purchase_order × 10", tk:"≈2k tok" },
  { kind:"step", text:"end_turn — 输出汇总", tk:"≈3k tok" },
  { kind:"group", text:"合计 ≈ 102 次工具调用 / 488 秒 / ~200k token"},
];

const F1_AFTER = [
  { kind:"group", text:"轮 1：感知全网紧迫度"},
  { kind:"step", text:"Bash: python .claude/skills/forecasting/batch_days_of_cover.py 20", tk:"≈500 tok" },
  { kind:"step", text:"→ 沙箱内读 6.7 万行 stock_levels + 90 天销售，单脚本计算", tk:"0 tok（不进 ctx）" },
  { kind:"step", text:"→ 返回 20 行 JSON，按 days_of_cover 升序", tk:"≈800 tok" },
  { kind:"group", text:"轮 2：触发 reorder-policy + supplier-selection skill"},
  { kind:"step", text:"skill 加载（按 description 命中 'reorder')", tk:"≈400 tok" },
  { kind:"step", text:"Bash: python（单脚本，对前 10 个 SKU 算 order_qty 并跑 supplier 打分）", tk:"≈600 tok" },
  { kind:"step", text:"→ 返回 10 行决策表 {sku, qty, supplier_id, expedite, confidence}", tk:"≈600 tok" },
  { kind:"group", text:"轮 3：批量落 PO + 写一条汇总告警"},
  { kind:"step", text:"Bash: append 10 行到 purchase_orders.jsonl", tk:"≈300 tok" },
  { kind:"step", text:"skill notify-templates 加载，按汇总模板生成", tk:"≈300 tok" },
  { kind:"step", text:"Bash: 写一条 summary 到 outbox.jsonl", tk:"≈200 tok" },
  { kind:"step", text:"end_turn — 输出含 ✓ 10 alerts sent 的紧凑表", tk:"≈800 tok" },
  { kind:"group", text:"合计 ≈ 3 个 Bash 脚本 / ~100 秒 / ~4.5k token"},
];

// SHORT prompt（来自 agents/starter/agent.py）
const SHORT_PROMPT_TEXT = `You are StockPilot, an inventory management agent for a mid-size
outdoor-gear retailer. {DATE_ANCHOR}

First, run: \`mkdir -p /mnt/user/sinks && ln -sfn /mnt/session/uploads/data /mnt/user/data\`
so the paths in skills resolve. Data lives as CSVs under /mnt/user/data/
(products, stock_levels ~67k rows, sales_history 90d, supplier_catalog,
suppliers). Write sinks (purchase_orders.jsonl, outbox.jsonl, erp_writes.jsonl)
go to /mnt/user/sinks/ — append one JSON object per line, with a \`sku\` and
\`qty\` field where applicable.

For any operation touching >5 SKUs, write a Python script via Bash that
reads the CSVs and prints compact JSON — don't page through tool calls.
Business policies (reorder, supplier selection, forecasting, notifications,
reports) live in skills — load the relevant one before applying a policy.
You can delegate to the \`forecaster\` agent for demand estimates that need
full-history analysis — see the forecasting skill for when.

End with a direct answer, a \`ReorderDecision\` block, or a \`StockReport\`.`;

// ────────────────────── 渲染 ──────────────────────

// 1. 数据 schema 关系图
function renderDataSchema() {
  const svg = `
<svg viewBox="0 0 1080 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="data schema">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#5a5346"/>
    </marker>
    <style>
      .tbl rect { fill:#fffdf3; stroke:#b4842b; stroke-width:1.2; rx:8; }
      .tbl text.t { font: 600 13px var(--serif, Georgia); fill:#1c1a14; }
      .tbl text.c { font: 11.5px ui-monospace, Menlo, monospace; fill:#5a5346; }
      .write rect { fill:#fff7e0; stroke:#a23b3b; stroke-width:1.2; rx:8; }
      .write text.t { fill:#7a2a2a; }
      line.rel { stroke:#5a5346; stroke-dasharray:3 4; stroke-width:1; }
    </style>
  </defs>

  <!-- products -->
  <g class="tbl" transform="translate(40,30)">
    <rect width="220" height="120"/>
    <text class="t" x="14" y="22">products.csv</text>
    <text class="c" x="14" y="44">sku · name · category</text>
    <text class="c" x="14" y="62">reorder_point</text>
    <text class="c" x="14" y="80">is_seasonal · promo_next_month</text>
    <text class="c" x="14" y="104">(主数据 · 250 行)</text>
  </g>

  <!-- stock_levels -->
  <g class="tbl" transform="translate(290,30)">
    <rect width="230" height="120"/>
    <text class="t" x="14" y="22">stock_levels.csv</text>
    <text class="c" x="14" y="44">date · sku · warehouse</text>
    <text class="c" x="14" y="62">on_hand</text>
    <text class="c" x="14" y="86">(日切面 · ~67k 行)</text>
    <text class="c" x="14" y="104">三仓库 × 250 SKU × ~90 天</text>
  </g>

  <!-- sales_history -->
  <g class="tbl" transform="translate(550,30)">
    <rect width="220" height="120"/>
    <text class="t" x="14" y="22">sales_history.csv</text>
    <text class="c" x="14" y="44">date · sku · units_sold</text>
    <text class="c" x="14" y="68">(日切面 · ~22.5k 行)</text>
    <text class="c" x="14" y="86">速度 / 趋势 / 季节性</text>
    <text class="c" x="14" y="104">的数据底盘</text>
  </g>

  <!-- suppliers -->
  <g class="tbl" transform="translate(40,180)">
    <rect width="220" height="120"/>
    <text class="t" x="14" y="22">suppliers.csv</text>
    <text class="c" x="14" y="44">supplier_id · name</text>
    <text class="c" x="14" y="62">lead_time_days</text>
    <text class="c" x="14" y="80">reliability  (0–1)</text>
    <text class="c" x="14" y="104">(主数据 · 12 行)</text>
  </g>

  <!-- supplier_catalog -->
  <g class="tbl" transform="translate(290,180)">
    <rect width="230" height="120"/>
    <text class="t" x="14" y="22">supplier_catalog.csv</text>
    <text class="c" x="14" y="44">supplier_id · sku</text>
    <text class="c" x="14" y="62">unit_price · min_order_qty</text>
    <text class="c" x="14" y="86">(多对多关联表)</text>
    <text class="c" x="14" y="104">同一 SKU 多个候选</text>
  </g>

  <!-- sinks -->
  <g class="write" transform="translate(800,30)">
    <rect width="240" height="300"/>
    <text class="t" x="14" y="22">/sinks/  (agent 的写出)</text>
    <text class="c" x="14" y="48">purchase_orders.jsonl</text>
    <text class="c" x="20" y="64" style="fill:#888076">  ← create_purchase_order</text>
    <text class="c" x="14" y="92">outbox.jsonl</text>
    <text class="c" x="20" y="108" style="fill:#888076">  ← send_slack_alert</text>
    <text class="c" x="20" y="124" style="fill:#888076">  ← draft_email_to_supplier</text>
    <text class="c" x="14" y="152">erp_writes.jsonl</text>
    <text class="c" x="20" y="168" style="fill:#888076">  ← update_erp_record</text>
    <text class="c" x="14" y="208" style="fill:#7a2a2a">这是"agent 真正改了什么"</text>
    <text class="c" x="14" y="224" style="fill:#7a2a2a">的唯一来源。审计走这里。</text>
    <text class="c" x="14" y="260">追加式 JSONL：一行一个对象，</text>
    <text class="c" x="14" y="276">不可变。便于回放与诊断。</text>
  </g>

  <!-- relations -->
  <line class="rel" x1="260" y1="80" x2="290" y2="80" marker-end="url(#arr)"/>
  <line class="rel" x1="260" y1="80" x2="290" y2="240" marker-end="url(#arr)"/>
  <line class="rel" x1="520" y1="80" x2="550" y2="80" marker-end="url(#arr)"/>
  <line class="rel" x1="260" y1="240" x2="290" y2="240" marker-end="url(#arr)"/>
  <line class="rel" x1="660" y1="80" x2="800" y2="160" marker-end="url(#arr)"/>
  <line class="rel" x1="405" y1="240" x2="800" y2="240" marker-end="url(#arr)"/>
</svg>`;
  document.getElementById("data-schema").innerHTML = svg;
}

// 2. 术语表
function renderTerms() {
  const html = TERMS.map(t => `
    <div class="term">
      <h4>${t.zh} <span class="en">${t.en}</span></h4>
      <p>${t.desc}</p>
      ${t.fx ? `<span class="fx">${t.fx}</span>` : ""}
    </div>
  `).join("");
  document.getElementById("terms").innerHTML = html;
}

// 3. 工具列表（Before 区，深色）
function renderLegacyTools() {
  const tagMap = { keep:"tag-keep", code:"tag-code", skill:"tag-skill", del:"tag-del" };
  const tagText = { keep:"保留", code:"代码执行", skill:"→skill", del:"删除" };
  const html = TOOLS.map(t => `
    <li>
      <span class="name">${t.name}<span class="tag ${tagMap[t.fate]}">${tagText[t.fate]}</span></span>
      <span class="desc">${t.desc}</span>
    </li>
  `).join("");
  document.getElementById("legacy-tools").innerHTML = html;
}

// 4. Subagents v1
function renderLegacySubagents() {
  const html = SUBAGENTS_V1.map(s => `
    <li>
      <span class="name">${s.name}</span>
      <span class="desc">${s.desc}</span>
    </li>`).join("");
  document.getElementById("legacy-subagents").innerHTML = html;
}

// 5. Skills v2
function renderSkills() {
  const html = SKILLS.map(s => `
    <li>
      <span class="name">${s.name}</span>
      <span class="desc">${s.desc}</span>
    </li>`).join("");
  document.getElementById("skills-list").innerHTML = html;
}

// 6. Prompt anatomy（条形图）
function renderPromptAnatomy() {
  const max = Math.max(...PROMPT_SECTIONS.map(s => s.lines));
  const colors = { move:"#d4a25a", compute:"#7fc7c0", delete:"#e89a9a", keep:"#9ec9a3" };
  const html = PROMPT_SECTIONS.map(s => {
    const pct = (s.lines / max) * 100;
    return `<div class="prompt-bar">
      <div class="pb-name">${s.name}</div>
      <div class="pb-bar"><i style="width:${pct}%;background:${colors[s.dest]}"></i></div>
      <div class="pb-lines">${s.lines} 行</div>
      <div class="pb-dest ${s.dest}">${s.label}</div>
    </div>`;
  }).join("");
  document.getElementById("prompt-anatomy").innerHTML = html;
}

// 7. SHORT prompt 内容
function renderShortPrompt() {
  document.getElementById("short-prompt").textContent = SHORT_PROMPT_TEXT;
}

// 8. Before / After 架构图
function renderBeforeDiagram() {
  const svg = `
<svg viewBox="0 0 1120 460" xmlns="http://www.w3.org/2000/svg" aria-label="Before architecture">
  <defs>
    <marker id="bar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#e8d9a8"/>
    </marker>
    <style>
      .box { fill:#2a2820; stroke:#a89460; stroke-width:1.5; rx:10; }
      .box.warn { stroke:#c66a1a; }
      .box.bad { stroke:#b53636; }
      .t-title { font: 600 14px var(--serif, Georgia); fill:#fff5d2; }
      .t-sub { font: 11.5px ui-monospace, Menlo, monospace; fill:#c2b48b; }
      .t-mini { font: 10.5px ui-monospace, Menlo, monospace; fill:#9c8e6a; }
      .edge { stroke:#a89460; stroke-width:1.2; fill:none; }
      .edge-hot { stroke:#e89a9a; stroke-width:1.5; fill:none; stroke-dasharray:3 3;}
    </style>
  </defs>

  <!-- Messages API loop -->
  <g>
    <rect class="box" x="40" y="30" width="280" height="100"/>
    <text class="t-title" x="60" y="55">stockpilot.py · agent loop</text>
    <text class="t-sub" x="60" y="76">手写 while turns &lt; 25</text>
    <text class="t-sub" x="60" y="94">raw Messages API · tool_use ↔ tool_result</text>
    <text class="t-sub" x="60" y="112">66 行 · 全部状态在内存</text>
  </g>

  <!-- 402 line prompt -->
  <g>
    <rect class="box warn" x="40" y="160" width="280" height="240"/>
    <text class="t-title" x="60" y="184">SYSTEM_PROMPT (402 行)</text>
    <text class="t-sub" x="60" y="208">职责 / 工具指南 / 节奏 / 优先级</text>
    <text class="t-sub" x="60" y="224">调拨 / 促销 / 补货公式</text>
    <text class="t-sub" x="60" y="240">供应商打分 / 8 家备注 / 季节日历</text>
    <text class="t-sub" x="60" y="256">输出格式 / 7 个示例 / 升级矩阵</text>
    <text class="t-sub" x="60" y="272">边缘情况 / 失败恢复 / 术语表</text>
    <text class="t-sub" x="60" y="288">合规 / What NOT to do / 清单</text>
    <text class="t-mini" x="60" y="316" style="fill:#e89a9a">⚠ 每一轮都进 context</text>
    <text class="t-mini" x="60" y="334" style="fill:#e89a9a">⚠ 每一轮都付 token</text>
    <text class="t-mini" x="60" y="352" style="fill:#e89a9a">⚠ 修改一处要重读整段</text>
  </g>

  <!-- 12 tools -->
  <g>
    <rect class="box" x="380" y="30" width="320" height="370"/>
    <text class="t-title" x="400" y="55">12 个工具 (tools.py · 220 行)</text>
    <text class="t-sub" x="400" y="80">get_stock_level(sku, warehouse)</text>
    <text class="t-sub" x="400" y="100">list_low_stock()  ←  返回 ~400 行 CSV</text>
    <text class="t-sub" x="400" y="120">get_sales_velocity(sku, days=14)</text>
    <text class="t-sub" x="400" y="140">forecast_demand(sku, note)</text>
    <text class="t-sub" x="400" y="160">get_supplier_catalog(sku)</text>
    <text class="t-sub" x="400" y="180">compare_supplier_quotes(sku)</text>
    <text class="t-sub" x="400" y="200">create_purchase_order(sku, sup, qty)</text>
    <text class="t-sub" x="400" y="220">update_erp_record(sku, field, value)</text>
    <text class="t-sub" x="400" y="240">send_slack_alert(sku, summary)</text>
    <text class="t-sub" x="400" y="260">draft_email_to_supplier(sup, sku, qty)</text>
    <text class="t-sub" x="400" y="280">generate_weekly_report(warehouse)</text>
    <text class="t-sub" x="400" y="300">search_web_for_disruptions(query)</text>
    <text class="t-mini" x="400" y="332" style="fill:#e89a9a">⚠ 3 个工具内部 call subagent</text>
    <text class="t-mini" x="400" y="350">    forecast_demand / compare_supplier_quotes</text>
    <text class="t-mini" x="400" y="368">    send_slack_alert / draft_email_to_supplier</text>
  </g>

  <!-- 3 subagents -->
  <g>
    <rect class="box bad" x="760" y="30" width="320" height="190"/>
    <text class="t-title" x="780" y="55">3 个硬编码 subagent</text>
    <text class="t-sub" x="780" y="80">forecasting_subagent(sku, note)</text>
    <text class="t-mini" x="780" y="96">  ← 把 90 天历史塞进 system prompt</text>
    <text class="t-mini" x="780" y="112">  → 返回散文。主 agent 自己抽数字</text>
    <text class="t-sub" x="780" y="138">procurement_subagent(sku, quotes)</text>
    <text class="t-mini" x="780" y="154">  → 返回"我建议 SUP-04 因为..."</text>
    <text class="t-sub" x="780" y="180">writing_subagent(kind, payload)</text>
    <text class="t-mini" x="780" y="196">  → 起草 Slack / 邮件文案</text>
  </g>

  <!-- CSV files -->
  <g>
    <rect class="box" x="760" y="250" width="320" height="150"/>
    <text class="t-title" x="780" y="275">直接读 ../data/*.csv</text>
    <text class="t-sub" x="780" y="298">products / stock_levels / sales_history</text>
    <text class="t-sub" x="780" y="316">suppliers / supplier_catalog</text>
    <text class="t-sub" x="780" y="340">写出 → sinks/*.jsonl</text>
    <text class="t-mini" x="780" y="368">每个工具自己开 file handle。无 MCP 层。</text>
  </g>

  <!-- edges -->
  <path class="edge" d="M180,130 L180,160" marker-end="url(#bar)"/>
  <path class="edge" d="M320,80 L380,80" marker-end="url(#bar)"/>
  <path class="edge" d="M320,90 L380,90"/>
  <path class="edge-hot" d="M700,150 C 730,150 730,80 760,80" marker-end="url(#bar)"/>
  <path class="edge" d="M700,290 L760,310" marker-end="url(#bar)"/>

  <!-- legend -->
  <g transform="translate(40,420)">
    <text class="t-mini" x="0" y="0">实线 = 直接调用 · 红色虚线 = 工具内部偷偷起 subagent（黑盒）</text>
  </g>
</svg>`;
  document.getElementById("diagram-before").innerHTML = svg;
}

function renderAfterDiagram() {
  const svg = `
<svg viewBox="0 0 1120 460" xmlns="http://www.w3.org/2000/svg" aria-label="After architecture">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#5a5346"/>
    </marker>
    <style>
      .box { fill:#fffdf3; stroke:#d8ccae; stroke-width:1.2; rx:10; }
      .box.cma  { stroke:#2a6f6a; }
      .box.skill { stroke:#b4842b; }
      .box.sub  { stroke:#a23b3b; }
      .t-title { font: 600 14px var(--serif, Georgia); fill:#1c1a14; }
      .t-sub { font: 11.5px ui-monospace, Menlo, monospace; fill:#5a5346; }
      .t-mini { font: 10.5px ui-monospace, Menlo, monospace; fill:#8a7d5a; }
      .edge { stroke:#5a5346; stroke-width:1.2; fill:none; }
      .edge-cond { stroke:#b4842b; stroke-width:1.5; fill:none; stroke-dasharray:5 4; }
    </style>
  </defs>

  <!-- short prompt -->
  <g>
    <rect class="box" x="40" y="30" width="280" height="100"/>
    <text class="t-title" x="60" y="55">SHORT_PROMPT (15 行)</text>
    <text class="t-sub" x="60" y="78">角色 + 沙箱路径约定</text>
    <text class="t-sub" x="60" y="96">"&gt;5 SKU 写脚本"</text>
    <text class="t-sub" x="60" y="114">"业务策略住在 skill 里"</text>
  </g>

  <!-- CMA runtime -->
  <g>
    <rect class="box cma" x="40" y="160" width="280" height="240"/>
    <text class="t-title" x="60" y="184">Claude Managed Agents runtime</text>
    <text class="t-sub" x="60" y="210">agent_toolset_20260401:</text>
    <text class="t-sub" x="74" y="228">· Bash（沙箱内）</text>
    <text class="t-sub" x="74" y="246">· 文件读写（/mnt/user/）</text>
    <text class="t-sub" x="74" y="264">· Task（可派子 agent）</text>
    <text class="t-sub" x="60" y="294">数据：/mnt/user/data/</text>
    <text class="t-sub" x="74" y="312">  products / stock_levels / sales_history</text>
    <text class="t-sub" x="74" y="330">  suppliers / supplier_catalog</text>
    <text class="t-sub" x="60" y="358">写出：/mnt/user/sinks/</text>
    <text class="t-sub" x="74" y="376">  purchase_orders / outbox / erp_writes</text>
  </g>

  <!-- 5 skills -->
  <g>
    <rect class="box skill" x="380" y="30" width="320" height="370"/>
    <text class="t-title" x="400" y="55">5 个 skill（按需加载）</text>
    <text class="t-sub" x="400" y="84">reorder-policy/SKILL.md</text>
    <text class="t-mini" x="400" y="100">  触发：reorder / restock / PO</text>
    <text class="t-mini" x="400" y="116">  内容：补货公式 + 调拨判断 + 加急规则</text>
    <text class="t-sub" x="400" y="144">supplier-selection/SKILL.md</text>
    <text class="t-mini" x="400" y="160">  打分公式 + 12 家供应商覆盖项</text>
    <text class="t-sub" x="400" y="188">forecasting/SKILL.md  + 2 .py 脚本</text>
    <text class="t-mini" x="400" y="204">  Path A: rolling_mean.py / batch_days_of_cover.py</text>
    <text class="t-mini" x="400" y="220">  Path B: 派 forecaster subagent</text>
    <text class="t-sub" x="400" y="248">notify-templates/SKILL.md</text>
    <text class="t-mini" x="400" y="264">  Slack / 邮件 / 升级三个模板 + 路由矩阵</text>
    <text class="t-sub" x="400" y="292">weekly-report/SKILL.md</text>
    <text class="t-mini" x="400" y="308">  结构 + 数据源 + "单脚本聚合 67k 行"</text>
    <text class="t-mini" x="400" y="346" style="fill:#8a5a14">▲ skill = description + 正文 + 可选 .py 脚本</text>
    <text class="t-mini" x="400" y="362" style="fill:#8a5a14">▲ 不被触发时 = 0 token 进 context</text>
    <text class="t-mini" x="400" y="378" style="fill:#8a5a14">▲ 共 ~400 行知识，比 prompt 略少</text>
  </g>

  <!-- forecaster -->
  <g>
    <rect class="box sub" x="760" y="30" width="320" height="200"/>
    <text class="t-title" x="780" y="55">callable forecaster (1 个)</text>
    <text class="t-sub" x="780" y="80">独立的 Messages API agent</text>
    <text class="t-sub" x="780" y="98">自己有 Bash · 读 sales_history.csv</text>
    <text class="t-sub" x="780" y="116">在自己 context 里跑预测</text>
    <text class="t-sub" x="780" y="142" style="fill:#7a2a2a">主 agent 只发 (sku, flags, horizon)</text>
    <text class="t-sub" x="780" y="160" style="fill:#7a2a2a">forecaster 只返回 JSON：</text>
    <text class="t-mini" x="780" y="180">  {forecast_qty, confidence,</text>
    <text class="t-mini" x="780" y="196">   method, flags}</text>
    <text class="t-mini" x="780" y="220" style="fill:#8a5a14">↑ typed contract — 没有散文进主 ctx</text>
  </g>

  <!-- sandbox bash -->
  <g>
    <rect class="box" x="760" y="260" width="320" height="140"/>
    <text class="t-title" x="780" y="285">沙箱内 Bash · 单脚本聚合</text>
    <text class="t-sub" x="780" y="308">Python 直接 csv.DictReader</text>
    <text class="t-sub" x="780" y="326">~67k 行 stock_levels 在沙箱内迭代</text>
    <text class="t-sub" x="780" y="344">只把 N 行 JSON 结果回到主 ctx</text>
    <text class="t-mini" x="780" y="372" style="fill:#2a6f6a">↑ compute-over-context — 数据加工在这里</text>
  </g>

  <!-- edges -->
  <path class="edge" d="M180,130 L180,160" marker-end="url(#ar2)"/>
  <path class="edge-cond" d="M320,260 L380,200" marker-end="url(#ar2)"/>
  <path class="edge-cond" d="M700,200 L760,150" marker-end="url(#ar2)"/>
  <path class="edge" d="M320,310 L760,320" marker-end="url(#ar2)"/>

  <!-- legend -->
  <g transform="translate(40,420)">
    <text class="t-mini" x="0" y="0">实线 = 始终在线 · 黄虚线 = skill 被描述命中后才载入 · forecaster 仅在 Path B 触发</text>
  </g>
</svg>`;
  document.getElementById("diagram-after").innerHTML = svg;
}

// 9. F1 trace renderers (静态版，供页面通读)
function renderTrace(elId, items) {
  const html = items.map((it,i) => {
    if (it.kind === "group") return `<div class="group">— ${it.text} —</div>`;
    return `<div class="step"><span class="n">${String(i).padStart(2,"·")}</span><span>${it.text}</span><span class="cost">${it.tk||""}</span></div>`;
  }).join("");
  document.getElementById(elId).innerHTML = html;
}

// 10. 12 工具命运表
function renderFateTable(filter = "all") {
  const fateLabel = {
    keep:  { txt: "保留",    css: "tag-keep-light"  },
    code:  { txt: "代码执行", css: "tag-code-light"  },
    skill: { txt: "改 skill", css: "tag-skill-light" },
    del:   { txt: "删除",    css: "tag-del-light"   },
  };
  const head = `
    <thead><tr>
      <th>工具</th><th>原本干什么</th><th>命运</th><th>为什么</th>
    </tr></thead>`;
  const rows = TOOLS
    .filter(t => filter === "all" || t.fate === filter)
    .map(t => `<tr>
      <td class="tool">${t.name}</td>
      <td>${t.desc}</td>
      <td class="fate"><span class="tag ${fateLabel[t.fate].css}">${fateLabel[t.fate].txt}</span></td>
      <td>${t.note}</td>
    </tr>`).join("");
  document.getElementById("fate-table").innerHTML = head + "<tbody>" + rows + "</tbody>";
}

function renderFateFilter() {
  const btns = [
    { k:"all", label:"全部 (12)" },
    { k:"keep", label:"保留 (2)" },
    { k:"code", label:"代码执行 (4)" },
    { k:"skill", label:"改 skill (5)" },
    { k:"del", label:"删除 (1)" },
  ];
  const el = document.getElementById("fate-filter");
  el.innerHTML = btns.map(b => `<button data-k="${b.k}">${b.label}</button>`).join("");
  el.querySelector('[data-k="all"]').classList.add("active");
  el.addEventListener("click", e => {
    const btn = e.target.closest("button"); if (!btn) return;
    el.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderFateTable(btn.dataset.k);
  });
}

// 11. policy map
function renderPolicyMap() {
  const head = `<div class="policy-row head">
      <div class="label">业务策略</div>
      <div class="before">v1 · Before 在哪</div>
      <div class="after">v2 · After 在哪</div>
    </div>`;
  const body = POLICY_MAP.map(p => `
    <div class="policy-row">
      <div class="label">${p.label}</div>
      <div class="before">${p.before}</div>
      <div class="after">${p.after}</div>
    </div>`).join("");
  document.getElementById("policy-map").innerHTML = head + body;
}


// 12. counter animations
function animateCounters() {
  const els = document.querySelectorAll("[data-anim='counters'] .big");
  els.forEach(el => {
    const from = parseFloat(el.dataset.from);
    const to   = parseFloat(el.dataset.to);
    const sfx  = el.dataset.suffix || "";
    const dur  = 1400, start = performance.now();
    function tick(t) {
      const k = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const v = from + (to - from) * e;
      el.textContent = Math.round(v) + sfx;
      if (k < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

// 13. F1 simulator
function f1Init() {
  // 初始静态填
  function fill(elId, items) {
    const html = items.map((it,i) => {
      if (it.kind === "group") return `<div class="group" data-i="${i}">— ${it.text} —</div>`;
      return `<div class="step" data-i="${i}"><span class="n">${String(i).padStart(2,"·")}</span><span>${it.text}</span><span class="tk">${it.tk||""}</span></div>`;
    }).join("");
    document.getElementById(elId).innerHTML = html;
  }
  fill("f1-before", F1_BEFORE);
  fill("f1-after",  F1_AFTER);

  document.getElementById("f1-b-total").textContent = F1_BEFORE.length;
  document.getElementById("f1-a-total").textContent = F1_AFTER.length;

  // 真实测量：488s / 102 calls / ~200k tok（before）; 100s / 3 scripts / ~4.5k tok（after）
  const realBefore = { secs: 488, toks: 200000 };
  const realAfter  = { secs: 100, toks:   4500 };

  let timer = null;
  let bi = 0, ai = 0;
  const elB = document.getElementById("f1-before");
  const elA = document.getElementById("f1-after");

  function reset() {
    if (timer) { clearInterval(timer); timer = null; }
    bi = ai = 0;
    elB.querySelectorAll(".step,.group").forEach(n => n.classList.remove("on"));
    elA.querySelectorAll(".step,.group").forEach(n => n.classList.remove("on"));
    elB.scrollTop = elA.scrollTop = 0;
    document.getElementById("f1-b-step").textContent = 0;
    document.getElementById("f1-a-step").textContent = 0;
    document.getElementById("f1-b-time").textContent = 0;
    document.getElementById("f1-a-time").textContent = 0;
    document.getElementById("f1-b-tok").textContent  = 0;
    document.getElementById("f1-a-tok").textContent  = 0;
  }

  function play() {
    if (timer) return;
    reset();
    const speed = +document.getElementById("f1-speed").value;
    // base interval: 280ms / speed
    const ivl = Math.max(40, Math.round(400 / speed));
    // step→time/tok 增长按 "完成份额 × 真实总值"
    const totalB = F1_BEFORE.length, totalA = F1_AFTER.length;
    timer = setInterval(() => {
      const doneB = bi < totalB;
      const doneA = ai < totalA;
      if (doneB) {
        const node = elB.querySelector(`[data-i="${bi}"]`);
        if (node) {
          node.classList.add("on");
          node.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
        const frac = (bi + 1) / totalB;
        document.getElementById("f1-b-step").textContent = bi + 1;
        document.getElementById("f1-b-time").textContent = Math.round(frac * realBefore.secs);
        document.getElementById("f1-b-tok").textContent  = Math.round(frac * realBefore.toks).toLocaleString();
        bi++;
      }
      // After 跑得快得多（步数少 + 真实壁时短），但我们让动画同时间长以便对比 → 每 N 个 tick 推一步
      const tickRatio = totalB / totalA;
      // 让 after 平均推进同样比例
      if (doneA && (bi % Math.max(1, Math.round(tickRatio)) === 0)) {
        const node = elA.querySelector(`[data-i="${ai}"]`);
        if (node) {
          node.classList.add("on");
          node.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
        const frac = (ai + 1) / totalA;
        document.getElementById("f1-a-step").textContent = ai + 1;
        document.getElementById("f1-a-time").textContent = Math.round(frac * realAfter.secs);
        document.getElementById("f1-a-tok").textContent  = Math.round(frac * realAfter.toks).toLocaleString();
        ai++;
      }
      if (!doneB && !doneA) { clearInterval(timer); timer = null; }
    }, ivl);
  }

  document.getElementById("f1-play").addEventListener("click", play);
  document.getElementById("f1-reset").addEventListener("click", reset);
}

// ───────────────────── boot ─────────────────────
document.addEventListener("DOMContentLoaded", () => {
  renderDataSchema();
  renderTerms();
  renderLegacyTools();
  renderLegacySubagents();
  renderSkills();
  renderPromptAnatomy();
  renderShortPrompt();
  renderBeforeDiagram();
  renderAfterDiagram();
  renderTrace("before-trace", F1_BEFORE);
  renderTrace("after-trace",  F1_AFTER);
  renderFateFilter();
  renderFateTable();
  renderPolicyMap();
  f1Init();
  // counter animation on intersection
  const obs = new IntersectionObserver((entries, o) => {
    entries.forEach(en => {
      if (en.isIntersecting) { animateCounters(); o.disconnect(); }
    });
  }, { threshold: 0.4 });
  obs.observe(document.querySelector(".stat-strip"));
});
