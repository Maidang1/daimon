# -*- coding: utf-8 -*-
"""QDII 基金净值看板 · 每日任务编排（早 10:00 核对修正 / 午 14:00 预测）

Fork 自 touzi/daily_job.py；所有状态归 FINANCE_HOME（经 _state 在调用时解析）。
====================================================================
用法：
  jobs.main()              # 按 sys.argv 选模式（auto/morning/afternoon）
  morning()                # 核对最新官方净值 vs 历史预测，大偏差修正
  afternoon()              # 生成锁定版预测（全收盘）+ 当日盘中参考（A/港实时）

状态文件（FINANCE_HOME/state/）：
  pred_log.jsonl   预测日志（key: code+navDate+mode，保留最新）
  track.json       战绩记录（官方公布后核对）
  artifact_<mode>.json / artifact_latest.json   看板数据（widget artifact）
"""
import os, sys, json, re, time, datetime, random
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

from . import _state
from . import rbsa

# 实时行情并发度：每个 ticker 一次 HTTP，8 路足够把 Yahoo 的 RTT 重叠掉，
# 又不会对 Yahoo chart API 形成登录态级别的并发压力。
_LIVE_WORKERS = 8

# 行情涨跌幅的脏数据护栏：|涨跌幅| ≥ 25% 基本只可能是拆股/复权错位或源站坏点，
# 而不是真实波动（QDII 单日 ±25% 不存在），直接丢弃而不是喂进估算。
_LIVE_PCT_GUARD = 25.0


# 自动发现：FINANCE_HOME 下存在 config.json 的基金即纳入每日拟合
def _funds():
    home = _state.home()
    return sorted(
        d for d in os.listdir(home)
        if os.path.isdir(os.path.join(home, d)) and os.path.exists(os.path.join(home, d, "config.json"))
    )


# 偏差报警阈值：|偏差| > max(1.2%, 1.5 × 近60日MAE)。实现已下沉到 rbsa（误差模型口径），
# 这里保留同名入口，既有调用方与 CLI 用法都不用改。
def dev_threshold(mae60_pct):
    return rbsa.dev_threshold(mae60_pct)


# ---------------- 状态读写 ----------------
# 实现已下沉到 _state（纯文件 I/O，jobs 之外的轻量模块也能直接 import 它），
# 这里保留同名薄封装，让 jobs 内部与既有调用方继续可用。
def load_pred_log():
    """读取 state/pred_log.jsonl → {(code, navDate, mode): 预测记录}。"""
    return _state.load_pred_log()


def save_pred_log(entries):
    """原子重写 state/pred_log.jsonl：按 (navDate, code) 排序后整份落盘。

    早先这里是"先清空再逐行 append"，写一半崩溃会把不可重建的账本留成空/残缺文件。
    """
    _state.save_pred_log(entries)


def load_track():
    """读取 state/track.json（战绩核对记录），读坏时返回 []。"""
    return _state.load_track()


def save_track(t):
    """写 state/track.json（只保留最近 300 条）。"""
    _state.save_track(t)


# ---------------- 腾讯实时行情（A股/港股盘中） ----------------
def tencent_symbol(ifind_code):
    code, ex = ifind_code.split(".")
    if ex == "SH":
        return "sh" + code
    if ex == "SZ":
        return "sz" + code
    if ex == "HK":
        return "hk" + code.zfill(5)
    return None


# ---------------- 新浪纳指100期货（美股未开盘时的盘中代理） ----------------
def fetch_nq_futures():
    """纳指100期货最新价相对昨结的涨跌幅%，失败返回 None"""
    try:
        req = urllib.request.Request("https://hq.sinajs.cn/list=hf_NQ",
                                     headers={"User-Agent": "Mozilla/5.0",
                                              "Referer": "https://finance.sina.com.cn"})
        raw = urllib.request.urlopen(req, timeout=15).read().decode("gbk", "ignore")
        m = re.search(r'"([^"]+)"', raw)
        if not m:
            return None
        f = m.group(1).split(",")
        last, prev_settle = float(f[0]), float(f[7])
        if last > 0 and prev_settle > 0:
            return (last / prev_settle - 1) * 100
    except Exception as e:
        print(f"[live] 纳指期货拉取失败: {e}")
    return None


def fetch_live(ifind_codes):
    """返回 {ifind_code: 涨跌幅%}，失败/异常值跳过"""
    syms = {}
    for c in ifind_codes:
        s = tencent_symbol(c)
        if s:
            syms[s] = c
    out = {}
    if not syms:
        return out
    url = "https://qt.gtimg.cn/q=" + ",".join(syms.keys())
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0",
                                                   "Referer": "https://stockapp.finance.qq.com/"})
        raw = urllib.request.urlopen(req, timeout=15).read().decode("gbk", "ignore")
    except Exception as e:
        print(f"[live] 腾讯行情拉取失败: {e}")
        return out
    for m in re.finditer(r'v_(\w+)="([^"]*)"', raw):
        sym, body = m.group(1), m.group(2)
        f = body.split("~")
        if len(f) < 5 or sym not in syms:
            continue
        try:
            now_p, prev = float(f[3]), float(f[4])
            pct = (now_p / prev - 1) * 100
            if prev > 0 and abs(pct) < _LIVE_PCT_GUARD:
                out[syms[sym]] = round(pct, 2)
        except (ValueError, ZeroDivisionError):
            continue
    return out


_YF_LIVE_UA = {"User-Agent": "Mozilla/5.0"}


def _fetch_live_concurrent(tickers, fetch_one):
    """并发抓取每只 ticker 的实时行情 → {ticker: 涨跌幅%}（单只失败只丢它自己）。

    原来是「顺序抓 + 每只 sleep(0.3)」：N 只就是 N × (RTT + 300ms) 的纯等待。
    现在 8 路并发，RTT 互相重叠；在途请求数由 max_workers 封顶，请求速率与顺序版
    的 ~3.3 req/s（= 1/0.3）同量级，所以去掉那只固定 sleep，改成每个请求前的随机
    抖动（≤0.2s）把同一批请求的起始时刻错开。每只 ticker 的解析、`abs(pct) <
    _LIVE_PCT_GUARD` 护栏、失败日志与返回形状都保持不变。
    """
    out = {}
    tickers = list(tickers)
    if not tickers:
        return out

    def _guarded(t):
        time.sleep(random.uniform(0, 0.2))   # 抖动：错开同一批并发请求
        try:
            pct = fetch_one(t)
        except Exception as e:   # 兜底：单只崩掉只丢它自己，别拖垮整轮行情
            print(f"[live] {t} 行情抓取异常: {e}")
            pct = None
        return t, pct

    with ThreadPoolExecutor(max_workers=_LIVE_WORKERS) as ex:
        for t, pct in ex.map(_guarded, tickers):
            if pct is not None:
                out[t] = pct
    return out


def fetch_live_yf_asia(tickers):
    """日/韩等 Yahoo 日线：最新价（已收盘=今日收盘，盘中=最新价）相对昨日收盘的涨跌幅%"""
    def _one(t):
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?range=5d&interval=1d"
            req = urllib.request.Request(url, headers=_YF_LIVE_UA)
            raw = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore"))
            closes = [c for c in raw["chart"]["result"][0]["indicators"]["quote"][0]["close"] if c]
            if len(closes) >= 2:
                pct = (closes[-1] / closes[-2] - 1) * 100
                if abs(pct) < _LIVE_PCT_GUARD:
                    return round(pct, 2)
        except Exception as e:
            print(f"[live] Yahoo 日线 {t} 拉取失败: {e}")
        return None

    return _fetch_live_concurrent(tickers, _one)


def fetch_live_us_prepost(tickers):
    """美股盘后/盘前最新价 相对 最近常规时段收盘 的涨跌幅%（美股今晚未开时的增量变动，不按 0 计）"""
    def _one(t):
        try:
            url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{t}"
                   f"?range=1d&interval=5m&includePrePost=true")
            req = urllib.request.Request(url, headers=_YF_LIVE_UA)
            raw = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore"))
            r0 = raw["chart"]["result"][0]
            base = r0["meta"].get("regularMarketPrice")
            closes = [c for c in (r0["indicators"]["quote"][0].get("close") or []) if c]
            if base and closes:
                pct = (closes[-1] / base - 1) * 100
                if abs(pct) < _LIVE_PCT_GUARD:
                    return round(pct, 2)
        except Exception as e:
            print(f"[live] Yahoo 盘前盘后 {t} 拉取失败: {e}")
        return None

    return _fetch_live_concurrent(tickers, _one)


# ---------------- 基金截面（两种模式共用） ----------------
def run_fund(code):
    cfg = json.load(open(os.path.join(_state.fund_dir(code), "config.json"), encoding="utf-8"))
    return cfg, rbsa.run(cfg)


def fund_section(code, res, cfg):
    """看板 artifact 的单基金段（呈现用驼峰键，和 UiSnapshot 的蛇形键是两套）。

    `signalChips` 是**展示信号列表**（`{label, level}` 文案，只喂看板 HTML）——
    故意不叫 `signals`：本包里 `signals` 一律指 rbsa 裸信号字典
    （result.json / ui_snapshot.json 的 `UiSnapshotFund.signals`），两种形状不兼容，
    别再把它们塞进同一个键名。
    """
    sig = res["signals"]
    signalChips = [
        {"label": f"20日均线 {sig['ma20']:.2f}：" + ("站上" if sig["above_ma20"] else "下方"),
         "level": "ok" if sig["above_ma20"] else "warn"},
        {"label": f"前低 {sig['trough']:.4f}：" + ("跌破!" if sig["below_trough"] else "未破"),
         "level": "bad" if sig["below_trough"] else "ok"},
        {"label": f"距历史高点 {sig['dd_from_ath']}%", "level": "warn" if sig["dd_from_ath"] < -25 else "ok"},
    ]
    w = sorted(({"name": k, "pct": v} for k, v in res["weights"].items() if v >= 1),
               key=lambda x: -x["pct"])[:5]
    pred = res.get("pred")
    bt = res["backtest"]
    sec = {
        "code": code, "name": res["fund"]["name"],
        "officialNav": res["official"]["nav"], "officialDate": res["official"]["date"],
        "officialRet": res["official_er_check"]["official"],
        "predDate": pred["date"] if pred else None,
        "predRet": pred["ret"] if pred else None,
        "predNav": pred["nav"] if pred else None,
        "predLabel": res["status"]["label"],
        "predNote": res["status"]["note"],
        "band": f"80%误差带 {bt['p10']:+.1f}%~{bt['p90']:+.1f}% · MAE {bt['mae']:.2f}%",
        "r2": res["r2"], "mae": bt["mae"], "mae60": bt["mae60"],
        "weights": w, "signalChips": signalChips, "alert": None, "intraday": None, "error": None,
    }
    return sec


def log_predictions(entries, code, res, made_at):
    """把锁定版预测写入日志（只记全收盘锁定版，盘中版不计分）"""
    for s in res.get("steps") or []:
        if s.get("us_state") != "done":
            continue
        key = (code, s["date"], "locked")
        e = {"code": code, "navDate": s["date"], "mode": "locked",
             "predRet": s["ret"], "predNav": s["nav"], "madeAt": made_at,
             "factorRet": s.get("factor_ret"), "contrib": s.get("contrib")}
        entries[key] = e          # 同 key 保留最新一次预测
    return entries


# ---------------- 早 10:00：核对 + 修正 ----------------
def morning():
    now = pd.Timestamp.now("Asia/Shanghai")
    made_at = now.strftime("%Y-%m-%d %H:%M")
    entries, track = load_pred_log(), load_track()
    track_keys = {(t["code"], t["navDate"]) for t in track}
    corrections, fund_secs = [], []

    for code in _funds():
        try:
            cfg, res = run_fund(code)
        except Exception as e:
            fund_secs.append({"code": code, "name": code, "officialNav": 0, "officialDate": "",
                              "error": str(e)[:200], "weights": [], "signalChips": [],
                              "alert": "数据拉取失败", "intraday": None})
            continue
        sec = fund_section(code, res, cfg)
        off_date, off_ret = res["official"]["date"], res["official_er_check"]["official"]
        mae60 = res["backtest"]["mae60"]

        # 核对：官方已公布、且我们有该净值日的锁定预测、且尚未记分
        for (c, nav_date, mode), e in list(entries.items()):
            if c != code or mode != "locked" or nav_date > off_date or (c, nav_date) in track_keys:
                continue
            actual = None
            # 官方日收益：优先 equityReturn 核对值；逐日从净值复算
            nav_s, er_s = rbsa.fund_nav(code)
            d = pd.Timestamp(nav_date)
            if d in er_s.index:
                actual = float(er_s.loc[d])
            if actual is None:
                continue
            dev = round(actual - e["predRet"], 2)
            actual_nav = float(nav_s.loc[d]) if d in nav_s.index else None
            rec = {"checkDate": made_at[:10], "code": code, "navDate": nav_date,
                   "predRet": e["predRet"], "actualRet": actual, "dev": dev,
                   "predNav": e["predNav"], "actualNav": round(actual_nav, 4) if actual_nav else None,
                   "madeAt": e["madeAt"]}
            track.append(rec)
            track_keys.add((c, nav_date))
            if abs(dev) > dev_threshold(mae60):
                # 修正动作：诊断偏差来源 + 以近 60 日残差重新校准误差带
                top = sorted((e.get("contrib") or {}).items(), key=lambda x: x[1])[:3]
                note = (f"实际 {actual:+.2f}% vs 预测 {e['predRet']:+.2f}%，偏差 {dev:+.2f}pct 超阈值。"
                        f"模型已捕捉的主要拖累：{top}；剩余偏差为模型残差（真实持仓与代理篮子偏离），"
                        f"误差带已按近 60 日 MAE {mae60:.2f}% 重新校准。"
                        + ("连续大偏差，建议复核因子池是否跟丢真实持仓。" if dev * (track[-2]["dev"] if len(track) > 1 and track[-2]["code"] == code else 0) > 0 and abs(dev) > 2 else ""))
                corrections.append({"date": made_at[:10], "code": code, "navDate": nav_date,
                                    "dev": dev, "action": "残差诊断 + 误差带重校准", "note": note})
                sec["alert"] = f"{nav_date} 预测偏差 {dev:+.2f}pct（超阈值），已修正校准"
        # 记录新产生的锁定预测（供下次核对）
        entries = log_predictions(entries, code, res, made_at)
        fund_secs.append(sec)

    save_pred_log(entries)
    save_track(track)
    artifact = {
        "jobKind": "morning_check",
        "jobLabel": "早间核对",
        "updatedAt": made_at + " 北京时间",
        "summary": (f"已核对 {len(track)} 条历史预测；本次新增核对 "
                    f"{sum(1 for t in track if t['checkDate'] == made_at[:10])} 条，"
                    f"大偏差修正 {len(corrections)} 条。"),
        "funds": fund_secs,
        "track": track[-15:][::-1],
        "corrections": corrections[-10:][::-1],
    }
    return artifact


# ---------------- 午 14:00：锁定版 + 盘中参考 ----------------
def _collect_tickers(cfgs):
    """汇总各基金篮子的全部因子 ticker，按行情源分组。"""
    all_cn, all_yf_asia, all_yf_us = [], [], []
    for cfg in cfgs.values():
        for b in cfg["baskets"].values():
            for t in b["tickers"]:
                if t.startswith("IFIND:"):
                    all_cn.append(t[6:])
                elif t.startswith("YF:"):
                    (all_yf_us if b.get("market") == "US" else all_yf_asia).append(t[3:])
    return all_cn, all_yf_asia, all_yf_us


def _fetch_live_all(cfgs):
    """一次性拉齐全部因子实时行情：A/港走腾讯实时，日/韩走 Yahoo 日线最新价，美股走盘后/盘前最新价。"""
    all_cn, all_yf_asia, all_yf_us = _collect_tickers(cfgs)
    live = fetch_live(sorted(set(all_cn)))
    print(f"[live] A/港实时行情 {len(live)}/{len(set(all_cn))} 只")
    live_asia = fetch_live_yf_asia(sorted(set(all_yf_asia)))
    print(f"[live] 日/韩最新价 {len(live_asia)}/{len(set(all_yf_asia))} 只")
    live_us = fetch_live_us_prepost(sorted(set(all_yf_us)))
    print(f"[live] 美股盘后/盘前最新价 {len(live_us)}/{len(set(all_yf_us))} 只")
    nq_chg = fetch_nq_futures()
    print(f"[live] 纳指100期货 {nq_chg if nq_chg is not None else '拉取失败'}")
    return live, live_asia, live_us, nq_chg


def intraday_estimate(cfg, res, live, live_asia, live_us, nq_chg, date_str):
    """盘中参考：最新锁定链式净值 ×（1 + 各因子最新价收益 × 权重）。
    A/港=腾讯实时；日/韩=Yahoo 日线最新价（已收盘=今日收盘）；美股=盘后/盘前最新价，均不按 0 计。
    全美股因子池且无实时成分时退化为纳指100期货 × 美股敞口。无数据返回 None。"""
    pred = res.get("pred")
    official = res.get("official") or {}
    base_nav = (pred or {}).get("nav") or official.get("nav")
    if not base_nav:
        return None
    wmap = res.get("weights") or {}
    live_detail, est_ret, covered = [], 0.0, 0.0
    for bname, b in cfg["baskets"].items():
        mkt = b.get("market")
        rets = []
        for t in b["tickers"]:
            if t.startswith("IFIND:"):
                v = live.get(t[6:])
            elif t.startswith("YF:"):
                v = (live_us if mkt == "US" else live_asia).get(t[3:])
            else:
                v = None
            if v is not None:
                rets.append(v)
        if not rets:
            continue
        br = sum(rets) / len(rets)
        wb = wmap.get(bname, 0) / 100
        est_ret += wb * br / 100
        covered += wb
        live_detail.append({"name": bname, "live": round(br, 2), "w": round(wb * 100, 1)})
    if live_detail:
        return {
            "date": date_str,
            "estRet": round(est_ret * 100, 2),
            "estNav": round(base_nav * (1 + est_ret), 4),
            "detail": live_detail,
            "note": (f"最新价估算（覆盖权重 {covered * 100:.0f}%）：A/港=腾讯实时，"
                     f"日/韩=最新价（已收盘=今日收盘），美股=盘后/盘前最新价"),
        }
    if nq_chg is not None:
        # 因子池全为美股（A/港时段无实时成分）：以纳指100期货作为美股敞口的盘中代理
        us_w = sum(wmap.get(bn, 0) for bn, b in cfg["baskets"].items() if b.get("market") == "US")
        if us_w > 0:
            est_ret = us_w / 100 * nq_chg / 100
            return {
                "date": date_str,
                "estRet": round(est_ret * 100, 2),
                "estNav": round(base_nav * (1 + est_ret), 4),
                "detail": [{"name": "纳指期货(美股敞口代理)", "live": round(nq_chg, 2),
                            "w": round(us_w, 1)}],
                "note": f"因子池全为美股、今晚才开盘，以纳指100期货实时变动 × 美股敞口（{us_w:.0f}%）估算，仅供方向参考",
            }
    return None


def refresh_intraday():
    """用最新实时价重算 `artifact_latest.json` 里每只基金的盘中参考（不动锁定预测、
    不重跑 RBSA，秒级）。看板"刷新"时调用：美股盘前/盘中刷新即按当时美股价格估算。
    返回 {"status": "success", "updated": n} 或 {"status": "skip", "reason": ...}。"""
    artifact = _state.read_json(_state.state_path("artifact_latest.json"), None)
    if not artifact or not artifact.get("funds"):
        return {"status": "skip", "reason": "no artifact"}
    cfgs, results = {}, {}
    for f in artifact["funds"]:
        code = f.get("code")
        cfg_path = os.path.join(_state.fund_dir(code), "config.json")
        if not code or not os.path.exists(cfg_path):
            continue
        cfgs[code] = json.load(open(cfg_path, encoding="utf-8"))
        results[code] = _state.read_json(os.path.join(_state.fund_dir(code), "result.json"), {})
    if not cfgs:
        return {"status": "skip", "reason": "no fund configs"}
    live, live_asia, live_us, nq_chg = _fetch_live_all(cfgs)
    now = pd.Timestamp.now("Asia/Shanghai")
    date_str = now.strftime("%Y-%m-%d")
    updated = 0
    for f in artifact["funds"]:
        code = f.get("code")
        if code not in cfgs or f.get("error"):
            continue
        est = intraday_estimate(cfgs[code], results[code], live, live_asia, live_us, nq_chg, date_str)
        if est:
            f["intraday"] = est
            updated += 1
    artifact["intradayAt"] = now.strftime("%Y-%m-%d %H:%M") + " 北京时间"
    _state.write_json(_state.state_path("artifact_latest.json"), artifact)
    return {"status": "success", "updated": updated}


def afternoon():
    now = pd.Timestamp.now("Asia/Shanghai")
    made_at = now.strftime("%Y-%m-%d %H:%M")
    entries = load_pred_log()
    track = load_track()

    # 收集全部因子 ticker：A/港走腾讯实时，日/韩走 Yahoo 日线最新价，美股走盘后/盘前最新价
    cfgs = {}
    for code in _funds():
        cfgs[code] = json.load(open(os.path.join(_state.fund_dir(code), "config.json"), encoding="utf-8"))
    live, live_asia, live_us, nq_chg = _fetch_live_all(cfgs)

    fund_secs = []
    for code in _funds():
        cfg = cfgs[code]
        try:
            res = rbsa.run(cfg)
        except Exception as e:
            fund_secs.append({"code": code, "name": code, "officialNav": 0, "officialDate": "",
                              "error": str(e)[:200], "weights": [], "signalChips": [],
                              "alert": "数据拉取失败", "intraday": None})
            continue
        sec = fund_section(code, res, cfg)
        entries = log_predictions(entries, code, res, made_at)

        est = intraday_estimate(cfg, res, live, live_asia, live_us, nq_chg,
                                now.strftime("%Y-%m-%d"))
        if est:
            sec["intraday"] = est
        fund_secs.append(sec)

    save_pred_log(entries)
    artifact = {
        "jobKind": "afternoon_forecast",
        "jobLabel": "午后预测",
        "updatedAt": made_at + " 北京时间",
        "summary": "已生成最新锁定版预测（全市场真实收盘）与当日盘中参考（A/港实时）。",
        "funds": fund_secs,
        "track": track[-15:][::-1],
        "corrections": [],
    }
    return artifact


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "auto"
    if mode == "auto":
        mode = "morning" if pd.Timestamp.now("Asia/Shanghai").hour < 12 else "afternoon"
    print(f"[daily_job] mode={mode}")
    artifact = morning() if mode == "morning" else afternoon()
    p1 = _state.state_path(f"artifact_{mode}.json")
    p2 = _state.state_path("artifact_latest.json")
    for p in (p1, p2):
        _state.write_json(p, artifact)
    print(f"[daily_job] artifact written: {p1}")
    # 顺手刷新市场热点雷达（供 /api/hotspots 与前端"市场"页），失败不阻塞主任务
    try:
        from . import hotspot
        hotspot.build(verbose=False)
        print("[daily_job] hotspot refreshed: state/hotspot.json")
    except Exception as e:
        print(f"[daily_job] hotspot refresh skipped: {e}")
    print(json.dumps({k: artifact[k] for k in ("jobKind", "updatedAt", "summary")}, ensure_ascii=False))
    for f in artifact["funds"]:
        if f.get("error"):
            print(f"  {f['code']}: ERROR {f['error'][:80]}")
        else:
            print(f"  {f['code']}: 官方 {f['officialNav']}({f['officialDate']}) "
                  f"预测 {f.get('predDate')} {f.get('predRet')}% → {f.get('predNav')} [{f.get('predLabel')}]"
                  + (f" 盘中 {f['intraday']['estRet']}% → {f['intraday']['estNav']}" if f.get("intraday") else ""))
