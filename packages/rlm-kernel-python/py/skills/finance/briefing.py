"""每日简报：新终端首页「今日主要指数 + 持仓相关新闻」的数据通路。

产出两个文件（$FINANCE_HOME/state/）：

- ``briefing.json`` —— 首页直接渲染的简报：主要指数行情（Yahoo 直出）、
  新闻列表、快捷建议。**新闻的筛选与影响解读由 agent 完成**：skill 只写结构
  与指数；agent（日报心跳任务或用户在首页点「让 daimon 生成」后的对话）读取
  ``briefing_candidates.json``，筛选 3-6 条、补 ``impact`` / ``funds`` /
  ``prompt`` 字段后写回 ``briefing.json`` 的 ``news``。
- ``briefing_candidates.json`` —— 原始候选：热点雷达（hotspot.json）里的市场
  催化与主题催化，附主题关联基金代码，供 agent 筛选。

同一天内重复生成时保留已有的 agent 新闻（除非显式传入 ``news``）。
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

from . import _state

# 首页指数行：展示名 → Yahoo 符号。与 RBSA 篮子同一行情通道。
BRIEF_INDICES: list[tuple[str, str]] = [
    ("纳斯达克100", "^NDX"),
    ("标普500", "^GSPC"),
    ("道琼斯", "^DJI"),
    ("纳斯达克生物科技", "^NBI"),
]

DEFAULT_SUGGESTIONS: list[str] = [
    "生成今日投资日报",
    "今天持仓表现如何？",
    "扫描我持仓的风险敞口",
]


def _index_quote(ohlc_fn: Any, name: str, ysym: str) -> dict[str, Any] | None:
    """OHLC 最后两根收盘 → {name, value, pct}；失败返回 None（跳过该指数）。"""
    try:
        o = ohlc_fn(ysym)
        closes = o["close"].dropna()
        if len(closes) < 2:
            return None
        last, prev = float(closes.iloc[-1]), float(closes.iloc[-2])
        if prev == 0:
            return None
        return {"name": name, "value": round(last, 2), "pct": round((last / prev - 1) * 100, 2)}
    except Exception as e:  # noqa: BLE001 — 单个指数失败不拖垮整份简报
        print(f"[briefing] {name}({ysym}) 行情失败，跳过: {e}")
        return None


def _news_candidates(hotspot_data: dict[str, Any]) -> list[dict[str, Any]]:
    """热点雷达的市场/主题催化 → 新闻候选（附关联基金代码，供 agent 映射持仓）。"""
    out: list[dict[str, Any]] = []
    market = hotspot_data.get("market") or {}
    for c in (market.get("catalysts") or [])[:6]:
        out.append({
            "title": c.get("title"), "date": c.get("date"), "source": c.get("source"),
            "theme": None, "funds": [],
        })
    for t in (hotspot_data.get("themes") or [])[:8]:
        for c in (t.get("catalysts") or [])[:2]:
            out.append({
                "title": c.get("title"), "date": c.get("date"), "source": c.get("source"),
                "theme": t.get("name"), "funds": t.get("funds") or [],
            })
    return [c for c in out if c.get("title")]


def build(news: list[dict[str, Any]] | None = None, greeting: str | None = None) -> dict[str, Any]:
    """生成 state/briefing.json（+ state/briefing_candidates.json）。

    ``news`` 为 None 且当天简报已存在时，保留简报里已有的 agent 新闻；
    显式传入则覆盖（agent 解读完后也用这个入口回写）。
    """
    from . import hotspot  # 延迟导入：避免模块级循环（hotspot ↔ jobs）

    today = _dt.date.today().isoformat()

    indices = [q for q in (_index_quote(hotspot.ohlc, n, s) for n, s in BRIEF_INDICES) if q]

    hotspot_data = _state.read_json(_state.state_path("hotspot.json"), {})
    candidates = _news_candidates(hotspot_data if isinstance(hotspot_data, dict) else {})
    _state.write_json(_state.state_path("briefing_candidates.json"), {
        "date": today,
        "candidates": candidates,
        "note": "agent 筛选 3-6 条，补 impact(bullish|watch|bearish)/funds(基金名)/prompt 后写入 briefing.json 的 news",
    })

    existing = _state.read_json(_state.state_path("briefing.json"), {})
    if news is None and isinstance(existing, dict) and existing.get("date") == today:
        news = existing.get("news") or []

    hour = _dt.datetime.now().hour
    auto_greeting = "夜深了" if hour < 6 else "早上好" if hour < 12 else "下午好" if hour < 18 else "晚上好"

    payload = {
        "date": today,
        "greeting": greeting or auto_greeting,
        "indices": indices,
        "news": news or [],
        "suggestions": DEFAULT_SUGGESTIONS,
    }
    _state.write_json(_state.state_path("briefing.json"), payload)
    print(f"[briefing] 写出 {_state.state_path('briefing.json')}（指数 {len(indices)} 条，新闻 {len(payload['news'])} 条，候选 {len(candidates)} 条）")
    return {
        "status": "success",
        "date": today,
        "indices": len(indices),
        "news": len(payload["news"]),
        "candidates": len(candidates),
    }
