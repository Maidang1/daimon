#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
基金行业信息提取与持仓穿透分析模块 (Fund Industry & Look-Through Analyzer)
========================================================================
功能：
  1. 自动提取基金官方定期披露前十大重仓股（天天基金/东方财富开放接口）
  2. 股票标的与行业分类图谱（申万/GICS/产业链映射：存储、AI芯片、设备、代工、光通信、硬件PCB等）
  3. 结合 RBSA 风格回归因子篮子与持仓披露，输出单基金行业暴露
  4. 结合个人真实持仓，计算全组合穿透行业敞口 (Portfolio Look-Through)
  5. 跨基金标的重叠度与集中度风险识别（如美光、闪迪、台积电在多只基金重叠持有）

本模块 fork 自 touzi/industry_extractor.py；重仓股缓存归 FINANCE_HOME/industry_cache
（调用时经 _state 解析，测试可在 import 后改 FINANCE_HOME）。
"""

import os
import json
import re
import urllib.request
from typing import Dict, List, Any, Optional

from . import _state

# ----------------- 标的行业与概念标签知识图谱 -----------------
# 格式：ticker/code -> {name, sector, sub_industry, market, tags}
STOCK_DATABASE: Dict[str, Dict[str, Any]] = {
    # 美股核心标的
    "NVDA": {"name": "英伟达", "sector": "半导体与芯片", "sub_industry": "AI算力芯片", "market": "US", "tags": ["GPU", "AI算力", "数据中心"]},
    "AMD": {"name": "超威半导体", "sector": "半导体与芯片", "sub_industry": "AI算力芯片", "market": "US", "tags": ["CPU/GPU", "AI芯片", "数据中心"]},
    "AVGO": {"name": "博通", "sector": "半导体与芯片", "sub_industry": "通信与定制芯片", "market": "US", "tags": ["ASIC", "网络交换芯片", "AI互联"]},
    "MRVL": {"name": "迈威尔科技", "sector": "半导体与芯片", "sub_industry": "定制算力与互联", "market": "US", "tags": ["定制ASIC", "光互联DSP"]},
    "TSM": {"name": "台积电", "sector": "半导体与芯片", "sub_industry": "晶圆代工与封测", "market": "US", "tags": ["先进制程", "CoWoS先进封装", "晶圆代工霸主"]},
    "UMC": {"name": "联华电子", "sector": "半导体与芯片", "sub_industry": "晶圆代工与封测", "market": "US", "tags": ["成熟制程", "晶圆代工"]},
    "ASML": {"name": "阿斯麦", "sector": "半导体与芯片", "sub_industry": "半导体设备", "market": "US", "tags": ["光刻机垄断", "EUV", "核心设备"]},
    "LRCX": {"name": "拉姆研究", "sector": "半导体与芯片", "sub_industry": "半导体设备", "market": "US", "tags": ["刻蚀设备", "薄膜沉积", "存储产线核心"]},
    "KLAC": {"name": "科磊", "sector": "半导体与芯片", "sub_industry": "半导体设备", "market": "US", "tags": ["量测检测设备", "良率控制", "设备龙头"]},
    "AMAT": {"name": "应用材料", "sector": "半导体与芯片", "sub_industry": "半导体设备", "market": "US", "tags": ["半导体综合设备", "材料工程"]},
    "MU": {"name": "美光科技", "sector": "半导体与芯片", "sub_industry": "存储芯片", "market": "US", "tags": ["DRAM", "NAND", "HBM3E", "存储周期龙头"]},
    "SNDK": {"name": "闪迪", "sector": "半导体与芯片", "sub_industry": "存储芯片", "market": "US", "tags": ["NAND Flash", "固态存储"]},
    "STX": {"name": "希捷科技", "sector": "硬件设备与电子", "sub_industry": "数据存储硬件", "market": "US", "tags": ["HDD大容量机械硬盘", "企业级云存储"]},
    "WDC": {"name": "西部数据", "sector": "半导体与芯片", "sub_industry": "存储芯片与硬件", "market": "US", "tags": ["NAND闪存", "企业级HDD"]},
    "GLW": {"name": "康宁", "sector": "通信与光网络", "sub_industry": "光通信与特种材料", "market": "US", "tags": ["光纤光缆", "AI数据中心布线", "特种玻璃"]},
    "LITE": {"name": "Lumentum", "sector": "通信与光网络", "sub_industry": "光通信与光芯片", "market": "US", "tags": ["光芯片", "EML/VCSEL", "光模块上游"]},
    "COHR": {"name": "Coherent高意", "sector": "通信与光网络", "sub_industry": "光通信与器件", "market": "US", "tags": ["光模块", "碳化硅", "光纤激光"]},
    "GOOGL": {"name": "谷歌-A", "sector": "软件与互联网", "sub_industry": "云计算与平台", "market": "US", "tags": ["谷歌云", "大模型Gemini", "搜索生态"]},
    "GOOG": {"name": "谷歌-C", "sector": "软件与互联网", "sub_industry": "云计算与平台", "market": "US", "tags": ["谷歌云", "大模型Gemini", "搜索生态"]},
    "AMZN": {"name": "亚马逊", "sector": "软件与互联网", "sub_industry": "云计算与电商", "market": "US", "tags": ["AWS云", "AI云基础设施", "电商巨头"]},
    "QQQ": {"name": "纳斯达克100ETF", "sector": "基准与综合科技", "sub_industry": "科技宽基基准", "market": "US", "tags": ["纳指100", "科技贝塔"]},

    # 日韩核心标的
    "285A": {"name": "铠侠(KIOXIA)", "sector": "半导体与芯片", "sub_industry": "存储芯片", "market": "JP", "tags": ["NAND闪存全球第二", "存储周期", "日股核心科技"]},
    "285A.T": {"name": "铠侠(KIOXIA)", "sector": "半导体与芯片", "sub_industry": "存储芯片", "market": "JP", "tags": ["NAND闪存全球第二", "存储周期", "日股核心科技"]},
    "JP3236330001": {"name": "铠侠控股", "sector": "半导体与芯片", "sub_industry": "存储芯片", "market": "JP", "tags": ["NAND闪存全球第二", "存储周期"]},
    "3110.T": {"name": "日东纺织", "sector": "先进制造与材料", "sub_industry": "电子材料与玻璃布", "market": "JP", "tags": ["低介电特种玻纤布", "高频高速PCB材料", "AI服务器底座"]},
    "JP3684400009": {"name": "日东纺织", "sector": "先进制造与材料", "sub_industry": "电子材料与玻璃布", "market": "JP", "tags": ["低介电特种玻纤布", "高频高速PCB材料"]},
    "000660.KS": {"name": "SK海力士", "sector": "半导体与芯片", "sub_industry": "存储芯片", "market": "KR", "tags": ["HBM龙头", "DRAM霸主", "英伟达核心供应商"]},
    "000660": {"name": "SK海力士", "sector": "半导体与芯片", "sub_industry": "存储芯片", "market": "KR", "tags": ["HBM龙头", "DRAM霸主"]},
    "005930.KS": {"name": "三星电子", "sector": "半导体与芯片", "sub_industry": "综合半导体与存储", "market": "KR", "tags": ["DRAM/NAND全球第一", "晶圆代工", "消费电子"]},
    "005930": {"name": "三星电子", "sector": "半导体与芯片", "sub_industry": "综合半导体与存储", "market": "KR", "tags": ["DRAM/NAND全球第一", "晶圆代工"]},

    # 港股核心标的
    "01347": {"name": "华虹半导体", "sector": "半导体与芯片", "sub_industry": "晶圆代工与封测", "market": "HK", "tags": ["特色工艺晶圆代工", "功率半导体", "港股半导体龙头"]},
    "00522": {"name": "ASMPT", "sector": "半导体与芯片", "sub_industry": "半导体封测设备", "market": "HK", "tags": ["先进封装设备", "TCB热压键合", "晶圆贴片机"]},
    "02513": {"name": "智谱(智谱AI/港股)", "sector": "软件与互联网", "sub_industry": "大模型与人工智能", "market": "HK", "tags": ["基座大模型", "生成式AI", "港股AI生态"]},
    "00700": {"name": "腾讯控股", "sector": "软件与互联网", "sub_industry": "云计算与平台", "market": "HK", "tags": ["腾讯云", "微信生态", "混元大模型"]},
    "09988": {"name": "阿里巴巴", "sector": "软件与互联网", "sub_industry": "云计算与电商", "market": "HK", "tags": ["阿里云", "通义千问", "AI算力租赁"]},
    "01810": {"name": "小米集团", "sector": "硬件设备与电子", "sub_industry": "消费电子与智能车", "market": "HK", "tags": ["智能手机", "智能电动汽车", "人车家全生态"]},
    "01888": {"name": "建滔积层板", "sector": "先进制造与材料", "sub_industry": "覆铜板与电子材料", "market": "HK", "tags": ["CCL覆铜板龙头", "PCB原材料"]},

    # A股核心标的
    "300308": {"name": "中际旭创", "sector": "通信与光网络", "sub_industry": "光通信与光模块", "market": "CN", "tags": ["800G/1.6T光模块", "北美算力核心供应商", "光模块全球第一"]},
    "300502": {"name": "新易盛", "sector": "通信与光网络", "sub_industry": "光通信与光模块", "market": "CN", "tags": ["800G/1.6T光模块", "硅光技术", "AI算力光模块龙头"]},
    "300476": {"name": "胜宏科技", "sector": "硬件设备与电子", "sub_industry": "AI服务器PCB硬件", "market": "CN", "tags": ["AI服务器高阶PCB", "HDI算力板", "英伟达算力主板"]},
    "02476": {"name": "胜宏科技", "sector": "硬件设备与电子", "sub_industry": "AI服务器PCB硬件", "market": "CN", "tags": ["AI服务器高阶PCB", "HDI算力板"]},
    "002463": {"name": "沪电股份", "sector": "硬件设备与电子", "sub_industry": "AI服务器PCB硬件", "market": "CN", "tags": ["企业级通信PCB", "AI加速卡板", "交换机板"]},
    "002384": {"name": "东山精密", "sector": "硬件设备与电子", "sub_industry": "消费电子与FPC", "market": "CN", "tags": ["FPC柔性电路板", "车载电子", "精密制造"]},
    "600183": {"name": "生益科技", "sector": "先进制造与材料", "sub_industry": "覆铜板与电子材料", "market": "CN", "tags": ["特种高频覆铜板", "PCB基材龙头"]},
    "603986": {"name": "兆易创新", "sector": "半导体与芯片", "sub_industry": "存储芯片与MCU", "market": "CN", "tags": ["NOR Flash龙头", "利基型DRAM", "MCU微控制器"]},
    "688498": {"name": "源杰科技", "sector": "通信与光网络", "sub_industry": "光通信与光芯片", "market": "CN", "tags": ["高速光芯片", "CW激光光源", "硅光上游"]},
    "300408": {"name": "三环集团", "sector": "硬件设备与电子", "sub_industry": "电子元器件与陶瓷", "market": "CN", "tags": ["高容MLCC", "陶瓷插芯", "电子元件龙头"]},
}

# 因子篮子与行业映射
BASKET_SECTOR_MAP = {
    "存储": ("半导体与芯片", "存储芯片"),
    "美存储": ("半导体与芯片", "存储芯片"),
    "韩存储": ("半导体与芯片", "存储芯片"),
    "日存储": ("半导体与芯片", "存储芯片"),
    "AI芯片": ("半导体与芯片", "AI算力芯片"),
    "晶圆代工": ("半导体与芯片", "晶圆代工与封测"),
    "半导体设备": ("半导体与芯片", "半导体设备"),
    "港股半导体": ("半导体与芯片", "半导体制造与封测"),
    "光通信": ("通信与光网络", "光通信与光模块"),
    "A股AI硬件": ("硬件设备与电子", "AI服务器与PCB硬件"),
    "A股AI硬件A": ("硬件设备与电子", "AI服务器与PCB硬件"),
    "A股AI硬件B": ("硬件设备与电子", "AI服务器与PCB硬件"),
    "A股硬件": ("硬件设备与电子", "AI服务器与PCB硬件"),
    "A股电子": ("硬件设备与电子", "电子元器件与制造"),
    "日股制造": ("先进制造与材料", "存储与先进材料"),
    "港股AI": ("软件与互联网", "大模型与人工智能"),
    "港股科技": ("软件与互联网", "平台互联网与消费电子"),
    "云巨头": ("软件与互联网", "云计算与AI基础设施"),
    "泛科技": ("基准与综合科技", "科技宽基基准"),
}


def normalize_code(raw_code: str) -> str:
    """去除交易所前缀/后缀以匹配知识库"""
    code = raw_code.strip().upper()
    for prefix in ["IFIND:", "YF:", "HK", "SH", "SZ"]:
        if code.startswith(prefix):
            code = code[len(prefix):]
    if "." in code:
        code = code.split(".")[0]
    return code


def lookup_stock(ticker: str) -> Dict[str, Any]:
    """根据股票代码查询行业信息，若不在库中则返回推导信息"""
    clean_code = normalize_code(ticker)
    if ticker in STOCK_DATABASE:
        return STOCK_DATABASE[ticker]
    if clean_code in STOCK_DATABASE:
        return STOCK_DATABASE[clean_code]

    # 根据代码规则智能推导
    market = "US"
    if re.match(r"^(60\d|68\d|00\d|30\d)", clean_code):
        market = "CN"
    elif re.match(r"^0\d{4}$", clean_code):
        market = "HK"
    elif re.match(r"^\d{4}\.T$", ticker) or clean_code.startswith("JP"):
        market = "JP"
    elif clean_code.startswith("000") or clean_code.startswith("005"):
        market = "KR"

    return {
        "name": clean_code,
        "sector": "综合科技",
        "sub_industry": "科技软硬件",
        "market": market,
        "tags": ["科技创新标的"]
    }


def fetch_fund_top_holdings(fund_code: str, force_refresh: bool = False) -> List[Dict[str, Any]]:
    """
    拉取天天基金最新官方定期披露的前十大重仓股
    """
    cache_file = os.path.join(_state.home(), "industry_cache", f"holdings_{fund_code}.json")
    if not force_refresh:
        try:
            cached = _state.read_json(cache_file, None)
        except Exception:
            cached = None
        if cached is not None:
            return cached

    url = f"https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE={fund_code}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)"})
        raw = urllib.request.urlopen(req, timeout=12).read().decode("utf-8")
        data = json.loads(raw)
        raw_stocks = data.get("Datas", {}).get("fundStocks", [])

        parsed_stocks = []
        for s in raw_stocks:
            gpdm = s.get("GPDM", "").strip()
            gpjc = s.get("GPJC", "").strip()
            try:
                jzbl = float(s.get("JZBL", 0.0))
            except (ValueError, TypeError):
                jzbl = 0.0

            info = lookup_stock(gpdm)
            parsed_stocks.append({
                "code": gpdm,
                "name": gpjc or info.get("name", gpdm),
                "weight": round(jzbl, 2),
                "sector": info.get("sector", "综合科技"),
                "sub_industry": info.get("sub_industry", "科技"),
                "market": info.get("market", "US"),
                "tags": info.get("tags", []),
                "pct_change_type": s.get("PCTNVCHGTYPE", "")
            })

        if parsed_stocks:
            _state.write_json(cache_file, parsed_stocks)

        return parsed_stocks
    except Exception as e:
        print(f"[industry] 拉取基金 {fund_code} 持仓失败: {e}")
        return []


def analyze_fund_sectors(fund_code: str) -> Dict[str, Any]:
    """
    分析单只基金的行业结构：
    结合 RBSA 风格回归因子权重（高频动态暴露）与 季度官方重仓股（精细穿透）
    """
    fund_name = fund_code
    cfg_path = os.path.join(_state.fund_dir(fund_code), "config.json")
    cfg = _state.read_json(cfg_path, {})
    fund_name = cfg.get("name", fund_code)

    # 1. 读取 RBSA 最新风格回归权重
    rbsa_weights = {}
    res_path = os.path.join(_state.fund_dir(fund_code), "result.json")
    res = _state.read_json(res_path, {})
    rbsa_weights = res.get("weights", {})

    # 2. 拉取官方前十大重仓
    top_stocks = fetch_fund_top_holdings(fund_code)

    # 3. 统计细分行业与一级赛道
    sector_exposure: Dict[str, float] = {}
    sub_industry_exposure: Dict[str, float] = {}
    market_exposure: Dict[str, float] = {}

    if rbsa_weights:
        # 基于 RBSA 因子篮子计算动态暴露
        tot_w = sum(rbsa_weights.values()) or 1.0
        for basket, w in rbsa_weights.items():
            if w <= 0:
                continue
            sec, sub = BASKET_SECTOR_MAP.get(basket, ("其他板块", basket))
            sector_exposure[sec] = round(sector_exposure.get(sec, 0.0) + w, 2)
            sub_industry_exposure[sub] = round(sub_industry_exposure.get(sub, 0.0) + w, 2)

            # 推断市场
            b_info = cfg.get("baskets", {}).get(basket, {})
            mkt = b_info.get("market", "GLOBAL")
            market_exposure[mkt] = round(market_exposure.get(mkt, 0.0) + w, 2)
    elif top_stocks:
        # 无 RBSA 时回退到重仓股
        for s in top_stocks:
            sec = s["sector"]
            sub = s["sub_industry"]
            mkt = s["market"]
            w = s["weight"]
            sector_exposure[sec] = round(sector_exposure.get(sec, 0.0) + w, 2)
            sub_industry_exposure[sub] = round(sub_industry_exposure.get(sub, 0.0) + w, 2)
            market_exposure[mkt] = round(market_exposure.get(mkt, 0.0) + w, 2)

    # 排序
    sorted_sectors = [{"name": k, "pct": v} for k, v in sorted(sector_exposure.items(), key=lambda x: x[1], reverse=True)]
    sorted_sub_industries = [{"name": k, "pct": v} for k, v in sorted(sub_industry_exposure.items(), key=lambda x: x[1], reverse=True)]
    sorted_markets = [{"name": k, "pct": v} for k, v in sorted(market_exposure.items(), key=lambda x: x[1], reverse=True)]

    return {
        "code": fund_code,
        "name": fund_name,
        "top_stocks": top_stocks,
        "top10_total_weight": round(sum(s["weight"] for s in top_stocks), 2),
        "rbsa_weights": [{"name": k, "pct": v} for k, v in sorted(rbsa_weights.items(), key=lambda x: x[1], reverse=True)],
        "sectors": sorted_sectors,
        "sub_industries": sorted_sub_industries,
        "markets": sorted_markets
    }


def analyze_portfolio_lookthrough(portfolio_positions: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """
    全投资组合穿透深度分析 (Portfolio Look-Through Analyzer):
    根据用户各基金持仓金额，加权聚合整个组合的穿透行业暴露、跨基金重仓股重叠透视、集中度风险
    """
    if portfolio_positions is None:
        from . import portfolio
        p_data = portfolio.calculate_portfolio()
        portfolio_positions = p_data.get("positions", [])

    # 过滤出有实际持仓的基金
    active_funds = [p for p in portfolio_positions if p.get("market_value", 0) > 0 and p.get("shares", 0) > 0]
    total_val = sum(p["market_value"] for p in active_funds)

    if not active_funds or total_val <= 0:
        return {
            "has_holdings": False,
            "message": "暂无持仓或持仓市值为0，请先录入投资记录",
            "sectors": [],
            "sub_industries": [],
            "markets": [],
            "overlapping_stocks": [],
            "top_stocks_lookthrough": [],
            "risk_metrics": {}
        }

    # 各基金的行业与重仓股结构
    fund_analyses = {p["code"]: analyze_fund_sectors(p["code"]) for p in active_funds}

    # 1. 穿透行业敞口 (Aggregated Sectors & Sub-industries)
    port_sector_map: Dict[str, float] = {}
    port_sub_industry_map: Dict[str, float] = {}
    port_market_map: Dict[str, float] = {}

    for p in active_funds:
        code = p["code"]
        fund_w = p["market_value"] / total_val  # 该基金在组合中的权重
        fa = fund_analyses.get(code, {})

        # 一级行业
        for s in fa.get("sectors", []):
            port_sector_map[s["name"]] = port_sector_map.get(s["name"], 0.0) + s["pct"] * fund_w
        # 细分产业链
        for sub in fa.get("sub_industries", []):
            port_sub_industry_map[sub["name"]] = port_sub_industry_map.get(sub["name"], 0.0) + sub["pct"] * fund_w
        # 市场分布
        for m in fa.get("markets", []):
            port_market_map[m["name"]] = port_market_map.get(m["name"], 0.0) + m["pct"] * fund_w

    # 2. 跨基金重仓股穿透与重叠透视 (Cross-Fund Stock Overlap)
    stock_overlap_map: Dict[str, Dict[str, Any]] = {}
    for p in active_funds:
        code = p["code"]
        f_name = p.get("name", code)
        fund_w = p["market_value"] / total_val
        fa = fund_analyses.get(code, {})
        for s in fa.get("top_stocks", []):
            stock_code = s["code"]
            clean_code = normalize_code(stock_code)
            key = clean_code or stock_code
            if key not in stock_overlap_map:
                stock_overlap_map[key] = {
                    "code": key,
                    "name": s["name"],
                    "sector": s["sector"],
                    "sub_industry": s["sub_industry"],
                    "market": s["market"],
                    "tags": s["tags"],
                    "effective_weight": 0.0,
                    "held_in_funds": []
                }
            eff_w = s["weight"] * fund_w
            stock_overlap_map[key]["effective_weight"] += eff_w
            stock_overlap_map[key]["held_in_funds"].append({
                "fund_code": code,
                "fund_name": f_name,
                "fund_weight_in_portfolio": round(fund_w * 100, 1),
                "stock_weight_in_fund": s["weight"],
                "stock_contrib_to_portfolio": round(eff_w, 2)
            })

    # 筛选出被 2 只及以上基金重叠持有的个股
    overlapping_stocks = [
        item for item in stock_overlap_map.values()
        if len(item["held_in_funds"]) >= 2
    ]
    overlapping_stocks.sort(key=lambda x: x["effective_weight"], reverse=True)

    # 组合穿透前十大个股
    top_stocks_lookthrough = sorted(stock_overlap_map.values(), key=lambda x: x["effective_weight"], reverse=True)[:12]
    for s in top_stocks_lookthrough:
        s["effective_weight"] = round(s["effective_weight"], 2)

    # 3. 组合风险度与集中度评估
    sorted_sectors = [{"name": k, "pct": round(v, 2)} for k, v in sorted(port_sector_map.items(), key=lambda x: x[1], reverse=True)]
    sorted_sub_industries = [{"name": k, "pct": round(v, 2)} for k, v in sorted(port_sub_industry_map.items(), key=lambda x: x[1], reverse=True)]
    sorted_markets = [{"name": k, "pct": round(v, 2)} for k, v in sorted(port_market_map.items(), key=lambda x: x[1], reverse=True)]

    top1_sec = sorted_sectors[0]["pct"] if sorted_sectors else 0.0
    top3_sec = sum(s["pct"] for s in sorted_sectors[:3]) if sorted_sectors else 0.0
    top1_sub = sorted_sub_industries[0]["pct"] if sorted_sub_industries else 0.0
    top3_sub = sum(s["pct"] for s in sorted_sub_industries[:3]) if sorted_sub_industries else 0.0

    # 集中度风险分级
    risk_level = "适中"
    risk_color = "warn"
    risk_reasons = []

    if top1_sub >= 35.0:
        risk_level = "极高"
        risk_color = "bad"
        risk_reasons.append(f"单一细分板块【{sorted_sub_industries[0]['name']}】穿透敞口高达 {top1_sub}%，抗周期能力弱")
    elif top1_sub >= 25.0:
        risk_level = "偏高"
        risk_color = "warn"
        risk_reasons.append(f"核心赛道【{sorted_sub_industries[0]['name']}】穿透敞口达 {top1_sub}%，需防范行业波动")

    if len(overlapping_stocks) >= 3:
        risk_reasons.append(f"发现 {len(overlapping_stocks)} 只个股跨基金重叠持有（如 {', '.join([s['name'] for s in overlapping_stocks[:3]])}），存在伪分散风险")

    if not risk_reasons:
        risk_level = "健康"
        risk_color = "ok"
        risk_reasons.append("行业配置相对均衡，未发现显著过度集中")

    risk_metrics = {
        "level": risk_level,
        "color": risk_color,
        "top1_sector_pct": round(top1_sec, 2),
        "top3_sector_pct": round(top3_sec, 2),
        "top1_sub_industry_pct": round(top1_sub, 2),
        "top3_sub_industry_pct": round(top3_sub, 2),
        "overlap_stocks_count": len(overlapping_stocks),
        "reasons": risk_reasons
    }

    return {
        "has_holdings": True,
        "total_portfolio_value": round(total_val, 2),
        "funds_count": len(active_funds),
        "sectors": sorted_sectors,
        "sub_industries": sorted_sub_industries,
        "markets": sorted_markets,
        "overlapping_stocks": overlapping_stocks,
        "top_stocks_lookthrough": top_stocks_lookthrough,
        "risk_metrics": risk_metrics,
        "fund_details": fund_analyses
    }


def print_lookthrough_report() -> None:
    """CLI 打印穿透行业与重叠度报告"""
    lt = analyze_portfolio_lookthrough()
    if not lt.get("has_holdings"):
        print(f"[提示] {lt.get('message')}")
        return

    print("=" * 68)
    print("        投资组合穿透深度分析报告 (Look-Through Portfolio Audit)        ")
    print("=" * 68)
    print(f"组合总市值: ¥{lt['total_portfolio_value']:,.2f}  |  有效持仓基金: {lt['funds_count']} 只")
    rm = lt["risk_metrics"]
    print(f"集中度风险评级: 【{rm['level']}】")
    for r in rm["reasons"]:
        print(f"  • {r}")
    print("-" * 68)

    print("【全组合穿透细分产业链敞口 (Top Sub-Industries)】:")
    for s in lt["sub_industries"][:6]:
        bar = "█" * int(s["pct"] // 2)
        print(f"  {s['name']:<18} {s['pct']:>5.1f}%  {bar}")

    print("-" * 68)
    print("【跨基金重叠持仓个股 (Cross-Fund Overlap)】:")
    if lt["overlapping_stocks"]:
        for s in lt["overlapping_stocks"]:
            funds_str = ", ".join([f"{f['fund_name'][:8]}({f['stock_weight_in_fund']}%)" for f in s["held_in_funds"]])
            print(f"  ★ {s['name']} ({s['market']}) | 穿透有效仓位: {s['effective_weight']:.2f}% | 涉及基金: {funds_str}")
    else:
        print("  未发现跨基金高重叠个股")

    print("-" * 68)
    print("【穿透前十大底层标的 (Top Underlying Assets)】:")
    for s in lt["top_stocks_lookthrough"][:8]:
        tags = " / ".join(s["tags"][:2])
        print(f"  • {s['name']:<10} ({s['sector']} - {s['sub_industry']}) 穿透占比: {s['effective_weight']:>4.2f}% | {tags}")
    print("=" * 68)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="基金行业信息提取与持仓穿透工具")
    parser.add_argument("--fund", help="查看指定基金行业与重仓股")
    parser.add_argument("--portfolio", action="store_true", help="查看全组合穿透分析报告")
    parser.add_argument("--refresh", action="store_true", help="强制从网络刷新官方重仓股数据")

    args = parser.parse_args()
    if args.fund:
        info = analyze_fund_sectors(args.fund)
        print(json.dumps(info, ensure_ascii=False, indent=2))
    else:
        print_lookthrough_report()
