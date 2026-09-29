#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
腾讯理财通 (tencentwm.com) 持仓与每日盈亏客户端
================================================
通过网页端内部接口获取:
  - 当前持仓快照 (每只基金市值 / 可用份额 / 累计收益)
  - 指定日期的每只基金日盈亏 (持仓变化)
  - 累计收益总览
  - 交易流水 (买入 / 卖出 / 分红 / 定投)

认证方式: 凭证归 FINANCE_HOME/.env 的 LCT_COOKIE (经 _state.credential 读取,
先加载 home()/.env 再读环境变量)，值为 www.tencentwm.com 的完整 Cookie 字符串
(从已登录浏览器 DevTools -> Application -> Cookies 复制, 至少包含 qluin / qlskey)。

注意: 所有金额字段单位都是「分」, 本模块统一在返回值里附加 _yuan 字段 (元, float)。

Fork 自 touzi/licaitong_client.py，凭证归 FINANCE_HOME/.env 的 LCT_COOKIE。
"""

import re
import json
import datetime
from typing import Any, Dict, List, Optional

import requests

from . import _state

BASE = "https://www.tencentwm.com"
TRPC = BASE + "/fbp/fund/v1/trpc.com.tencent.fit.fubillplat.query.vo.facade.FubillplatQueryVoService"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")


class LctAuthError(RuntimeError):
    """Cookie 缺失或已失效。"""


def _parse_cookie(cookie_str: str) -> Dict[str, str]:
    out = {}
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _g_tk(qlskey: str) -> int:
    """理财通网页端防伪 token: 取 qlskey 前 24 字符做经典 skey hash。
    算法来自 tencentwm.com 页面 mod.js 的 $.ajaxToken()。"""
    t = 5381
    for ch in qlskey[:24]:
        t += (t << 5) + ord(ch)
    return t & 0x7FFFFFFF


def _fen_to_yuan(v: Any) -> Optional[float]:
    try:
        return round(int(v) / 100.0, 2)
    except (TypeError, ValueError):
        return None


class LicaitongClient:
    def __init__(self, cookie: Optional[str] = None, timeout: int = 15):
        cookie = cookie or (_state.credential("LCT_COOKIE") or "")
        if not cookie:
            raise LctAuthError("缺少凭证 LCT_COOKIE (www.tencentwm.com 的登录 Cookie)")
        self.cookies = _parse_cookie(cookie)
        if "qlskey" not in self.cookies:
            raise LctAuthError("LCT_COOKIE 中缺少 qlskey 字段")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": UA,
            "Cookie": cookie,
            "Referer": BASE + "/web/v3/account/account.shtml",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": BASE,
        })

    # ---------------- 内部 ----------------

    # 理财通 fcgi 响应里含 \x28 / \( 这类非法 JSON 转义, 先还原/清洗再解析
    _HEX_ESCAPE = re.compile(r"\\x([0-9a-fA-F]{2})")
    _BAD_ESCAPE = re.compile(r'\\(?!["\\/bfnrtu])')

    @classmethod
    def _loads(cls, text: str) -> dict:
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            text = cls._HEX_ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), text)
            return json.loads(cls._BAD_ESCAPE.sub("", text))

    def _post(self, url: str, *, form: Optional[dict] = None, payload: Optional[dict] = None) -> dict:
        resp = self.session.post(url, data=form, json=payload, timeout=self.timeout)
        resp.raise_for_status()
        data = self._loads(resp.text)
        # 登录失效时理财通常见返回: retcode 非 0 或跳登录导致 HTML/空对象
        if isinstance(data, dict):
            rc = str(data.get("retcode", "0"))
            if rc not in ("0",) :
                raise LctAuthError(f"接口返回 retcode={rc} retmsg={data.get('retmsg')} (Cookie 可能已失效)")
        return data

    # ---------------- 公开 API ----------------

    def get_holdings(self) -> Dict[str, Any]:
        """当前持仓快照。返回 lct_qry_all_category_asset.fcgi 的关键字段。"""
        raw = self._post(BASE + "/fcgi/lct_qry_all_category_asset.fcgi",
                         form={"g_tk": _g_tk(self.cookies["qlskey"])})
        funds: List[Dict[str, Any]] = []
        for item in raw.get("user_sp_list", []):
            funds.append({
                "fund_code": item.get("fund_code"),
                "fund_name": item.get("fund_brief_name") or item.get("fund_full_name"),
                "spid": item.get("spid"),
                "market_value_fen": int(item.get("product_money", 0) or 0),
                "market_value_yuan": _fen_to_yuan(item.get("product_money", 0)),
                "redeemable_fen": int(item.get("can_redem_money", 0) or 0),
                "redeemable_yuan": _fen_to_yuan(item.get("can_redem_money", 0)),
                "shares": item.get("product_unit"),
                "position_profit_fen": item.get("position_profit") or None,
            })
        return {
            "total_market_value_yuan": _fen_to_yuan(raw.get("product_balance", 0)),
            "yesterday_profit_yuan": _fen_to_yuan(raw.get("yday_profit", 0)),
            "total_profit_yuan": _fen_to_yuan(raw.get("total_profit", 0)),
            "lqt_fund_code": raw.get("lqt_fund_code"),          # 余额+ 货币基金
            "lqt_last_profit_yuan": _fen_to_yuan(raw.get("lqt_last_profit", 0)),
            "on_the_way_num": int(raw.get("on_the_way_num", 0) or 0),  # 在途交易数
            "funds": funds,
            "raw": raw,
        }

    def get_daily_profit(self, date: Optional[str] = None) -> Dict[str, Any]:
        """指定日期每只基金的日盈亏 (持仓变化)。
        date: 'YYYYMMDD', 默认昨天。返回金额为分, 附 _yuan 字段。"""
        if date is None:
            date = (datetime.date.today() - datetime.timedelta(days=1)).strftime("%Y%m%d")
        raw = self._post(TRPC + ".QuerySpecialAccountDayProfit", payload={"time": date})
        items = []
        for it in raw.get("single_asset_profit_list", []):
            items.append({
                "fund_code": it.get("fund_code"),
                "fund_name": it.get("fund_brief_name"),
                "profit_fen": it.get("profit"),
                "profit_yuan": _fen_to_yuan(it.get("profit")),
            })
        items.sort(key=lambda x: x["profit_fen"] if isinstance(x["profit_fen"], int) else 0, reverse=True)
        s = raw.get("sum_asset_profit_list", {})
        return {
            "date": s.get("time", date),
            "gain_profit_yuan": _fen_to_yuan(s.get("gain_profit", 0)),
            "lose_profit_yuan": _fen_to_yuan(s.get("lose_profit", 0)),
            "total_profit_yuan": round((_fen_to_yuan(s.get("gain_profit", 0)) or 0)
                                       + (_fen_to_yuan(s.get("lose_profit", 0)) or 0), 2),
            "items": items,
        }

    def get_total_profit(self) -> Dict[str, Any]:
        """累计收益总览 (含每只基金累计盈亏)。"""
        raw = self._post(TRPC + ".QueryTotalAssetProfit", payload={})
        s = raw.get("sum_asset_profit_list", {})
        items = [{
            "fund_code": it.get("fund_code"),
            "fund_name": it.get("fund_brief_name"),
            "profit_yuan": _fen_to_yuan(it.get("profit")),
        } for it in raw.get("single_asset_profit_list", [])]
        return {
            "total_profit_yuan": _fen_to_yuan(s.get("profit", 0)),
            "gain_profit_yuan": _fen_to_yuan(s.get("gain_profit", 0)),
            "lose_profit_yuan": _fen_to_yuan(s.get("lose_profit", 0)),
            "items": items,
        }

    def get_transactions(self, start_date: str, end_date: str) -> List[Dict[str, Any]]:
        """交易流水 (自动翻页)。日期格式 'YYYYMMDD'。"""
        page_info = ""
        out: List[Dict[str, Any]] = []
        while True:
            raw = self._post(TRPC + ".QueryTransBillList", payload={
                "start_date": start_date, "end_date": end_date,
                "year_month": "", "time_type": 1,
                "bill_busi_qry_type": 0, "page_info": page_info,
            })
            bills = raw.get("bill_list", [])
            for b in bills:
                out.append({
                    "bill_id": b.get("bill_listid"),
                    "fund_code": b.get("fund_code"),
                    "fund_name": b.get("fund_brief_name") or b.get("bill_name"),
                    "desc": b.get("bill_sub_desc"),
                    "amount_yuan": _fen_to_yuan(b.get("bill_fee")),
                    "trade_date": b.get("trade_date"),
                    "acc_time": b.get("acc_time"),
                    "busi_type": b.get("bill_busi_type"),
                })
            page_info = raw.get("page_info") or ""
            if not page_info or not bills:
                break
        return out


def get_daily_position_changes(date: Optional[str] = None) -> Dict[str, Any]:
    """便捷入口: 当前持仓 + 指定日期每只基金日盈亏, 供 quickgui-client 的后端直接调用。"""
    client = LicaitongClient()
    return {
        "holdings": client.get_holdings(),
        "daily_profit": client.get_daily_profit(date),
    }


if __name__ == "__main__":
    import sys
    date = sys.argv[1] if len(sys.argv) > 1 else None
    result = get_daily_position_changes(date)
    # 去掉冗余 raw 字段便于阅读
    result["holdings"].pop("raw", None)
    print(json.dumps(result, ensure_ascii=False, indent=2))
