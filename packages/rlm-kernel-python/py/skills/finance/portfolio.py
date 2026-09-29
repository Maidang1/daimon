#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
投资管理与定投记账核心模块 (Portfolio & DCA Manager)
===================================================
功能：
  1. 记录每日投资金额（买入定投、赎回卖出、现金分红）
  2. 计算持仓份额、持仓成本均价、持仓市值、累计盈亏及盈亏率
  3. 结合当日官方净值与锁定版/盘中实时预测净值，计算今日预估浮动盈亏
  4. 支持 CLI 命令行快速录入与查询，支持 JSON/CSV 导入导出
  5. 持久化存储于 state/transactions.json 与 state/portfolio.json

Fork 自 touzi/portfolio_manager.py：全部状态归 FINANCE_HOME（见 _state.py），
路径在调用时解析（不做模块级路径常量），JSON 读写走 _state 的原子写；
daimon 原生模块，不再依赖 touzi 仓库。
"""

import os
import sys
import re
import json
import time
import uuid
import datetime
import urllib.request
import urllib.parse
import importlib
from typing import Dict, List, Optional, Any

# 显式按子模块导入 _state：包 __init__.py 里有同名全局（dict），
# `from . import _state` 在部分加载顺序下会绑到那个 dict 而非子模块。
try:
    _state = importlib.import_module(f"{__package__}._state") if __package__ else importlib.import_module("_state")
except ImportError:  # standalone 使用（脚本方式加载时，模块目录已在 sys.path）
    import _state


def _tx_file() -> str:
    return _state.state_path("transactions.json")


def _portfolio_file() -> str:
    return _state.state_path("portfolio.json")


def _funds_registry_file() -> str:
    return _state.state_path("funds_registry.json")


# 默认已知基金代码与名称映射
DEFAULT_FUNDS = {
    "016665": "天弘全球高端制造混合(QDII)C",
    "018036": "长城全球新能源车股票发起式(QDII)C",
    "021277": "广发全球精选股票(QDII)人民币C",
    "022184": "富国全球科技互联网股票(QDII)C",
    "024239": "华夏全球科技先锋混合(QDII)C",
}

_BJ_TZ = datetime.timezone(datetime.timedelta(hours=8))


def _http_get(url: str, timeout: int = 10) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://fund.eastmoney.com/",
    })
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "ignore")


def load_user_funds() -> Dict[str, Dict[str, Any]]:
    """加载用户自行添加的基金注册表 {code: {name, nav, nav_date, added_at}}"""
    try:
        return _state.read_json(_funds_registry_file(), {})
    except Exception:
        return {}


def save_user_funds(registry: Dict[str, Dict[str, Any]]) -> None:
    _state.write_json(_funds_registry_file(), registry)


def get_all_funds() -> Dict[str, str]:
    """内置基金 + 用户基金的完整代码→名称映射"""
    merged = dict(DEFAULT_FUNDS)
    for code, info in load_user_funds().items():
        merged[code] = info.get("name", code)
    return merged


def fetch_fund_info(code: str) -> Dict[str, Any]:
    """从天天基金 pingzhongdata 解析基金名称与最新官方净值"""
    raw = _http_get(f"https://fund.eastmoney.com/pingzhongdata/{code}.js")
    name_m = re.search(r'fS_name\s*=\s*"([^"]+)"', raw)
    if not name_m:
        raise ValueError(f"无法获取基金 {code} 的信息，请检查代码是否正确")
    nav, nav_date = None, None
    trend_m = re.search(r"Data_netWorthTrend\s*=\s*(\[.*?\]);", raw, re.S)
    if trend_m:
        try:
            trend = json.loads(trend_m.group(1))
            if trend:
                last = trend[-1]
                nav = round(float(last["y"]), 4)
                nav_date = datetime.datetime.fromtimestamp(last["x"] / 1000, _BJ_TZ).strftime("%Y-%m-%d")
        except Exception:
            pass
    return {"name": name_m.group(1), "nav": nav, "nav_date": nav_date}


def search_funds(keyword: str, limit: int = 20) -> List[Dict[str, Any]]:
    """按代码/名称关键词搜索基金（东方财富基金搜索接口）"""
    kw = (keyword or "").strip()
    if not kw:
        return []
    q = urllib.parse.quote(kw)
    data = json.loads(_http_get(f"https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key={q}"))
    out = []
    for d in data.get("Datas") or []:
        if d.get("CATEGORYDESC") != "基金":
            continue
        base = d.get("FundBaseInfo") or {}
        out.append({
            "code": d.get("CODE"),
            "name": d.get("NAME"),
            "fund_type": base.get("FTYPE", ""),
            "company": base.get("JJGS", ""),
        })
        if len(out) >= limit:
            break
    return out


def add_fund(code: str, name: Optional[str] = None) -> Dict[str, Any]:
    """添加一只基金到用户基金库；已存在时直接返回"""
    code = str(code).strip()
    if not re.fullmatch(r"\d{6}", code):
        raise ValueError("基金代码应为 6 位数字")
    if code in DEFAULT_FUNDS:
        return {"code": code, "name": DEFAULT_FUNDS[code], "builtin": True}
    registry = load_user_funds()
    if code in registry:
        return {"code": code, **registry[code], "exists": True}
    info = fetch_fund_info(code)
    rec = {
        "name": name or info["name"],
        "nav": info["nav"],
        "nav_date": info["nav_date"],
        "added_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    registry[code] = rec
    save_user_funds(registry)
    return {"code": code, **rec}


def remove_fund(code: str) -> bool:
    """从用户基金库移除；内置基金或有交易流水的基金禁止移除"""
    code = str(code).strip()
    if code in DEFAULT_FUNDS:
        raise ValueError("内置基金不可移除")
    if any(tx.get("fund_code") == code for tx in load_transactions()):
        raise ValueError("该基金存在交易流水，无法移除")
    registry = load_user_funds()
    if code not in registry:
        return False
    del registry[code]
    save_user_funds(registry)
    return True


def register_fund(code: str, baskets: Dict[str, Any], name: Optional[str] = None) -> Dict[str, Any]:
    """创建 `<code>/config.json`，把一只基金纳入每日预测流水线（jobs）与热点雷达。

    `baskets` 是 RBSA 因子篮子：`{"篮子名": {"market": "US"/"ASIA", "tickers": [...]}}`，
    ticker 前缀 `YF:`（Yahoo，如 YF:QQQ、YF:285A.T）或 `IFIND:`（同花顺代码，如
    IFIND:300476.SZ、IFIND:1347.HK——注意 IFIND 历史行情依赖 state/mkt_data 的
    预取 CSV，无 CSV 时该篮子抓不到数）。按基金跟踪的指数/重仓行业推断篮子。
    已存在 config.json 时报错——要改篮子直接编辑该文件。"""
    code = str(code).strip()
    if not re.fullmatch(r"\d{6}", code):
        raise ValueError("基金代码应为 6 位数字")
    if not baskets or not isinstance(baskets, dict):
        raise ValueError("baskets 不能为空")
    for bname, b in baskets.items():
        tickers = b.get("tickers") if isinstance(b, dict) else None
        if not tickers or not isinstance(tickers, list):
            raise ValueError(f"篮子 {bname!r} 缺少 tickers 列表")
        for t in tickers:
            if not (str(t).startswith("YF:") or str(t).startswith("IFIND:")):
                raise ValueError(f"ticker {t!r} 需要 YF: 或 IFIND: 前缀")
    cfg_path = os.path.join(_state.fund_dir(code), "config.json")
    if os.path.exists(cfg_path):
        raise ValueError(f"{cfg_path} 已存在；要调整篮子请直接编辑该文件")
    cfg = {"code": code, "name": name or get_fund_name(code), "baskets": baskets}
    _state.write_json(cfg_path, cfg)
    return {"status": "success", "config": cfg_path, "fund": cfg}


def load_transactions() -> List[Dict[str, Any]]:
    """加载交易记录列表，按日期和创建时间排序"""
    try:
        data = _state.read_json(_tx_file(), [])
        return sorted(data, key=lambda x: (x.get("date", ""), x.get("created_at", "")))
    except Exception as e:
        print(f"[portfolio] 读取交易记录异常: {e}")
        return []


def save_transactions(tx_list: List[Dict[str, Any]]) -> None:
    """持久化交易记录列表"""
    _state.write_json(_tx_file(), tx_list)


def get_fund_name(code: str) -> str:
    """获取基金名称"""
    if code in DEFAULT_FUNDS:
        return DEFAULT_FUNDS[code]
    info = load_user_funds().get(code)
    if info:
        return info.get("name", code)
    cfg_path = os.path.join(_state.fund_dir(code), "config.json")
    if os.path.exists(cfg_path):
        try:
            c = _state.read_json(cfg_path, {})
            return c.get("name", code)
        except Exception:
            pass
    return code


def add_transaction(
    fund_code: str,
    amount: float,
    tx_type: str = "buy",
    tx_date: Optional[str] = None,
    nav: Optional[float] = None,
    shares: Optional[float] = None,
    fee: float = 0.0,
    note: str = "",
    fund_name: Optional[str] = None
) -> Dict[str, Any]:
    """
    录入一笔投资交易记录
    :param fund_code: 基金代码（如 '024239'）
    :param amount: 交易金额（¥）
    :param tx_type: 'buy' (单笔买入/手动投), 'dca' (定期定投), 'sell' (卖出/赎回), 'dividend' (分红)
    :param tx_date: 交易日期 (YYYY-MM-DD)，缺省为今日
    :param nav: 成交净值，若未传入则根据金额与份额反推或自动匹配最新净值
    :param shares: 确认份额，若未传入则根据金额和净值计算
    :param fee: 手续费 (¥)
    :param note: 投资原因/备注
    """
    if not tx_date:
        tx_date = datetime.date.today().strftime("%Y-%m-%d")

    fund_code = str(fund_code).strip()
    amount = float(amount)
    fee = float(fee)
    f_name = fund_name or get_fund_name(fund_code)

    # 尝试自动推导份额与净值
    is_inflow = tx_type in ("buy", "dca")
    if nav and nav > 0:
        if shares is None or shares <= 0:
            net_amt = amount - fee if is_inflow else amount
            shares = round(net_amt / nav, 4)
    elif shares and shares > 0:
        if nav is None or nav <= 0:
            nav = round(amount / shares, 4)
    else:
        nav = get_latest_nav_for_fund(fund_code)
        if nav and nav > 0:
            net_amt = amount - fee if is_inflow else amount
            shares = round(net_amt / nav, 4)
        else:
            nav = 1.0
            shares = round(amount / nav, 4)

    tx_id = f"tx_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    record = {
        "id": tx_id,
        "date": tx_date,
        "fund_code": fund_code,
        "fund_name": f_name,
        "type": tx_type,  # 'buy', 'dca', 'sell', 'dividend'
        "amount": round(amount, 2),
        "nav": round(nav, 4) if nav else 1.0,
        "shares": round(shares, 4) if shares else 0.0,
        "fee": round(fee, 2),
        "note": note.strip(),
        "created_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }

    tx_list = load_transactions()
    tx_list.append(record)
    save_transactions(tx_list)
    return record


def delete_transaction(tx_id: str) -> bool:
    """根据交易 ID 删除记录"""
    tx_list = load_transactions()
    initial_len = len(tx_list)
    tx_list = [tx for tx in tx_list if tx.get("id") != tx_id]
    if len(tx_list) < initial_len:
        save_transactions(tx_list)
        return True
    return False


def get_latest_nav_for_fund(fund_code: str) -> Optional[float]:
    """从 artifact 或 result.json 中获取基金最新官方净值"""
    art_path = _state.state_path("artifact_latest.json")
    if os.path.exists(art_path):
        try:
            art = _state.read_json(art_path, {})
            for f_info in art.get("funds", []):
                if f_info.get("code") == fund_code and f_info.get("officialNav"):
                    return float(f_info["officialNav"])
        except Exception:
            pass

    res_path = os.path.join(_state.fund_dir(fund_code), "result.json")
    if os.path.exists(res_path):
        try:
            res = _state.read_json(res_path, {})
            if res.get("fund", {}).get("official_nav"):
                return float(res["fund"]["official_nav"])
        except Exception:
            pass

    info = load_user_funds().get(fund_code)
    if info and info.get("nav"):
        return float(info["nav"])
    return None


def get_market_nav_estimates() -> Dict[str, Dict[str, Any]]:
    """获取所有基金的最新行情、预测净值与盘中估计"""
    market = {}
    art_path = _state.state_path("artifact_latest.json")
    if os.path.exists(art_path):
        try:
            art = _state.read_json(art_path, {})
            for f_info in art.get("funds", []):
                code = f_info.get("code")
                if not code:
                    continue
                market[code] = {
                    "name": f_info.get("name", get_fund_name(code)),
                    "official_nav": f_info.get("officialNav"),
                    "official_date": f_info.get("officialDate"),
                    "official_ret": f_info.get("officialRet"),
                    "pred_nav": f_info.get("predNav"),
                    "pred_ret": f_info.get("predRet"),
                    "pred_date": f_info.get("predDate"),
                    "pred_label": f_info.get("predLabel"),
                    "intraday": f_info.get("intraday", {})
                }
        except Exception:
            pass
    return market


def calculate_portfolio(
    tx_list: Optional[List[Dict[str, Any]]] = None,
    market_data: Optional[Dict[str, Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """
    根据所有交易流水计算组合持仓、成本、盈亏与今日预计变动
    """
    if tx_list is None:
        tx_list = load_transactions()
    if market_data is None:
        market_data = get_market_nav_estimates()

    # 初始化持仓（若某基金在 config.json 中有初始 baseline holdings，则合并）
    positions: Dict[str, Dict[str, Any]] = {}
    for code, name in get_all_funds().items():
        cfg_path = os.path.join(_state.fund_dir(code), "config.json")
        init_shares = 0.0
        init_cost = 0.0
        if os.path.exists(cfg_path):
            try:
                cfg = _state.read_json(cfg_path, {})
                h = cfg.get("holdings")
                if h:
                    init_shares = float(h.get("shares", 0.0))
                    init_cost = float(h.get("cost_amount", 0.0))
            except Exception:
                pass

        positions[code] = {
            "code": code,
            "name": name,
            "shares": init_shares,
            "cost_amount": init_cost,
            "total_bought": init_cost,
            "total_dca": 0.0,
            "total_manual_buy": init_cost,
            "total_sold": 0.0,
            "total_dividend": 0.0,
            "tx_count": 0,
            "dca_count": 0,
            "buy_count": 1 if init_cost > 0 else 0,
            "tx_history": []
        }

    # 遍历交易流水计算
    for tx in tx_list:
        code = tx.get("fund_code")
        if not code:
            continue
        if code not in positions:
            positions[code] = {
                "code": code,
                "name": tx.get("fund_name", get_fund_name(code)),
                "shares": 0.0,
                "cost_amount": 0.0,
                "total_bought": 0.0,
                "total_dca": 0.0,
                "total_manual_buy": 0.0,
                "total_sold": 0.0,
                "total_dividend": 0.0,
                "tx_count": 0,
                "dca_count": 0,
                "buy_count": 0,
                "tx_history": []
            }

        pos = positions[code]
        pos["tx_count"] += 1
        pos["tx_history"].append(tx)

        tx_type = tx.get("type", "buy")
        amt = float(tx.get("amount", 0.0))
        shs = float(tx.get("shares", 0.0))

        if tx_type == "dca":
            pos["shares"] += shs
            pos["cost_amount"] += amt
            pos["total_bought"] += amt
            pos["total_dca"] += amt
            pos["dca_count"] += 1
        elif tx_type == "buy":
            pos["shares"] += shs
            pos["cost_amount"] += amt
            pos["total_bought"] += amt
            pos["total_manual_buy"] += amt
            pos["buy_count"] += 1
        elif tx_type == "sell":
            avg_cost = pos["cost_amount"] / pos["shares"] if pos["shares"] > 0 else 0
            pos["shares"] = max(0.0, pos["shares"] - shs)
            pos["cost_amount"] = max(0.0, pos["cost_amount"] - shs * avg_cost)
            pos["total_sold"] += amt
        elif tx_type == "dividend":
            pos["cost_amount"] = max(0.0, pos["cost_amount"] - amt)
            pos["total_dividend"] += amt

    # 结合最新净值与今日预测计算市值与盈亏
    active_positions = []
    total_cost = 0.0
    total_market_value = 0.0
    total_today_est_pnl = 0.0
    has_active_holdings = False

    for code, pos in positions.items():
        shares = pos["shares"]
        cost = pos["cost_amount"]
        mkt = market_data.get(code, {})
        nav = mkt.get("official_nav")
        if nav is None:
            nav = get_latest_nav_for_fund(code) or 1.0

        avg_cost_price = (cost / shares) if shares > 0 else 0.0
        market_value = shares * nav if nav else 0.0
        pnl = (market_value - cost) if shares > 0 else 0.0
        pnl_pct = (pnl / cost * 100) if cost > 0 else 0.0

        # 今日预估变动：优先使用锁定版预测，其次盘中估计，其次官方收益
        today_ret_pct = 0.0
        today_est_source = "官方最新"
        if mkt.get("pred_ret") is not None:
            today_ret_pct = float(mkt["pred_ret"])
            today_est_source = f"预测({mkt.get('pred_label', '预测')})"
        elif mkt.get("intraday", {}).get("estRet") is not None:
            today_ret_pct = float(mkt["intraday"]["estRet"])
            today_est_source = "盘中实时"
        elif mkt.get("official_ret") is not None:
            today_ret_pct = float(mkt["official_ret"])
            today_est_source = "官方日收益"

        today_est_pnl = market_value * (today_ret_pct / 100.0) if market_value > 0 else 0.0

        pos_summary = {
            "code": code,
            "name": pos["name"],
            "shares": round(shares, 4),
            "cost_amount": round(cost, 2),
            "avg_cost_price": round(avg_cost_price, 4),
            "nav": round(nav, 4) if nav else 1.0,
            "nav_date": mkt.get("official_date", ""),
            "market_value": round(market_value, 2),
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl_pct, 2),
            "today_ret_pct": round(today_ret_pct, 2),
            "today_est_pnl": round(today_est_pnl, 2),
            "today_est_source": today_est_source,
            "total_bought": round(pos["total_bought"], 2),
            "total_dca": round(pos.get("total_dca", 0.0), 2),
            "total_manual_buy": round(pos.get("total_manual_buy", 0.0), 2),
            "total_sold": round(pos["total_sold"], 2),
            "total_dividend": round(pos["total_dividend"], 2),
            "tx_count": pos["tx_count"],
            "dca_count": pos.get("dca_count", 0),
            "buy_count": pos.get("buy_count", 0)
        }

        if shares > 0.0001 or pos["total_bought"] > 0:
            active_positions.append(pos_summary)
            if shares > 0.0001:
                has_active_holdings = True
                total_cost += cost
                total_market_value += market_value
                total_today_est_pnl += today_est_pnl

    # 计算各持仓占组合市值的百分比
    for p in active_positions:
        if total_market_value > 0 and p["shares"] > 0:
            p["portfolio_weight"] = round(p["market_value"] / total_market_value * 100, 2)
        else:
            p["portfolio_weight"] = 0.0

    # 按照市值由高到低排序
    active_positions.sort(key=lambda x: x["market_value"], reverse=True)

    total_pnl = total_market_value - total_cost
    total_pnl_pct = (total_pnl / total_cost * 100) if total_cost > 0 else 0.0
    today_est_ret_pct = (total_today_est_pnl / total_market_value * 100) if total_market_value > 0 else 0.0

    total_dca_amount = sum(p.get("total_dca", 0.0) for p in active_positions)
    total_manual_buy_amount = sum(p.get("total_manual_buy", 0.0) for p in active_positions)

    portfolio_data = {
        "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "total_cost": round(total_cost, 2),
        "total_dca_amount": round(total_dca_amount, 2),
        "total_manual_buy_amount": round(total_manual_buy_amount, 2),
        "total_market_value": round(total_market_value, 2),
        "total_pnl": round(total_pnl, 2),
        "total_pnl_pct": round(total_pnl_pct, 2),
        "today_est_pnl": round(total_today_est_pnl, 2),
        "today_est_ret_pct": round(today_est_ret_pct, 2),
        "holdings_count": len([p for p in active_positions if p["shares"] > 0]),
        "positions": active_positions,
        "has_active_holdings": has_active_holdings
    }

    # 写入缓存文件
    _state.write_json(_portfolio_file(), portfolio_data)

    return portfolio_data


def get_dca_timeline() -> List[Dict[str, Any]]:
    """获取定投时间线与每日投资流水聚合（按日期归纳）"""
    tx_list = load_transactions()
    daily_map: Dict[str, Dict[str, Any]] = {}
    for tx in tx_list:
        d = tx.get("date")
        if not d:
            continue
        if d not in daily_map:
            daily_map[d] = {
                "date": d,
                "total_invested": 0.0,
                "total_sold": 0.0,
                "net_invested": 0.0,
                "tx_count": 0,
                "details": []
            }
        amt = float(tx.get("amount", 0.0))
        t = tx.get("type", "buy")
        if t in ("buy", "dca"):
            daily_map[d]["total_invested"] += amt
            daily_map[d]["net_invested"] += amt
            if t == "dca":
                daily_map[d]["dca_amount"] = daily_map[d].get("dca_amount", 0.0) + amt
            else:
                daily_map[d]["manual_buy_amount"] = daily_map[d].get("manual_buy_amount", 0.0) + amt
        elif t in ("sell", "dividend"):
            daily_map[d]["total_sold"] += amt
            daily_map[d]["net_invested"] -= amt

        daily_map[d]["tx_count"] += 1
        daily_map[d]["details"].append(tx)

    timeline = sorted(daily_map.values(), key=lambda x: x["date"])
    cum_invested = 0.0
    for item in timeline:
        cum_invested += item["net_invested"]
        item["cum_invested"] = round(cum_invested, 2)
        item["total_invested"] = round(item["total_invested"], 2)
        item["total_sold"] = round(item["total_sold"], 2)
        item["net_invested"] = round(item["net_invested"], 2)

    return timeline


def print_summary() -> None:
    """CLI 输出持仓与投资记账概览"""
    p = calculate_portfolio()
    print("=" * 64)
    print("          专业基金投资管理与记账概览 (Portfolio Summary)          ")
    print("=" * 64)
    print(f"统计时间: {p['updated_at']}")
    print(f"累计总投入: ¥{p['total_cost']:,.2f}  |  当前总市值: ¥{p['total_market_value']:,.2f}")

    pnl_sign = "+" if p['total_pnl'] >= 0 else ""
    pnl_color = "\033[91m" if p['total_pnl'] >= 0 else "\033[92m"
    reset_color = "\033[0m"
    print(f"累计总盈亏: {pnl_color}{pnl_sign}¥{p['total_pnl']:,.2f} ({pnl_sign}{p['total_pnl_pct']:.2f}%){reset_color}")

    today_sign = "+" if p['today_est_pnl'] >= 0 else ""
    print(f"今日预估盈亏: {pnl_color}{today_sign}¥{p['today_est_pnl']:,.2f} ({today_sign}{p['today_est_ret_pct']:.2f}%){reset_color}")
    print("-" * 64)
    print(f"{'代码':<8} {'基金名称':<20} {'持仓份额':<10} {'成本价':<8} {'最新净值':<8} {'市值(¥)':<10} {'盈亏%':<8} {'仓位%':<6}")
    print("-" * 64)
    for pos in p["positions"]:
        if pos["shares"] <= 0:
            continue
        p_sign = "+" if pos["pnl_pct"] >= 0 else ""
        print(f"{pos['code']:<8} {pos['name'][:18]:<20} {pos['shares']:<10.2f} {pos['avg_cost_price']:<8.4f} {pos['nav']:<8.4f} {pos['market_value']:<10.2f} {p_sign}{pos['pnl_pct']:<7.2f}% {pos['portfolio_weight']:<5.1f}%")
    print("=" * 64)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="基金投资记账与组合管理工具")
    subparsers = parser.add_subparsers(dest="command")

    # add 命令
    add_parser = subparsers.add_parser("add", help="录入一笔投资/定投记录")
    add_parser.add_argument("--fund", required=True, help="基金代码 (如 024239)")
    add_parser.add_argument("--amount", type=float, required=True, help="投资金额 (元)")
    add_parser.add_argument("--type", choices=["buy", "dca", "sell", "dividend"], default="buy", help="交易类型 (buy:单笔买入, dca:定期定投, sell:卖出, dividend:分红)")
    add_parser.add_argument("--date", default=None, help="交易日期 (YYYY-MM-DD)，缺省为今日")
    add_parser.add_argument("--nav", type=float, default=None, help="成交净值 (可选)")
    add_parser.add_argument("--shares", type=float, default=None, help="确认份额 (可选)")
    add_parser.add_argument("--fee", type=float, default=0.0, help="手续费 (可选)")
    add_parser.add_argument("--note", default="", help="定投原因或备注")

    # list 命令
    list_parser = subparsers.add_parser("list", help="查看所有交易记录")
    list_parser.add_argument("--fund", default=None, help="按基金代码过滤")

    # delete 命令
    del_parser = subparsers.add_parser("delete", help="删除指定交易记录")
    del_parser.add_argument("--id", required=True, help="交易记录 ID")

    # summary 命令
    subparsers.add_parser("summary", help="查看持仓盈亏概况")

    args = parser.parse_args()

    if args.command == "add":
        rec = add_transaction(
            fund_code=args.fund,
            amount=args.amount,
            tx_type=args.type,
            tx_date=args.date,
            nav=args.nav,
            shares=args.shares,
            fee=args.fee,
            note=args.note
        )
        print(f"[OK] 交易已记录: ID={rec['id']}, {rec['date']} {rec['fund_name']}({rec['fund_code']}) {rec['type']} 金额: ¥{rec['amount']:.2f}, 净值: {rec['nav']}, 份额: {rec['shares']}")
        print_summary()
    elif args.command == "list":
        txs = load_transactions()
        if args.fund:
            txs = [t for t in txs if t.get("fund_code") == args.fund]
        print(f"共有 {len(txs)} 笔交易记录:")
        for t in txs:
            print(f"  [{t.get('id')}] {t.get('date')} | {t.get('fund_code')} {t.get('fund_name')} | {t.get('type')} ¥{t.get('amount'):,.2f} | 净值:{t.get('nav')} 份额:{t.get('shares')} | 备注: {t.get('note', '')}")
    elif args.command == "delete":
        ok = delete_transaction(args.id)
        if ok:
            print(f"[OK] 已成功删除交易记录 {args.id}")
        else:
            print(f"[ERROR] 未找到交易记录 {args.id}")
    else:
        print_summary()
