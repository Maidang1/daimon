#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""QDII 基金净值预测共享管线库（RBSA / 夏普风格分析）—— fork 自 touzi/rbsa_lib.py，daimon 原生。
====================================================
方法论与 024239 看板完全一致：
  - 对齐规则：基金 T 日净值 = T 日（同一日历日）美股收盘 + T 日港/A/日/韩股收盘
  - 模型：fund_ret ≈ Σ wᵢ × factor_retᵢ，wᵢ≥0，Σwᵢ≤1，45 交易日滚动，SLSQP
  - 预测：pred_nav(t) = official_nav(t-1) × (1 + Σ wᵢ × factor_retᵢ(t))，逐日链式
  - 误差带：point-in-time 全量回测残差分布
  - 防护：数据源静默断更校验；只认全收盘锁定版

用法：
  python3 -m skills.finance.rbsa <config.json>
config 示例见 multi_fund/<code>/config.json：
{
  "code": "018036",
  "name": "长城全球新能源车股票发起式(QDII)C",
  "signal_window_start": "2026-06-01",
  "baskets": {
    "存储":    {"market": "US", "tickers": ["YF:MU", "YF:SNDK"]},
    "A股硬件": {"market": "ASIA", "tickers": ["IFIND:600183.SH"]}
  }
}
market=US 的篮子在"美股未收盘"状态下不计入预测。
"""
import os, sys, json, re, time, subprocess
import urllib.request
import pandas as pd
import numpy as np
from scipy.optimize import minimize

from . import _state


def _plugins_dir():
    return os.path.expanduser(
        "~/Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/plugins/managed")


def _ifind_tool():
    return os.path.join(_plugins_dir(), "ifind/scripts/ifind_tool.py")


def _yf_tool():
    return os.path.join(_plugins_dir(), "yahoo_finance/scripts/yahoo_finance_tool.py")


WIN = 45
US_HOLIDAYS = {
    "2025-01-01","2025-01-20","2025-02-17","2025-04-18","2025-05-26","2025-06-19",
    "2025-07-04","2025-09-01","2025-11-27","2025-12-25",
    "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-06-19",
    "2026-07-03","2026-09-07","2026-11-26","2026-12-25"}


def fetch(url, ref=None, tries=3):
    h = {"User-Agent": "Mozilla/5.0"}
    if ref:
        h["Referer"] = ref
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=h)
            return urllib.request.urlopen(req, timeout=25).read().decode("utf-8", "ignore")
        except Exception:
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"拉取失败 {url}")


def fund_nav(code):
    """天天基金 pingzhongdata → (净值Series[索引=北京日期], 官方日收益%Series)"""
    raw = fetch(f"http://fund.eastmoney.com/pingzhongdata/{code}.js", "http://fund.eastmoney.com/")
    m = re.search(r"Data_netWorthTrend\s*=\s*(\[.*?\]);", raw, re.S)
    df = pd.DataFrame(json.loads(m.group(1)))
    df["date"] = pd.to_datetime(pd.to_datetime(df["x"], unit="ms", utc=True)
                                .dt.tz_convert("Asia/Shanghai").dt.date)
    nav = df.set_index("date")["y"].sort_index()
    er = df.set_index("date")["equityReturn"].sort_index()
    return nav, er


# Yahoo 日线时间戳 = 交易所当地交易日 00:00。美股（UTC-4/5）normalize 后日期正确；
# 亚洲交易所（UTC+8/+9）当地午夜仍在前一日 UTC，直接 normalize 会错位一天。
# 修复：按代码后缀转交易所时区取当地日期。
YF_TZ = {".KS": "Asia/Seoul", ".KQ": "Asia/Seoul", ".T": "Asia/Tokyo",
         ".HK": "Asia/Hong_Kong", ".SS": "Asia/Shanghai", ".SZ": "Asia/Shanghai"}


_YF_CACHE = {}


def _read_mkt_csv(yf_symbol):
    """读插件预取 CSV（state/mkt_data/<symbol>.csv），仅当日生成视为有效"""
    path = os.path.join(_state.state_dir(), "mkt_data", f"{yf_symbol}.csv")
    if not os.path.exists(path):
        return None
    mtime = pd.Timestamp(os.path.getmtime(path), unit="s", tz="Asia/Shanghai")
    if (pd.Timestamp.now("Asia/Shanghai") - mtime).days >= 1:
        return None
    return pd.read_csv(path)


def _series_from_csv(df, tz):
    """插件 CSV（Date 为 UTC 时间戳）→ 按交易所当地交易日索引的收盘价 Series"""
    idx = pd.to_datetime(df["Date"], format="mixed", utc=True).dt.tz_convert(tz).dt.normalize().dt.tz_localize(None)
    s = pd.Series(df["Close"].values, index=idx).dropna()
    return s[~s.index.duplicated(keep="last")].sort_index()


def _tz_of(ticker):
    tz = "America/New_York"
    for suf, z in YF_TZ.items():
        if ticker.upper().endswith(suf):
            tz = z
            break
    return tz


def yf_prices(ticker, cache_dir, tag):
    """日线 → Series（索引=交易所当地交易日）。优先 kimi-datasource 插件预取 CSV，兜底 Yahoo chart API"""
    if ticker in _YF_CACHE:                # 同一次运行内多只基金共享代码（QQQ/MU/TSM...）只拉一次
        return _YF_CACHE[ticker]
    tz = _tz_of(ticker)
    df = _read_mkt_csv(ticker)
    if df is not None:
        s = _series_from_csv(df, tz)
        if len(s):
            _YF_CACHE[ticker] = s
            return s
    last = None
    for attempt in range(4):
        try:
            url = (f"https://query{1 + attempt % 2}.finance.yahoo.com/v8/finance/chart/{ticker}"
                   f"?range=2y&interval=1d")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            raw = json.loads(urllib.request.urlopen(req, timeout=25).read().decode("utf-8", "ignore"))
            result = raw["chart"]["result"][0]
            ts = result["timestamp"]
            close = result["indicators"]["quote"][0]["close"]
            idx = pd.to_datetime(ts, unit="s", utc=True).tz_convert(tz).normalize().tz_localize(None)
            s = pd.Series(close, index=idx).dropna()
            s = s[~s.index.duplicated(keep="last")].sort_index()
            if len(s) == 0:
                raise ValueError("empty series")
            _YF_CACHE[ticker] = s
            return s
        except Exception as e:
            last = repr(e)
            time.sleep(5 * (attempt + 1))   # 403 限流需要更长退避
    raise RuntimeError(f"Yahoo(server) 拉取失败 {ticker}: {last}")


def ifind_prices(tickers, start, end, cache_dir, tag):
    """A/港股日线：优先 kimi-datasource 插件预取 CSV（iFinD 代码经 Yahoo 符号映射），
    缺失/过期时兜底 Yahoo chart API（定时任务场景插件可能未刷新）→ DataFrame（列=thscode）"""
    px = {}
    for tk in tickers:
        code, ex = tk.split(".")
        ysym = f"{code}.{'SS' if ex == 'SH' else ex}"   # Yahoo 后缀：.SH→.SS，.SZ/.HK 不变
        df = _read_mkt_csv(ysym)
        tz = "Asia/Shanghai" if ex in ("SH", "SZ") else "Asia/Hong_Kong"
        if df is not None:
            s = _series_from_csv(df, tz)
        else:
            s = yf_prices(ysym, cache_dir, "ifind_fb_" + ysym.replace(".", "_"))
        s = s[(s.index >= pd.Timestamp(start)) & (s.index <= pd.Timestamp(end))]
        px[tk] = s
    return pd.DataFrame(px)


def rbsa(win_df, fcols):
    y = win_df["fund"].values
    X = win_df[fcols].values
    n = len(fcols)
    res = minimize(lambda w: ((y - X @ w) ** 2).sum(), np.full(n, 1 / n),
                   bounds=[(0, 1)] * n,
                   constraints=[{"type": "ineq", "fun": lambda w: 1 - w.sum()}],
                   method="SLSQP")
    w = res.x
    r2 = 1 - ((y - X @ w) ** 2).sum() / max(((y - y.mean()) ** 2).sum(), 1e-12)
    return w, float(r2)


def run(cfg):
    code, name = cfg["code"], cfg["name"]
    baskets = cfg["baskets"]
    FCOLS = list(baskets.keys())
    us_baskets = [k for k, v in baskets.items() if v.get("market") == "US"]
    cache_dir = cfg.get("cache_dir", f"/tmp/qdii_{code}")
    out_dir = cfg.get("out_dir", _state.fund_dir(code))

    now = pd.Timestamp.now("Asia/Shanghai")
    today_cn = now.normalize().tz_localize(None)

    # ---------- 1. 数据 ----------
    nav, er = fund_nav(code)
    start = (nav.index[0] - pd.Timedelta(days=6)).strftime("%Y-%m-%d")
    end = today_cn.strftime("%Y-%m-%d")

    series, src_of = {}, {}
    for bname, b in baskets.items():
        yf_tks = [t[3:] for t in b["tickers"] if t.startswith("YF:")]
        ifind_tks = [t[6:] for t in b["tickers"] if t.startswith("IFIND:")]
        for t in yf_tks:
            series[t] = yf_prices(t, cache_dir, "yf_" + t.replace(".", "_").replace("^", ""))
            src_of[t] = "YF"
            time.sleep(1.5)
        if ifind_tks:
            # iFinD 单次请求 ticker 数过多易失败，按 3 个一批分包
            for gi in range(0, len(ifind_tks), 3):
                grp = ifind_tks[gi:gi + 3]
                fr = ifind_prices(grp, start, end, cache_dir, f"ifind_{code}_{len(series)}")
                for c in fr.columns:
                    series[c] = fr[c].dropna()
                    src_of[c] = "IFIND"
                time.sleep(1)

    # 新鲜度校验（静默断更防护）
    us_ref = max((s.index[-1] for t, s in series.items() if src_of[t] == "YF"), default=None)
    stale = []
    for t, s in series.items():
        if len(s) == 0:
            stale.append(f"{t}(空)")
            continue
        lag_ref = us_ref if src_of[t] == "YF" else today_cn
        lim = 4 if src_of[t] == "YF" else 5
        if (lag_ref - s.index[-1]).days > lim:
            stale.append(f"{t}(止{s.index[-1]:%m-%d})")
    if stale:
        raise RuntimeError(f"数据源断更疑似: {stale}")

    raw_px = pd.DataFrame(series).sort_index()

    # 人工核实的收盘价补丁（官方源核实后写入 config.manual_fills，日期=交易所当地交易日）
    for tk, fills in cfg.get("manual_fills", {}).items():
        if tk in raw_px.columns:
            for d, v in fills.items():
                raw_px.loc[pd.Timestamp(d), tk] = float(v)
            print(f"[manual_fills] {tk}: {fills}")
    bdays = pd.bdate_range(nav.index[0], today_cn)
    P = raw_px.reindex(bdays).ffill()
    R = P.pct_change(fill_method=None)

    def basket_ret(b):
        cols = []
        for t in b["tickers"]:
            tk = t.split(":", 1)[1]
            if tk in R.columns:
                cols.append(R[tk])
        return pd.concat(cols, axis=1).mean(axis=1)

    B = pd.DataFrame({n: basket_ret(b) for n, b in baskets.items()})
    M = pd.concat([nav.pct_change().rename("fund"), B], axis=1).dropna()

    # ---------- 1b. 对齐规则检验（同日 vs 前后1日相关性） ----------
    lag_check = {}
    fr = M["fund"]
    for f in FCOLS:
        if baskets[f].get("market") == "US":
            lag_check[f] = {k: round(float(fr.corr(B[f].shift(-k))), 2) for k in (-1, 0, 1)}
    # k=0 应显著最大（shift(-1) 表示因子提前一天）

    # ---------- 2. 当前权重 ----------
    last_nav_date = nav.index[-1]
    last_nav = float(nav.iloc[-1])
    w, r2 = rbsa(M.loc[:last_nav_date].iloc[-WIN:], FCOLS)

    # ---------- 3. 待预测净值（链式） ----------
    us_probe = next((t for t in series if src_of[t] == "YF" and "." not in t.split(".")[-1]), None)
    us_trade_days = set()
    for t, s in series.items():
        if src_of[t] == "YF" and (t.isupper() and "." not in t):  # 美股纯代码
            us_trade_days = set(s.dropna().index)
            break
    if not us_trade_days:  # 兜底：用任一 YF 序列
        for t, s in series.items():
            if src_of[t] == "YF":
                us_trade_days = set(s.dropna().index)
                break

    def us_state(t):
        if t in us_trade_days:
            return "done"
        if t.strftime("%Y-%m-%d") in US_HOLIDAYS:
            return "holiday"
        if t == today_cn:
            return "pending"
        return "holiday"

    def estimable(t):
        if t <= today_cn - pd.Timedelta(days=1):
            return True
        if t == today_cn and now.hour >= 17:
            return True
        return False

    w_us = float(sum(w[FCOLS.index(f)] for f in us_baskets))
    pending = [t for t in bdays if t > last_nav_date and estimable(t)]
    steps, nav_pred = [], last_nav
    for t in pending:
        st = us_state(t)
        fr_t = B.loc[t][FCOLS].fillna(0.0).copy()
        if st != "done":
            for f in us_baskets:
                fr_t[f] = 0.0
        pr = float(w @ fr_t.values)
        nav_pred = nav_pred * (1 + pr)
        contrib = {f: round(float(w[i] * fr_t[f]) * 100, 2) for i, f in enumerate(FCOLS)}
        steps.append({"date": t.strftime("%Y-%m-%d"), "ret": round(pr * 100, 2),
                      "nav": round(nav_pred, 4), "us_state": st,
                      "factor_ret": {f: round(float(B.loc[t, f]) * 100, 2) for f in FCOLS},
                      "contrib": contrib})

    last_state = steps[-1]["us_state"] if steps else None
    if not steps:
        status, note = "无新交易日", "海外市场无新收盘数据，官方净值即为最新"
    elif last_state == "pending":
        status = "待美股收盘"
        note = f"当前预估未含今晚美股变动；美股整体每 ±1% 约影响净值 ±{w_us:.2f}%"
    elif last_state == "holiday":
        status, note = "美股休市", "美股因子冻结，预测仅随亚洲市场因子变动"
    else:
        status, note = "锁定版", "基于全市场真实收盘的正式预测"

    # ---------- 4. 误差带（point-in-time 回测） ----------
    preds, acts = [], []
    for i in range(WIN, len(M)):
        wi, _ = rbsa(M.iloc[i - WIN:i], FCOLS)
        preds.append(float(wi @ M.iloc[i][FCOLS].values))
        acts.append(M.iloc[i]["fund"])
    resid = np.array(acts) - np.array(preds)
    r60 = resid[-60:] if len(resid) >= 60 else resid
    bt = {"days": int(len(resid)),
          "mae": round(float(np.abs(resid).mean()) * 100, 2),
          "p10": round(float(np.percentile(resid, 10)) * 100, 2),
          "p90": round(float(np.percentile(resid, 90)) * 100, 2),
          "within1": round(float((np.abs(resid) < 0.01).mean()) * 100),
          "mae60": round(float(np.abs(r60).mean()) * 100, 2),
          "p1060": round(float(np.percentile(r60, 10)) * 100, 2),
          "p9060": round(float(np.percentile(r60, 90)) * 100, 2)}

    # ---------- 5. 信号 ----------
    ma20 = float(nav.rolling(20).mean().iloc[-1])
    seg = nav.loc[cfg.get("signal_window_start", "2026-06-01"):]
    trough = float(seg.min())
    peak = float(nav.max())
    ref_nav = steps[-1]["nav"] if steps else last_nav
    signals = {
        "ma20": round(ma20, 4), "above_ma20": bool(ref_nav >= ma20),
        "trough": round(trough, 4), "below_trough": bool(ref_nav < trough),
        "ath": round(peak, 4), "dd_from_ath": round((ref_nav / peak - 1) * 100, 1),
    }

    # 官方日收益交叉核对
    er_check = {"date": last_nav_date.strftime("%Y-%m-%d"),
                "from_nav": round(float(nav.pct_change().iloc[-1]) * 100, 2),
                "official": round(float(er.iloc[-1]), 2)}

    result = {
        "fund": {"code": code, "name": name},
        "updated_at": now.strftime("%Y-%m-%d %H:%M") + " 北京时间",
        "official": {"date": last_nav_date.strftime("%Y-%m-%d"), "nav": round(last_nav, 4)},
        "official_er_check": er_check,
        "status": {"label": status, "note": note},
        "steps": steps,
        "pred": steps[-1] if steps else None,
        "weights": {f: round(float(wi) * 100, 1) for f, wi in zip(FCOLS, w)},
        "r2": round(r2, 2),
        "lag_check": lag_check,
        "backtest": bt,
        "signals": signals,
        "nav_tail": {d.strftime("%Y-%m-%d"): round(float(v), 4) for d, v in nav.tail(8).items()},
        "factors": {f: baskets[f]["tickers"] for f in FCOLS},
        "us_baskets": us_baskets,
    }
    _state.write_json(os.path.join(out_dir, "result.json"), result)

    # ---------- 控制台报告 ----------
    print("=" * 64)
    print(f"[OK] {code} {name}")
    print(f"官方净值 {last_nav:.4f}（{last_nav_date:%Y-%m-%d}，官方日收益核对 {er_check['official']:+.2f}% vs 复算 {er_check['from_nav']:+.2f}%）")
    print(f"状态: {status} — {note}")
    for s in steps:
        print(f"  预测 {s['date']}: {s['ret']:+.2f}% → {s['nav']:.4f}  [{s['us_state']}]")
        print(f"    因子收益: {s['factor_ret']}")
        print(f"    贡献分解: {s['contrib']}")
    print(f"当前权重(R2={r2:.2f}): " + ", ".join(f"{f}{wi*100:.0f}%" for f, wi in zip(FCOLS, w) if wi >= 0.005))
    print(f"对齐检验(同日相关性应最大): {lag_check}")
    print(f"误差带: 全量{bt['days']}天 MAE {bt['mae']:.2f}% · 80%带 {bt['p10']:+.2f}%~{bt['p90']:+.2f}% · "
          f"<1%占比 {bt['within1']}% · 近60天 MAE {bt['mae60']:.2f}%")
    print(f"信号: MA20={signals['ma20']:.4f}({'站上' if signals['above_ma20'] else '下方'}) · "
          f"前低={signals['trough']:.4f}({'跌破!' if signals['below_trough'] else '未破'}) · "
          f"距历史高点 {signals['dd_from_ath']}%")
    print("=" * 64)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python3 -m skills.finance.rbsa <config.json>")
        sys.exit(2)
    with open(sys.argv[1], encoding="utf-8") as f:
        cfg = json.load(f)
    try:
        run(cfg)
    except Exception as e:
        print(f"[FAIL] {cfg.get('code')}: {e}", file=sys.stderr)
        sys.exit(1)
