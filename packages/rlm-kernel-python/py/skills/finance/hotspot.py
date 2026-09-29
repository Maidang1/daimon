# -*- coding: utf-8 -*-
"""市场热点 → 基金追热点 → 潜力挖掘 分析模块（fork 自 touzi/hotspot.py）。

链路：主题注册（扫描全部基金 config.json 的 baskets）→ 主题指数动量/热度 →
      蜡烛图信号（尼森规则）→ 基金追热点画像（chase_score / 轮动 / 战绩）→ 潜力股。

输出 state/hotspot.json（即 $FINANCE_HOME/state/hotspot.json），结构见 build() 末尾。
单主题/单基金失败只影响自己，整体不崩。

用法：
  python3 -c "from skills.finance import hotspot; hotspot.build()"   # 直接构建并打印摘要

所有状态归 FINANCE_HOME（见 _state）：基金 config/result 在 $FINANCE_HOME/<code>/，
行情缓存归 $FINANCE_HOME/state/mkt_data/（由 rbsa 模块读写，仅当日有效），
状态 JSON 归 $FINANCE_HOME/state/。路径全部在调用时解析，不设模块级路径常量。

数据源与 rbsa 完全一致：预取 CSV（mkt_data/，仅当日有效）优先，
兜底 Yahoo chart API；实时行情复用 jobs 的腾讯/Yahoo/纳指期货函数。
"""
import http.cookiejar
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

from . import _state
from . import jobs  # 循环引用（jobs ↔ hotspot）：只能模块级导入，调用时访问属性
from . import rbsa
from .industry import STOCK_DATABASE

WIN = rbsa.WIN  # 45 交易日回归窗口，与 rbsa.run 一致

_OHLC_CACHE = {}  # 进程内缓存：Yahoo 符号 → OHLC DataFrame（索引=交易所当地交易日）
_QUOTE_CACHE = None  # 进程内缓存：Yahoo 符号 → 估值字段（一次批量拉全）


def _ysym(raw):
    """iFinD 代码 → Yahoo 符号（.SH→.SS；无后缀的美股代码原样）"""
    if "." not in raw:
        return raw
    code, ex = raw.split(".")
    return f"{code}.{'SS' if ex == 'SH' else ex}"


def _fnum(v):
    """Yahoo 数值字段 → float 或 None（容错脏数据）"""
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _yahoo_quotes(symbols):
    """Yahoo quote API（cookie + crumb 流程）一次批量拉估值字段：
    {yahoo_symbol: {pe, pe_fwd, pb, cap, earnings_ts}}。失败重试 1 次，整体失败返回 {}，
    调用方所有估值字段置 null，不影响主流程。"""
    global _QUOTE_CACHE
    if _QUOTE_CACHE is not None:
        return _QUOTE_CACHE
    out = {}
    if symbols:
        ua = {"User-Agent": "Mozilla/5.0"}
        try:
            cj = http.cookiejar.CookieJar()
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
            crumb = None
            for attempt in range(2):
                try:
                    req = urllib.request.Request("https://fc.yahoo.com", headers=ua)
                    try:
                        opener.open(req, timeout=15)
                    except urllib.error.HTTPError as e:
                        # fc.yahoo.com 固定返回 404，作用只是种 cookie；错误响应也要提取
                        cj.extract_cookies(e, req)
                    crumb = opener.open(urllib.request.Request(
                        "https://query1.finance.yahoo.com/v1/test/getcrumb", headers=ua),
                        timeout=15).read().decode("utf-8", "ignore").strip()
                    if crumb:
                        break
                except Exception:
                    time.sleep(2)
            if not crumb:
                raise RuntimeError("crumb 获取失败")
            last = None
            for attempt in range(2):
                try:
                    url = ("https://query1.finance.yahoo.com/v7/finance/quote?symbols="
                           + ",".join(symbols) + "&crumb=" + urllib.parse.quote(crumb))
                    raw = json.loads(opener.open(urllib.request.Request(url, headers=ua),
                                                 timeout=20).read().decode("utf-8", "ignore"))
                    for r in ((raw.get("quoteResponse") or {}).get("result") or []):
                        sym = r.get("symbol")
                        if sym:
                            ets = r.get("earningsTimestamp")
                            out[sym] = {"pe": _fnum(r.get("trailingPE")),
                                        "pe_fwd": _fnum(r.get("forwardPE")),
                                        "pb": _fnum(r.get("priceToBook")),
                                        "cap": _fnum(r.get("marketCap")),
                                        "earnings_ts": int(ets) if isinstance(ets, (int, float)) else None}
                    break
                except Exception as e:
                    last = repr(e)
                    time.sleep(2)
            else:
                raise RuntimeError(f"quote 拉取失败: {last}")
        except Exception as e:
            print(f"[hotspot] Yahoo 估值拉取失败，估值字段全部为 null: {e}")
            out = {}
    _QUOTE_CACHE = out
    return out


# ---------------- 行情：日线 OHLC（预取 CSV 优先，Yahoo 兜底） ----------------
def _ohlc_from_csv(df, tz):
    idx = pd.to_datetime(df["Date"], format="mixed", utc=True).dt.tz_convert(tz) \
        .dt.normalize().dt.tz_localize(None)
    out = pd.DataFrame({"open": df["Open"].values, "high": df["High"].values,
                        "low": df["Low"].values, "close": df["Close"].values,
                        "volume": df["Volume"].values if "Volume" in df.columns
                        else np.full(len(df), np.nan)}, index=idx)
    out = out.dropna(subset=["close"])
    return out[~out.index.duplicated(keep="last")].sort_index()


def _ohlc_yahoo(t):
    """Yahoo chart API 拉 1 年日线 OHLC，索引转交易所当地交易日（短退避，避免限流时拖死整体）"""
    last = None
    for attempt in range(2):
        try:
            url = (f"https://query{1 + attempt % 2}.finance.yahoo.com/v8/finance/chart/{t}"
                   f"?range=1y&interval=1d")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            raw = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore"))
            result = raw["chart"]["result"][0]
            ts = result["timestamp"]
            q = result["indicators"]["quote"][0]
            idx = pd.to_datetime(ts, unit="s", utc=True).tz_convert(rbsa._tz_of(t)) \
                .normalize().tz_localize(None)
            out = pd.DataFrame({"open": q["open"], "high": q["high"],
                                "low": q["low"], "close": q["close"],
                                "volume": q.get("volume") if q.get("volume") is not None
                                else [np.nan] * len(ts)}, index=idx)
            out = out.dropna(subset=["close"])
            out = out[~out.index.duplicated(keep="last")].sort_index()
            if len(out) == 0:
                raise ValueError("empty series")
            return out
        except Exception as e:
            last = repr(e)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"Yahoo OHLC 拉取失败 {t}: {last}")


def ohlc(ysym):
    """Yahoo 符号 → OHLC DataFrame（进程内缓存，同 ticker 只拉一次）"""
    if ysym in _OHLC_CACHE:
        return _OHLC_CACHE[ysym]
    df = rbsa._read_mkt_csv(ysym)  # 预取 CSV（$FINANCE_HOME/state/mkt_data/），仅当日生成有效
    if df is not None and {"Open", "High", "Low", "Close"}.issubset(df.columns):
        out = _ohlc_from_csv(df, rbsa._tz_of(ysym))
    else:
        time.sleep(0.3)  # 与 jobs 同节奏，避免突发限流
        out = _ohlc_yahoo(ysym)
    _OHLC_CACHE[ysym] = out
    return out


def _maxdd(s, win):
    """序列近 win 个观测的最大回撤 %（负值），数据不足返回 None"""
    tail = s.dropna().tail(win)
    if len(tail) < 2:
        return None
    return round(float((tail / tail.cummax() - 1).min() * 100), 1)


def _pos_pct(s):
    """最新值在序列整个区间的位置分位 0-100（整数），区间退化返回 None"""
    s = s.dropna()
    lo, hi = float(s.min()), float(s.max())
    if hi <= lo:
        return None
    return round(float((s.iloc[-1] - lo) / (hi - lo) * 100))


def _vol_ratio(v):
    """5 日均量 / 60 日均量，保留 2 位；量数据不足返回 None"""
    v = v.dropna()
    if len(v) < 60:
        return None
    vma60 = float(v.tail(60).mean())
    if vma60 <= 0:
        return None
    return round(float(v.tail(5).mean()) / vma60, 2)


# ---------------- 主题注册表 ----------------
def load_fund_configs():
    cfgs = {}
    base = _state.home()
    for d in sorted(os.listdir(base)):
        p = os.path.join(_state.fund_dir(d), "config.json")
        if os.path.isdir(_state.fund_dir(d)) and os.path.exists(p):
            try:
                cfgs[d] = json.load(open(p, encoding="utf-8"))
            except Exception as e:
                print(f"[hotspot] {d}/config.json 读取失败: {e}")
    return cfgs


def build_theme_registry(cfgs):
    """同名主题跨基金合并：ticker 并集 + 使用基金列表"""
    themes = {}
    for code, cfg in cfgs.items():
        for name, b in cfg.get("baskets", {}).items():
            t = themes.setdefault(name, {"market": b.get("market", "US"),
                                         "tickers": [], "_set": set(), "funds": []})
            for tk in b.get("tickers", []):
                if tk not in t["_set"]:
                    t["_set"].add(tk)
                    t["tickers"].append(tk)
            if code not in t["funds"]:
                t["funds"].append(code)
    for t in themes.values():
        t.pop("_set", None)
    return themes


# ---------------- 主题指数：成员等权 OHLC ----------------
def theme_ohlc(tickers):
    """成员各自归一（首收盘=100，OHLC 同比例缩放）后逐日等权平均，对齐工作日历 ffill"""
    cols = []
    for tk in tickers:
        ysym = _ysym(tk.split(":", 1)[1])
        try:
            o = ohlc(ysym)
        except Exception as e:
            print(f"[hotspot] 主题成员 {tk} 行情失败，跳过: {e}")
            continue
        if len(o) < 30:
            print(f"[hotspot] 主题成员 {tk} 数据太短({len(o)}行)，跳过")
            continue
        cols.append(o / o["close"].iloc[0] * 100.0)
    if not cols:
        return None
    first = min(c.index[0] for c in cols)
    last = max(c.index[-1] for c in cols)
    bdays = pd.bdate_range(first, last)
    panel = [c.reindex(bdays).ffill() for c in cols]
    out = pd.DataFrame({k: sum(p[k] for p in panel) / len(panel)
                        for k in ("open", "high", "low", "close")})
    return out.dropna(subset=["close"]).tail(200)


# ---------------- 蜡烛图信号（尼森规则，参考《日本蜡烛图技术新解》史蒂夫·尼森） ----------------
def candle_signals(t, above_ma20):
    """对主题指数最近 3 个交易日 OHLC 检测经典形态，返回 [{label, level}]"""
    sig = []
    o = t["open"].values
    h = t["high"].values
    l = t["low"].values
    c = t["close"].values
    n = len(t)
    if n < 3:
        return sig
    i = n - 1  # 最近一根
    body = abs(c[i] - o[i])
    rng = h[i] - l[i]
    if rng <= 0:
        return sig
    upper = h[i] - max(c[i], o[i])
    lower = min(c[i], o[i]) - l[i]
    d = t.index[i].strftime("%m-%d")
    # 锤子线/吊颈线：下影线 ≥ 3×实体 且 实体位于整根上半部
    if body > 0 and lower >= 3 * body and min(c[i], o[i]) >= l[i] + 0.5 * rng:
        if not above_ma20:
            sig.append({"label": f"{d} 锤子线（超跌反弹信号）", "level": "ok"})
        else:
            sig.append({"label": f"{d} 吊颈线（高位警戒）", "level": "warn"})
    # 流星线：上影线 ≥ 3×实体 且 实体位于下半部，且近期上涨之后
    if body > 0 and upper >= 3 * body and max(c[i], o[i]) <= l[i] + 0.5 * rng \
            and c[i] > c[i - 2]:
        sig.append({"label": f"{d} 流星线（冲高受阻）", "level": "warn"})
    # 吞噬形态：今实体完全覆盖昨实体
    pb = abs(c[i - 1] - o[i - 1])
    if pb > 0:
        if c[i] > o[i] and c[i] >= o[i - 1] and o[i] <= c[i - 1]:
            sig.append({"label": f"{d} 看涨吞没（阳吞阴）", "level": "ok"})
        elif c[i] < o[i] and c[i] <= o[i - 1] and o[i] >= c[i - 1]:
            sig.append({"label": f"{d} 看跌吞没（阴吞阳）", "level": "risk"})
    # 窗口（跳空）：今最低 > 昨最高 = 向上窗口（未封闭=中继）；今最高 < 昨最低 = 向下窗口
    if l[i] > h[i - 1]:
        sig.append({"label": f"{d} 向上窗口（跳空缺口未封闭，中继偏强）", "level": "ok"})
    if h[i] < l[i - 1]:
        sig.append({"label": f"{d} 向下窗口（跳空缺口未封闭，走弱）", "level": "risk"})
    # 迭创新高：近 10 日中 ≥ 8 日收盘价创新高 → 过热警戒
    if n >= 10:
        closes = c[-10:]
        nh = sum(1 for k in range(1, 10) if closes[k] > closes[:k].max())
        if nh >= 8:
            sig.append({"label": f"近10日 {nh} 次迭创新高（短线过热）", "level": "warn"})
    return sig


# ---------------- 股票名称 ----------------
def stock_name(tk):
    code = tk.split(":", 1)[1]
    cands = [code]
    if code.upper().endswith(".HK"):
        cands = [code.split(".")[0].zfill(5), code]
    elif any(code.upper().endswith(s) for s in (".SS", ".SZ", ".SH")):
        cands = [code.split(".")[0], code]
    for k in cands:
        if k in STOCK_DATABASE:
            return STOCK_DATABASE[k]["name"]
    return code


def stock_sector(tk):
    code = tk.split(":", 1)[1]
    cands = [code]
    if code.upper().endswith(".HK"):
        cands = [code.split(".")[0].zfill(5), code]
    elif any(code.upper().endswith(s) for s in (".SS", ".SZ", ".SH")):
        cands = [code.split(".")[0], code]
    for k in cands:
        if k in STOCK_DATABASE:
            return STOCK_DATABASE[k].get("sector")
    return None


# ---------------- 基金画像 ----------------
def fund_accuracy(code, mae60):
    """track.json 战绩：记录数 / 平均绝对偏差 / 命中率（容差 max(0.5%, 1.5×mae60)）"""
    try:
        track = jobs.load_track()
    except Exception:
        track = []
    recs = [t for t in track if t.get("code") == code and t.get("dev") is not None]
    n = len(recs)
    if n == 0:
        return {"n": 0, "hit_rate": None, "avg_dev": None, "note": "暂无核对记录"}
    avg_dev = round(float(np.mean([abs(t["dev"]) for t in recs])), 2)
    thr = max(0.5, 1.5 * (mae60 or 1.0))
    hit = round(float(np.mean([abs(t["dev"]) <= thr for t in recs])) * 100, 1)
    note = "样本不足" if n < 5 else f"容差 ±{thr:.2f}%"
    return {"n": n, "hit_rate": hit, "avg_dev": avg_dev, "note": note}


def fund_rotation(cfg, px, nav=None):
    """复刻 rbsa.run 的数据对齐，在当前 / -30 / -60 交易日三个截止点各做一次 RBSA，
    当前 vs 30 天前权重差 Top3：增大=in（在追），减小=out（在撤）。失败返回 None。"""
    try:
        baskets = cfg["baskets"]
        FCOLS = list(baskets.keys())
        if nav is None:
            nav, _ = rbsa.fund_nav(cfg["code"])
        today_cn = pd.Timestamp.now("Asia/Shanghai").normalize().tz_localize(None)
        bdays = pd.bdate_range(nav.index[0], today_cn)
        P = px.reindex(bdays).ffill()
        R = P.pct_change(fill_method=None)

        def basket_ret(b):
            cols = [R[tk] for tk in (t.split(":", 1)[1] for t in b["tickers"]) if tk in R.columns]
            return pd.concat(cols, axis=1).mean(axis=1) if cols else pd.Series(np.nan, index=R.index)

        B = pd.DataFrame({n: basket_ret(b) for n, b in baskets.items()})
        M = pd.concat([nav.pct_change().rename("fund"), B], axis=1, sort=True).dropna()
        if len(M) < WIN + 62:
            return None
        ws = {}
        for label, pos in (("cur", -1), ("t30", -31), ("t60", -61)):
            cutoff = M.index[pos]
            w, _ = rbsa.rbsa(M.loc[:cutoff].iloc[-WIN:], FCOLS)
            ws[label] = dict(zip(FCOLS, w))
        diffs = sorted(((f, ws["t30"].get(f, 0) * 100, ws["cur"].get(f, 0) * 100,
                         (ws["cur"].get(f, 0) - ws["t30"].get(f, 0)) * 100) for f in FCOLS),
                       key=lambda x: -x[3])
        top_in = [{"name": f, "from": round(a, 1), "to": round(b, 1)}
                  for f, a, b, d in diffs[:3] if d > 0.5]
        top_out = [{"name": f, "from": round(a, 1), "to": round(b, 1)}
                   for f, a, b, d in diffs[-3:][::-1] if d < -0.5]
        return {"asof": M.index[-1].strftime("%Y-%m-%d"), "in": top_in, "out": top_out}
    except Exception as e:
        print(f"[hotspot] {cfg['code']} rotation 失败: {e}")
        return None


def fund_profile(code, cfg, theme_by_name, px):
    """单基金追热点画像。result.json 缺失/损坏时降级为 error 记录，不影响其他基金。"""
    name = cfg.get("name", code)
    rp = os.path.join(_state.fund_dir(code), "result.json")
    if not os.path.exists(rp):
        return {"name": name, "error": "result.json 缺失"}
    try:
        res = json.load(open(rp, encoding="utf-8"))
    except Exception as e:
        return {"name": name, "error": f"result.json 解析失败: {e}"}
    weights = res.get("weights") or {}
    wlist = sorted(({"name": k, "pct": v} for k, v in weights.items() if v >= 0.5),
                   key=lambda x: -x["pct"])
    r2 = res.get("r2")
    mae60 = (res.get("backtest") or {}).get("mae60")

    # chase_score = 权重加权平均主题热度（0-100）
    num = sum(w["pct"] * (theme_by_name.get(w["name"], {}).get("heat") or 50) for w in wlist)
    den = sum(w["pct"] for w in wlist)
    chase_score = round(num / den, 1) if den else None

    def band_of(tn):
        return (theme_by_name.get(tn) or {}).get("band")

    def heat_of(tn):
        return (theme_by_name.get(tn) or {}).get("heat")

    hot_themes = [{"name": w["name"], "pct": w["pct"], "heat": heat_of(w["name"])}
                  for w in wlist if w["pct"] >= 5 and band_of(w["name"]) == "热"]
    cold_themes = [{"name": w["name"], "pct": w["pct"], "heat": heat_of(w["name"])}
                   for w in wlist if w["pct"] >= 10 and band_of(w["name"]) == "冷"]

    # 近 10 日因子贡献累计（占绝对值比例）
    steps = res.get("steps") or []
    recent_contrib = []
    if steps:
        agg = {}
        for s in steps[-10:]:
            for k, v in (s.get("contrib") or {}).items():
                agg[k] = agg.get(k, 0) + v
        tot = sum(abs(v) for v in agg.values())
        if tot:
            recent_contrib = [{"name": k, "pct": round(v / tot * 100, 1)}
                              for k, v in sorted(agg.items(), key=lambda x: -abs(x[1]))]

    # 基金净值风险指标：年化波动率（近20日日收益）/ 近60日最大回撤；净值拉取失败则 null
    nav = None
    try:
        nav, _ = rbsa.fund_nav(cfg["code"])
    except Exception as e:
        print(f"[hotspot] {code} 净值拉取失败: {e}")
    risk = None
    if nav is not None:
        ns = nav.dropna()
        nrets = ns.pct_change(fill_method=None).dropna()
        risk = {"vol20": round(float(nrets.tail(20).std() * np.sqrt(252) * 100), 1)
                if len(nrets) >= 20 else None,
                "maxdd60": _maxdd(ns, 60)}

    # 个股穿透贡献估算：主题 RBSA 权重(≥5%) × 成分股等权 × 个股 ret20，跨主题按个股聚合
    drill = None
    agg = {}
    for w in wlist:
        if w["pct"] < 5:
            continue
        th = theme_by_name.get(w["name"])
        if not th:
            continue
        mems = []
        for td in th.get("tickers", []):
            mtk = td["ticker"]
            mcode = mtk.split(":", 1)[1]
            if mcode in px.columns:
                ms = px[mcode].dropna()
                if len(ms) >= 21:
                    mems.append((mtk, ms))
        if not mems:
            continue
        share = w["pct"] / 100.0 / len(mems)
        for mtk, ms in mems:
            r20 = float(ms.iloc[-1] / ms.iloc[-21] - 1) * 100
            a = agg.setdefault(mtk, {"ticker": mtk, "name": stock_name(mtk),
                                     "theme": w["name"], "wmax": w["pct"], "contrib": 0.0})
            a["contrib"] += share * r20
            if w["pct"] > a["wmax"]:
                a["wmax"] = w["pct"]
                a["theme"] = w["name"]
    if agg:
        items = [{"ticker": a["ticker"], "name": a["name"], "theme": a["theme"],
                  "contrib": round(a["contrib"], 2)} for a in agg.values()]
        drill = {"gain": sorted(items, key=lambda x: -x["contrib"])[:5],
                 "drag": sorted(items, key=lambda x: x["contrib"])[:3],
                 "est": True}

    rotation = fund_rotation(cfg, px, nav)
    accuracy = fund_accuracy(code, mae60)

    # verdict 规则链
    above_w = sum(w["pct"] for w in wlist
                  if theme_by_name.get(w["name"], {}).get("above_ma20"))
    cold_w = sum(t["pct"] for t in cold_themes)
    in_hot = [x["name"] for x in (rotation or {}).get("in", []) if (heat_of(x["name"]) or 0) >= 70]
    out_hot = [x["name"] for x in (rotation or {}).get("out", []) if (heat_of(x["name"]) or 0) >= 70]
    if chase_score is not None and chase_score >= 65 and above_w >= 50:
        verdict = "顺势高热"
    elif cold_w >= 30:
        verdict = "承压，重仓方向遇冷"
    elif in_hot:
        verdict = "正在追热点"
    elif out_hot:
        verdict = "高位撤退"
    else:
        verdict = "结构均衡"

    return {"name": name, "weights": wlist, "r2": r2, "mae60": mae60,
            "chase_score": chase_score, "hot_themes": hot_themes,
            "cold_themes": cold_themes, "recent_contrib": recent_contrib,
            "rotation": rotation, "accuracy": accuracy, "verdict": verdict,
            "risk": risk, "drill": drill}


# ---------------- 主构建 ----------------
def build(verbose=True):
    now = pd.Timestamp.now("Asia/Shanghai")
    today_cn = now.normalize().tz_localize(None)
    cfgs = load_fund_configs()
    registry = build_theme_registry(cfgs)

    # ---------- 1. 全量日线 OHLC（进程内缓存去重） ----------
    uniq = []
    for t in registry.values():
        for tk in t["tickers"]:
            if tk not in uniq:
                uniq.append(tk)
    for tk in uniq:
        try:
            ohlc(_ysym(tk.split(":", 1)[1]))
        except Exception as e:
            print(f"[hotspot] {tk} 行情失败: {e}")
    # 收盘价面板（列=无前缀 iFinD/Yahoo 代码），供个股指标与基金 rotation 共用
    px = pd.DataFrame({tk.split(":", 1)[1]: _OHLC_CACHE[_ysym(tk.split(":", 1)[1])]["close"]
                       for tk in uniq
                       if _ysym(tk.split(":", 1)[1]) in _OHLC_CACHE})
    # 成交量面板（无成交量数据的市场整列为 NaN），供主题/个股量比共用
    vx = pd.DataFrame({tk.split(":", 1)[1]: _OHLC_CACHE[_ysym(tk.split(":", 1)[1])]["volume"]
                       for tk in uniq
                       if _ysym(tk.split(":", 1)[1]) in _OHLC_CACHE})

    def has_px(tk):
        """该成员日线是否已成功载入（临时失败但重试成功的也算）"""
        return _ysym(tk.split(":", 1)[1]) in _OHLC_CACHE

    # ---------- 1.5 估值层：Yahoo quote 批量（一次请求，失败容忍全 null） ----------
    yquotes = _yahoo_quotes(sorted({_ysym(tk.split(":", 1)[1]) for tk in uniq}))
    if verbose:
        n_pe = sum(1 for q in yquotes.values() if q.get("pe") is not None)
        print(f"[hotspot] Yahoo 估值 {len(yquotes)}/{len(uniq)} 只返回，{n_pe} 只有 trailing PE")

    def _quote_fields(tk):
        """个股估值字段：pe/pe_fwd/pb/cap + 财报当地日期（earnings_date）与
        距北京今天天数（days_to_earnings，负值/无数据为 null）"""
        ysym = _ysym(tk.split(":", 1)[1])
        q = yquotes.get(ysym) or {}
        edate = dte = None
        ets = q.get("earnings_ts")
        if ets:
            try:
                edate = pd.Timestamp(int(ets), unit="s", tz="UTC") \
                    .tz_convert(rbsa._tz_of(ysym)).strftime("%Y-%m-%d")
                d = (pd.Timestamp(edate) - today_cn).days
                dte = d if d >= 0 else None
            except Exception:
                edate = dte = None
        return {"pe": q.get("pe"), "pe_fwd": q.get("pe_fwd"), "pb": q.get("pb"),
                "cap": q.get("cap"), "earnings_date": edate, "days_to_earnings": dte}

    # ---------- 2. 实时行情（复用 jobs，一次批量拉全） ----------
    ifind_codes, yf_asia, yf_us = [], [], []
    for t in registry.values():
        for tk in t["tickers"]:
            if tk.startswith("IFIND:"):
                ifind_codes.append(tk[6:])
            elif tk.startswith("YF:"):
                (yf_us if t["market"] == "US" else yf_asia).append(tk[3:])
    live_cn = jobs.fetch_live(sorted(set(ifind_codes))) if ifind_codes else {}
    live_asia = jobs.fetch_live_yf_asia(sorted(set(yf_asia))) if yf_asia else {}
    live_us = jobs.fetch_live_us_prepost(sorted(set(yf_us))) if yf_us else {}
    nq_chg = jobs.fetch_nq_futures()
    if verbose:
        print(f"[hotspot] 实时行情 A/港 {len(live_cn)}/{len(set(ifind_codes))} · "
              f"日韩 {len(live_asia)}/{len(set(yf_asia))} · 美股 {len(live_us)}/{len(set(yf_us))} · "
              f"纳指期货 {nq_chg}")

    INDEX_THEMES = {"纳指100", "泛科技", "纳指科技"}  # 单指数主题，实时可用纳指期货近似

    def member_live(tname, tk):
        if tk.startswith("IFIND:"):
            return live_cn.get(tk[6:]), "tencent"
        if tk.startswith("YF:"):
            if registry[tname]["market"] == "US":
                v = live_us.get(tk[3:])
                if v is None and tname in INDEX_THEMES and nq_chg is not None:
                    return nq_chg, "nq_futures"
                return v, "us_prepost"
            return live_asia.get(tk[3:]), "yahoo_asia"
        return None, None

    # ---------- 3. 主题指标 ----------
    themes_out = []
    heat_raw = {}
    for name, t in registry.items():
        try:
            tf = theme_ohlc(t["tickers"])
            if tf is None or len(tf) < 60:
                print(f"[hotspot] 主题 {name} 指数数据不足，跳过")
                continue
            c = tf["close"]
            ret = lambda n: round(float(c.iloc[-1] / c.iloc[-1 - n] - 1) * 100, 2) if len(c) > n else None
            ma20 = float(c.rolling(20).mean().iloc[-1])
            above = bool(c.iloc[-1] >= ma20)
            # ---- 下钻指标：波动 / 回撤 / 区间位置 / 成员广度 / 量能 / 领涨拖累 ----
            crets = c.pct_change(fill_method=None).dropna()
            vol20 = round(float(crets.tail(20).std() * np.sqrt(252) * 100), 1) \
                if len(crets) >= 20 else None
            breadth_hits, breadth_tot = 0, 0
            member_r20, member_vr = [], []
            for tk in t["tickers"]:
                mcode = tk.split(":", 1)[1]
                if mcode in px.columns:
                    ms = px[mcode].dropna()
                    if len(ms) >= 21:
                        breadth_tot += 1
                        if ms.iloc[-1] >= float(ms.rolling(20).mean().iloc[-1]):
                            breadth_hits += 1
                        member_r20.append({"ticker": tk, "name": stock_name(tk),
                                           "ret20": round(float(ms.iloc[-1] / ms.iloc[-21] - 1) * 100, 2)})
                if mcode in vx.columns:
                    vr = _vol_ratio(vx[mcode])
                    if vr is not None:
                        member_vr.append(vr)
            member_breadth = round(breadth_hits / breadth_tot, 2) if breadth_tot else None
            vol_ratio = round(float(np.median(member_vr)), 2) if member_vr else None
            leaders = sorted(member_r20, key=lambda x: -x["ret20"])[:3]
            laggards = sorted(member_r20, key=lambda x: x["ret20"])[:2]
            lives = [member_live(name, tk) for tk in t["tickers"]]
            vals = [v for v, _ in lives if v is not None]
            if vals:
                live = round(float(np.mean(vals)), 2)
                srcs = sorted({s for _, s in lives if s})
                live_source = "+".join(srcs)
            else:
                live = round(float(c.pct_change().iloc[-1]) * 100, 2)
                live_source = "last_daily"
            hr = 0.45 * (ret(20) or 0) + 0.25 * (ret(60) or 0) + 0.20 * (ret(5) or 0) + 0.10 * live
            heat_raw[name] = hr
            themes_out.append({
                "name": name, "market": t["market"],
                "tickers": [{"ticker": tk, "name": stock_name(tk), "sector": stock_sector(tk)}
                            for tk in t["tickers"] if has_px(tk)],
                "live": live, "live_source": live_source,
                "ret1": ret(1), "ret5": ret(5), "ret20": ret(20), "ret60": ret(60),
                "ma20_dev": round(float(c.iloc[-1] / ma20 - 1) * 100, 2),
                "dist_high": round(float(c.iloc[-1] / c.max() - 1) * 100, 2),
                "vol20": vol20, "maxdd60": _maxdd(c, 60), "pos_pct": _pos_pct(c),
                "member_breadth": member_breadth, "vol_ratio": vol_ratio,
                "leaders": leaders, "laggards": laggards,
                "above_ma20": above,
                "signals": candle_signals(tf, above),
                "funds": t["funds"],
                "_close": c,
            })
        except Exception as e:
            print(f"[hotspot] 主题 {name} 计算失败: {e}")

    hs = pd.Series(heat_raw)
    ranks = hs.rank(pct=True) * 100
    for th in themes_out:
        th["heat"] = round(float(ranks[th["name"]]), 1)
        th["band"] = "热" if th["heat"] >= 70 else ("温" if th["heat"] >= 40 else "冷")
        th.pop("_close")
        # ---- 估值层：成员 trailing PE 中位数（排除 None/负值）+ 30 天内财报临近成员 ----
        pes, soon = [], []
        for td in th["tickers"]:
            qf = _quote_fields(td["ticker"])
            if qf["pe"] is not None and qf["pe"] > 0:
                pes.append(qf["pe"])
            d = qf["days_to_earnings"]
            if d is not None and 0 <= d <= 30:
                soon.append({"ticker": td["ticker"], "name": td["name"],
                             "date": qf["earnings_date"], "days": d})
        th["pe_med"] = round(float(np.median(pes)), 1) if pes else None
        th["earnings_soon"] = sorted(soon, key=lambda x: x["days"])

    # ---------- 4. 基金画像 ----------
    theme_by_name = {t["name"]: t for t in themes_out}
    funds_out = {}
    for code, cfg in cfgs.items():
        try:
            funds_out[code] = fund_profile(code, cfg, theme_by_name, px)
        except Exception as e:
            print(f"[hotspot] 基金 {code} 画像失败: {e}")
            funds_out[code] = {"name": cfg.get("name", code), "error": str(e)[:200]}

    # ---------- 5. 市场情景（breadth + 达利欧四象限轻量语境） ----------
    n_th = len(themes_out)
    breadth = round(float(np.mean([t["above_ma20"] for t in themes_out])), 2) if n_th else None
    qqq_th = next((t for t in themes_out if t["name"] in INDEX_THEMES), None)
    qqq_above = qqq_th["above_ma20"] if qqq_th else None
    if qqq_above and breadth is not None and breadth >= 0.6:
        regime = "risk-on"
        summary = ("风险偏好上行：增长预期主导、通胀约束温和，科技成长领涨；"
                   "关注高位过热主题的回撤风险，不追尖顶。")
    elif qqq_above is False and breadth is not None and breadth < 0.4:
        regime = "risk-off"
        summary = ("避险情景：增长担忧或通胀约束升温，科技成长领跌、广度恶化；"
                   "控仓位、等恐慌释放后的错杀修复。")
    else:
        regime = "neutral"
        summary = ("均衡震荡：增长与通胀信号拉锯，主题轮动加快；"
                   "以结构化景气（业绩验证的方向）为主，少做方向性押注。")
    market = {"regime": regime, "breadth": breadth, "summary": summary}

    # ---------- 5.5 催化剂层（state/catalysts.json，缺失/坏文件容忍为空列表） ----------
    try:
        cat_raw = _state.read_json(_state.state_path("catalysts.json"), {})
        cat_items = [it for it in (cat_raw.get("items") or [])
                     if isinstance(it, dict) and it.get("title")]
    except Exception:
        cat_items = []

    def _as_list(v):
        return v if isinstance(v, list) else []

    def _ticker_keys(raw):
        """代码比对键集合：无前缀代码 / 纯代码 / 纯数字港股 zfill(5)"""
        code = str(raw).split(":", 1)[-1].upper()
        pure = code.split(".")[0]
        keys = {code, pure}
        if pure.isdigit():
            keys.add(pure.zfill(5))
        return keys

    def _cat_brief(it):
        return {"date": it.get("date"), "title": it.get("title"), "source": it.get("source")}

    # 主题挂载：item.themes 命中主题名，或 item.tickers 与主题成员代码有交集（按 date 降序，最多 3 条）
    for th in themes_out:
        keys = set()
        for td in th["tickers"]:
            keys |= _ticker_keys(td["ticker"])
        hits = []
        for it in cat_items:
            if th["name"] in _as_list(it.get("themes")):
                hits.append(it)
                continue
            ikeys = set()
            for s in _as_list(it.get("tickers")):
                ikeys |= _ticker_keys(s)
            if keys & ikeys:
                hits.append(it)
        hits.sort(key=lambda x: str(x.get("date") or ""), reverse=True)
        th["catalysts"] = [_cat_brief(i) for i in hits[:3]]

    # 市场挂载：item.themes 为空或含"宏观"（按 date 降序，最多 8 条）
    mkt_hits = [it for it in cat_items
                if not _as_list(it.get("themes")) or "宏观" in _as_list(it.get("themes"))]
    mkt_hits.sort(key=lambda x: str(x.get("date") or ""), reverse=True)
    market_cats = [_cat_brief(i) for i in mkt_hits[:8]]
    # A股定期报告法定披露截止日（4/30 年报+一季报、8/31 半年报、10/31 三季报）前 35 天内生成提示
    for rm, rd, rname in ((4, 30, "年报+一季报"), (8, 31, "半年报"), (10, 31, "三季报")):
        delta = (pd.Timestamp(today_cn.year, rm, rd) - today_cn).days
        if 0 <= delta <= 35:
            market_cats.insert(0, {"date": today_cn.strftime("%Y-%m-%d"),
                                   "title": f"A股{rname}披露期临近（{rm}/{rd} 截止），重仓 A股的基金波动将放大",
                                   "source": "披露规则"})
            break
    market["catalysts"] = market_cats

    # ---------- 6. 主题成员股 + 潜力股 ----------
    try:
        quality = _state.read_json(_state.state_path("stock_quality.json"), {})
    except Exception:
        quality = {}

    def stock_metrics(tname, tk):
        code = tk.split(":", 1)[1]
        s = px[code].dropna() if code in px.columns else None
        if s is None or len(s) < 61:
            return None
        r20 = round(float(s.iloc[-1] / s.iloc[-21] - 1) * 100, 2)
        r60 = round(float(s.iloc[-1] / s.iloc[-61] - 1) * 100, 2)
        ma = float(s.rolling(20).mean().iloc[-1])
        v, _ = member_live(tname, tk)
        return {"ticker": tk, "name": stock_name(tk), "ret20": r20, "ret60": r60,
                "live": v, "above_ma20": bool(s.iloc[-1] >= ma),
                "vol_ratio": _vol_ratio(vx[code]) if code in vx.columns else None,
                "pos_pct": _pos_pct(s),
                "dist_high": round(float(s.iloc[-1] / s.max() - 1) * 100, 2),
                **_quote_fields(tk)}

    stocks_out = {}
    picks = []
    for t in themes_out:
        rows = []
        for tk in t["tickers"]:
            m = stock_metrics(t["name"], tk["ticker"] if isinstance(tk, dict) else tk)
            if m is None:
                continue
            code = m["ticker"].split(":", 1)[1]
            qk = code.split(".")[0].zfill(5) if code.upper().endswith(".HK") else code.split(".")[0]
            if qk in quality:
                m["quality"] = quality[qk]
            rows.append(m)
            if t["band"] == "热" and m["above_ma20"]:
                reason = (f"{t['name']}主题热度{int(t['heat'])}，"
                          f"个股20日动量{m['ret20']:+.0f}%且站上MA20")
                q = m.get("quality")
                if q and q.get("rev_yoy") is not None:
                    reason += f"，营收同比{q['rev_yoy']:+.0f}%"
                if m.get("pos_pct") is not None and m["pos_pct"] >= 85:
                    reason += "，位置偏高"
                if m.get("pe") is not None and t.get("pe_med") is not None:
                    reason += f"，PE {m['pe']:.0f}×（主题中位 {t['pe_med']:.0f}×）"
                if m.get("pe_fwd") is not None:
                    reason += f"，远期 {m['pe_fwd']:.0f}×"
                picks.append({"ticker": m["ticker"], "name": m["name"], "theme": t["name"],
                              "ret20": m["ret20"], "heat": t["heat"],
                              "pos_pct": m.get("pos_pct"), "pe": m.get("pe"),
                              "reason": reason})
        stocks_out[t["name"]] = sorted(rows, key=lambda x: -x["ret20"])
    top_picks = sorted(picks, key=lambda x: -x["ret20"])[:10]

    out = {"generated_at": now.strftime("%Y-%m-%d %H:%M") + " 北京时间",
           "market": market, "themes": sorted(themes_out, key=lambda x: -x["heat"]),
           "funds": funds_out, "stocks": stocks_out, "top_picks": top_picks}
    _state.write_json(_state.state_path("hotspot.json"), out)
    if verbose:
        print(f"[hotspot] 写出 {_state.state_path('hotspot.json')}")
        print(f"市场情景 {regime}（breadth={breadth}），主题 {len(themes_out)} 个")
        for t in out["themes"]:
            print(f"  {t['band']}·热度{t['heat']:5.1f} {t['name']:<8} ret20 {t['ret20']:+.1f}% "
                  f"ret60 {t['ret60']:+.1f}% live {t['live']:+.2f}% MA20{'上' if t['above_ma20'] else '下'} "
                  f"信号{len(t['signals'])}")
        for code, fd in funds_out.items():
            if fd.get("error"):
                print(f"  {code} {fd['name']}: ERROR {fd['error'][:60]}")
            else:
                print(f"  {code} {fd['name'][:18]}: chase={fd['chase_score']} → {fd['verdict']}")
                g = (fd.get("drill") or {}).get("gain") or []
                if g:
                    print(f"    穿透贡献Top1 {g[0]['name']} {g[0]['contrib']:+.2f}pct · {g[0]['theme']}")
        for p in top_picks:
            print(f"  潜力 {p['ticker']:<14} {p['name']:<8} {p['theme']} ret20 {p['ret20']:+.1f}%")
    return out


if __name__ == "__main__":
    build()
