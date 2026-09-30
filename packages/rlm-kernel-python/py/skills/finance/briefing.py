"""每日简报：新终端首页「今日主要指数 + 持仓相关新闻」的数据通路。

产出两个文件（$FINANCE_HOME/state/）：

- ``briefing.json`` —— 首页直接渲染的简报：主要指数行情（Yahoo 直出）、
  新闻列表。**新闻的筛选与影响解读由 agent 完成**：skill 只写结构与指数；
  agent（日报心跳任务或用户在首页点「让 daimon 生成」后的对话）读取
  ``briefing_candidates.json``，筛选 3-6 条、补 ``impact`` / ``funds`` /
  ``prompt`` 字段后写回 ``briefing.json`` 的 ``news``。候选本身就是「去掉
  impact/prompt 的 news」（含 ``time`` 键，不叫 ``date``），可直接改写。
- ``briefing_candidates.json`` —— 原始候选：热点雷达（hotspot.json）里的市场
  催化与主题催化，附主题关联基金代码，供 agent 筛选。

同一天内重复生成时保留已有的 agent 新闻（除非显式传入 ``news``）。

问候语与快捷建议由前端 AI 首页自己负责（浏览器本地时间 + 前端默认建议列表），
服务端不再各存一份：只有调用方显式传 ``greeting`` 时才写进 ``briefing.json``。

形状契约见 ``contracts.py``（``Briefing`` / ``BriefingNews``），与
``packages/finance-board/src/client/api.ts`` 的 ``Briefing`` 镜像。
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

from . import _state
from .contracts import Briefing, BriefingIndex, BriefingNews

# 首页指数行：展示名 → Yahoo 符号。与 RBSA 篮子同一行情通道。
BRIEF_INDICES: list[tuple[str, str]] = [
    ("纳斯达克100", "^NDX"),
    ("标普500", "^GSPC"),
    ("道琼斯", "^DJI"),
    ("纳斯达克生物科技", "^NBI"),
]


def _index_quote(ohlc_fn: Any, name: str, ysym: str) -> BriefingIndex | None:
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
    """热点雷达的市场/主题催化 → 新闻候选（附关联基金代码，供 agent 映射持仓）。

    每条候选就是一条 ``BriefingNews`` 去掉 ``impact`` / ``prompt``（时间字段叫
    ``time``，前端 ``[news.source, news.time]`` 才能渲染出来），外加一个仅供 agent
    参考的 ``theme`` 提示。
    """
    out: list[dict[str, Any]] = []
    market = hotspot_data.get("market") or {}
    for c in (market.get("catalysts") or [])[:6]:
        out.append({
            "title": c.get("title"), "time": c.get("date"), "source": c.get("source"),
            "theme": None, "funds": [],
        })
    for t in (hotspot_data.get("themes") or [])[:8]:
        for c in (t.get("catalysts") or [])[:2]:
            out.append({
                "title": c.get("title"), "time": c.get("date"), "source": c.get("source"),
                "theme": t.get("name"), "funds": t.get("funds") or [],
            })
    return [c for c in out if c.get("title")]


def build(news: list[BriefingNews] | None = None, greeting: str | None = None) -> dict[str, Any]:
    """生成 state/briefing.json（+ state/briefing_candidates.json）。

    ``news`` 为 None 且当天简报已存在时，保留简报里已有的 agent 新闻；
    显式传入则覆盖（agent 解读完后也用这个入口回写）。
    ``greeting`` 仅在显式传入时写入（前端自带浏览器本地问候兜底）。
    """
    from . import hotspot  # 延迟导入：避免模块级循环（hotspot ↔ jobs）

    today = _dt.date.today().isoformat()

    indices = [q for q in (_index_quote(hotspot.ohlc, n, s) for n, s in BRIEF_INDICES) if q]

    hotspot_data = _state.read_json(_state.state_path("hotspot.json"), {})
    candidates = _news_candidates(hotspot_data if isinstance(hotspot_data, dict) else {})
    _state.write_json(_state.state_path("briefing_candidates.json"), {
        "date": today,
        "candidates": candidates,
    })

    existing = _state.read_json(_state.state_path("briefing.json"), {})
    if news is None and isinstance(existing, dict) and existing.get("date") == today:
        news = existing.get("news") or []

    payload: Briefing = {
        "date": today,
        "indices": indices,
        "news": news or [],
    }
    if greeting:
        payload["greeting"] = greeting
    _state.write_json(_state.state_path("briefing.json"), payload)
    print(f"[briefing] 写出 {_state.state_path('briefing.json')}（指数 {len(indices)} 条，新闻 {len(payload['news'])} 条，候选 {len(candidates)} 条）")
    return {
        "status": "success",
        "date": today,
        "indices": len(indices),
        "news": len(payload["news"]),
        "candidates": len(candidates),
    }
