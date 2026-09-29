#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kimi Agent 智能基金投资分析引擎 (Kimi Fund Investment Copilot)
=============================================================
Fork 自 touzi/fund_agent.py（已脱钩 touzi，全面改为 daimon finance 包内相对导入，
所有状态路径在调用时经 `._state` 解析，凭证经 `_state.credential()` 读取）。

daimon 约定：主 agent 应优先自己对 `assemble_context()` 返回的客观数据做推理；
本模块的 LLM 报告（audit / brief / dca / ask）仅为可选补充，非必需链路。

功能：
  1. 调用 Kimi (优先使用用户本地已登录的 Kimi CLI 订阅 kimi -p，亦支持 Moonshot API)
  2. 结合真实持仓、每日定投记录、RBSA净值预测、全组合行业穿透数据生成专业投研分析
  3. 支持四大核心分析模式：
     - audit: 投资组合体检与穿透集中度诊断 (Portfolio Audit)
     - brief: 每日市场归因与基金异动深度复盘 (Daily Briefing)
     - dca: 今日定投决策建议与加仓指引 (Smart DCA Advice)
     - ask: 交互式投资咨询与自由问答 (Interactive Copilot)
"""

import json
import subprocess
from typing import Dict, Any

from . import _state


def call_kimi(prompt: str, timeout: int = 120) -> str:
    """
    调用 Kimi 生成分析报告
    优先通过本地已登录的 Kimi CLI (`kimi -p ... --output-format stream-json`)
    若未安装或异常则尝试通过 OpenAI-compatible API
    """
    # 方式一：尝试本地已认证的 kimi CLI
    try:
        proc = subprocess.run(
            ["kimi", "-p", prompt, "--output-format", "stream-json"],
            capture_output=True,
            text=True,
            timeout=timeout
        )
        if proc.returncode == 0:
            contents = []
            for line in proc.stdout.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    if data.get("role") == "assistant" and "content" in data:
                        contents.append(data["content"])
                except Exception:
                    pass
            clean_text = "".join(contents).strip()
            if clean_text:
                return clean_text
    except Exception as e:
        print(f"[kimi_agent] 本地 kimi CLI 调用异常: {e}")

    # 方式二：尝试环境变量中的 MOONSHOT_API_KEY / KIMI_API_KEY
    api_key = _state.credential("MOONSHOT_API_KEY") or _state.credential("KIMI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "未配置 Kimi API key：请将 MOONSHOT_API_KEY 或 KIMI_API_KEY 写入 "
            f"{_state.home()}/.env（每行一条 KEY=VALUE），或导出同名环境变量；"
            "也可以登录本地 `kimi` CLI 后重试。"
        )
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url="https://api.moonshot.cn/v1")
        completion = client.chat.completions.create(
            model="moonshot-v1-auto",
            messages=[
                {"role": "system", "content": "你是一位拥有十余年全球资产配置经验的资深基金投资专家与量化顾问。"},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3
        )
        return completion.choices[0].message.content or ""
    except Exception as e:
        print(f"[kimi_agent] Moonshot API 调用异常: {e}")

    # 降级提示
    return (
        "【Kimi 分析提示】未能获取到 Kimi 的响应。请确认本地 `kimi` CLI 是否处于登录可用状态，"
        f"或将 MOONSHOT_API_KEY 写入 {_state.home()}/.env。"
    )


def assemble_context() -> Dict[str, Any]:
    """收集当前系统的完整客观数据作为 Agent 的上下文"""
    from .portfolio import calculate_portfolio, load_transactions
    from .industry import analyze_portfolio_lookthrough

    portfolio = calculate_portfolio()
    transactions = load_transactions()[-10:]  # 最近10笔交易
    lookthrough = analyze_portfolio_lookthrough(portfolio.get("positions", []))

    # 读取净值预测 artifact
    artifact = _state.read_json(_state.state_path("artifact_latest.json"), {})

    # 读取市场热点雷达（市场→热点→基金分析层）
    hotspot = _state.read_json(_state.state_path("hotspot.json"), {})

    return {
        "portfolio": portfolio,
        "recent_transactions": transactions,
        "lookthrough": lookthrough,
        "artifact": artifact,
        "hotspot": hotspot
    }


def _hotspot_section(hotspot: Dict[str, Any]) -> str:
    """把热点雷达压缩成适合注入 prompt 的紧凑文本段"""
    if not hotspot:
        return ""
    market = hotspot.get("market", {})
    themes = sorted(hotspot.get("themes", []), key=lambda t: -t.get("heat", 0))[:8]
    funds = hotspot.get("funds", {})
    fund_lines = []
    for code, fh in funds.items():
        fund_lines.append({
            "代码": code, "诊断": fh.get("verdict"), "热点浓度": fh.get("chase_score"),
            "热主题": [f"{t['name']}({t['pct']}%/热度{t['heat']})" for t in fh.get("hot_themes", [])],
            "冷主题": [f"{t['name']}({t['pct']}%/热度{t['heat']})" for t in fh.get("cold_themes", [])],
        })
    return f"""=== 市场热点雷达（主题动量与基金追热点行为） ===
- 市场状态：{market.get('regime')}（广度 {market.get('breadth', 0):.0%}）· {market.get('summary', '')}
- 当前最热的主题：{json.dumps([{ '主题': t.get('name'), '热度': t.get('heat'), '5日%': t.get('ret5'), '20日%': t.get('ret20'), '技术信号': [s.get('label') for s in t.get('signals', [])] } for t in themes], ensure_ascii=False)}
- 各基金追热点画像：{json.dumps(fund_lines, ensure_ascii=False)}

"""


def analyze_portfolio_audit() -> str:
    """Agent 模式 1：持仓体检与穿透集中度诊断"""
    ctx = assemble_context()
    p = ctx["portfolio"]
    lt = ctx["lookthrough"]

    prompt = f"""你是一位全球资产配置与公募基金资深投顾专家。请根据以下投资者的【真实持仓数据】和【底层行业与标的穿透分析】，撰写一份专业、中肯、洞察深刻的投资组合体检与诊断报告。

=== 投资者当前组合数据 ===
- 累计总投入本金：¥{p.get('total_cost', 0):,.2f}
- 当前组合总市值：¥{p.get('total_market_value', 0):,.2f}
- 累计浮动盈亏：¥{p.get('total_pnl', 0):,.2f} ({p.get('total_pnl_pct', 0):.2f}%)
- 今日预估浮动盈亏：¥{p.get('today_est_pnl', 0):,.2f} ({p.get('today_est_ret_pct', 0):.2f}%)
- 持仓基金明细：
{json.dumps([{
    '代码': pos['code'], '名称': pos['name'], '持有市值(¥)': pos['market_value'],
    '成本均价': pos['avg_cost_price'], '最新净值': pos['nav'], '盈亏率%': pos['pnl_pct'],
    '组合占比%': pos['portfolio_weight']
} for pos in p.get('positions', []) if pos.get('shares', 0) > 0], ensure_ascii=False, indent=2)}

=== 行业穿透与集中度数据 ===
- 细分产业链穿透敞口（Top 6）：
{json.dumps(lt.get('sub_industries', [])[:6], ensure_ascii=False, indent=2)}
- 跨基金重叠持仓个股（重点排查隐形伪分散风险）：
{json.dumps(lt.get('overlapping_stocks', []), ensure_ascii=False, indent=2)}
- 组合穿透前十大底层标的：
{json.dumps(lt.get('top_stocks_lookthrough', [])[:8], ensure_ascii=False, indent=2)}
- 系统初步风险评级：{lt.get('risk_metrics', {}).get('level')} ({'；'.join(lt.get('risk_metrics', {}).get('reasons', []))})

{_hotspot_section(ctx["hotspot"])}=== 报告输出要求 ===
请包含以下几个模块，使用结构清晰的 Markdown 格式输出：
1. **组合画像与健康度综合评分**（满分100分，简述风格属性与风险承受度匹配性）
2. **底层行业与标的穿透深度诊断**（重点剖析：是否存在名义分散但实际重度暴露在存储/算力等单一周期的现象，跨基金重叠标的对组合波动的影响）
3. **关键下行风险点预警**（如外盘波动、海外出口政策、行业周期下行拐点对组合的压力测试）
4. **具体调仓与配置优化建议**（给出清晰可落地的加仓、减仓、定投再平衡操作指引）
请言简意赅、逻辑严密、专业客观，杜绝泛泛而谈的套话。"""

    return call_kimi(prompt)


def analyze_daily_brief() -> str:
    """Agent 模式 2：每日市场归因与净值变动复盘"""
    ctx = assemble_context()
    p = ctx["portfolio"]
    art = ctx["artifact"]
    funds = art.get("funds", [])

    prompt = f"""你是一位专注于 QDII 全球科技与混合型基金的量化分析师。请结合今日各市场的收盘/盘中数据与基金净值预测，为投资者撰写一份【每日复盘与市场归因报告】。

=== 今日市场与基金预测截面 ===
- 任务模式：{art.get('jobLabel', '净值预测')}（更新时间：{art.get('updatedAt', '')}）
- 官方概括：{art.get('summary', '')}
- 基金预测与估值明细：
{json.dumps([{
    '代码': f.get('code'), '名称': f.get('name'),
    '官方净值': f.get('officialNav'), '官方日收益%': f.get('officialRet'),
    '预测净值': f.get('predNav'), '预测日涨跌%': f.get('predRet'), '预测版本': f.get('predLabel'),
    '核心驱动权重': f.get('weights', [])[:4],
    '盘中实时参考': f.get('intraday', {})
} for f in funds], ensure_ascii=False, indent=2)}

=== 投资者持仓影响 ===
- 投资者当前总持仓市值：¥{p.get('total_market_value', 0):,.2f}
- 预计今日账户盈亏变动：¥{p.get('today_est_pnl', 0):,.2f} ({p.get('today_est_ret_pct', 0):.2f}%)

{_hotspot_section(ctx["hotspot"])}=== 报告输出要求 ===
请用专业清晰的 Markdown 格式输出：
1. **今日核心复盘速览**（一句话总结今日海外科技、亚太半导体与A股AI产业链的整体涨跌主线）
2. **各持仓基金涨跌归因拆解**（重点指出是哪些因子（如美存储、AI芯片、光通信、A股硬件等）在拉动或拖累净值）
3. **对个人持仓的实际冲击与心理账户指引**（客观评估涨跌是否符合预期波动范围，提示投资者无需恐慌或过度盲从）
4. **今晚/明日重点观察窗口**（美股盘前、纳指期货、关键科技财报或宏观数据催化剂）"""

    return call_kimi(prompt)


def analyze_dca_advice() -> str:
    """Agent 模式 3：智能定投决策建议与加仓指引"""
    ctx = assemble_context()
    p = ctx["portfolio"]
    lt = ctx["lookthrough"]
    funds = ctx["artifact"].get("funds", [])

    prompt = f"""你是一位擅长右侧趋势与左侧定投平摊成本的基金投资顾问。投资者习惯每天/每周进行定投，请根据当前的【回撤幅度】、【均线位置】、【行业穿透敞口】与【持仓盈亏】，给出今日的定投决策与执行方案。

=== 各基金当前估值与技术面信号 ===
{json.dumps([{
    '代码': f.get('code'), '名称': f.get('name'),
    '官方最新净值': f.get('officialNav'), '今日预测涨跌%': f.get('predRet'),
    '技术信号': f.get('signals', []),
    '预测误差带': f.get('band', '')
} for f in funds], ensure_ascii=False, indent=2)}

=== 投资者当前持仓结构 ===
- 组合总投入：¥{p.get('total_cost', 0):,.2f}  |  总市值：¥{p.get('total_market_value', 0):,.2f}
- 累计收益率：{p.get('total_pnl_pct', 0):.2f}%
- 各基金仓位比重与盈亏：
{json.dumps([{
    '代码': pos['code'], '名称': pos['name'], '盈亏率%': pos['pnl_pct'],
    '组合占比%': pos['portfolio_weight'], '成本价': pos['avg_cost_price'], '当前净值': pos['nav']
} for pos in p.get('positions', []) if pos.get('shares', 0) > 0], ensure_ascii=False, indent=2)}

=== 组合穿透行业分布 ===
{json.dumps(lt.get('sub_industries', [])[:5], ensure_ascii=False, indent=2)}

=== 报告输出要求 ===
请以清晰易懂的 Markdown 格式输出：
1. **今日定投总基调**（【积极加仓】/【标准定投】/【小额防御】/【暂停观望】，并说明核心逻辑）
2. **单基金定投优先级排序**（结合距历史高点回撤幅度、破位情况与当前持仓占比，推荐今天最值得投哪只或哪两只基金）
3. **具体金额分配建议模板**（假设今日预算 ¥500 或 ¥1000，如何分配至推荐标的）
4. **纪律与风控提示**（止损止盈预案、不要补仓哪些已经过度超配的板块）"""

    return call_kimi(prompt)


def ask_copilot(user_query: str) -> str:
    """Agent 模式 4：交互式自由咨询与研报解读"""
    ctx = assemble_context()
    p = ctx["portfolio"]
    lt = ctx["lookthrough"]

    prompt = f"""你是一位专注于全球资产配置与公募基金分析的智能投顾助手。
请结合以下关于该投资者的真实组合数据，以专业、客观、耐心的态度回答用户的问题。

=== 投资者基础信息摘要 ===
- 组合总资产：¥{p.get('total_market_value', 0):,.2f}，累计盈亏：{p.get('total_pnl_pct', 0):.2f}%
- 主要持仓：{', '.join([f"{pos['name']}(占比{pos['portfolio_weight']}%,盈亏{pos['pnl_pct']}%)" for pos in p.get('positions', []) if pos.get('shares', 0) > 0])}
- 穿透前三行业：{', '.join([f"{s['name']}({s['pct']}%)" for s in lt.get('sub_industries', [])[:3]])}
- 跨基金重叠标的：{', '.join([s['name'] for s in lt.get('overlapping_stocks', [])[:4]])}

=== 用户提问 ===
{user_query}

=== 分析框架指引（视问题类型选用） ===
- 若问题涉及**个股/企业估值**（DCF、相对估值、成长股溢价、新兴市场折价等）：遵循达莫达兰《估值》的方法论——先区分价值与价格，估值锚定现金流、增长与风险三要素，明确说明假设；警惕仅为高成长支付过高倍数。
- 若问题涉及**A股公司质地/排雷**（ROE、现金流、商誉、关联交易等）：遵循唐朝《手把手教你读财报》的排除法思路——用经营现金流与净利润的匹配度、ROE 持续性、有息负债与商誉占比先排除坏企业，再谈好坏价格。
- 若问题涉及**买卖时机/技术形态**：参考尼森蜡烛图纪律——形态必须置于趋势与支撑阻力背景中解读，先定止损与风险收益比再谈进场。

请用条理清晰、有数据支撑的 Markdown 格式回答用户。"""

    return call_kimi(prompt)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Kimi Agent 智能基金投研助手")
    parser.add_argument("mode", choices=["audit", "brief", "dca", "ask"], default="audit", nargs="?", help="分析模式")
    parser.add_argument("--query", "-q", default="", help="自由咨询的问题文本 (用于 ask 模式)")

    args = parser.parse_args()

    print(f"[Kimi Agent] 正在启动分析引擎 (模式: {args.mode})...")
    if args.mode == "audit":
        report = analyze_portfolio_audit()
    elif args.mode == "brief":
        report = analyze_daily_brief()
    elif args.mode == "dca":
        report = analyze_dca_advice()
    elif args.mode == "ask":
        q = args.query or "请帮我评价一下当前组合的整体配置思路？"
        report = ask_copilot(q)

    print("\n" + "=" * 64)
    print("                Kimi Agent 智能投研分析报告                 ")
    print("=" * 64 + "\n")
    print(report)
    print("\n" + "=" * 64)
