# -*- coding: utf-8 -*-
"""本包与 TypeScript 终端共享的 JSON 形状契约 —— 单一事实来源（single source of truth）。

这里用 `TypedDict` 声明本包**写出**、`packages/finance-board/src/client/api.ts`
**读取**的文档形状：

- `UiSnapshot`           → ``state/ui_snapshot.json``  （Finance 终端 /finance/api/snapshot）
- `Briefing`             → ``state/briefing.json``    （AI 首页 /finance/api/briefing）
- `ArtifactFundSection`  → ``state/artifact_*.json`` 的 ``funds[]`` 段（自包含看板 dashboard.html）

``api.ts`` 里的同名 interface 就是这里的镜像：改任何字段名/类型都要两边同步，
出现分歧时以本模块为准（TS 侧的类型注释里也写明了这一点）。

⚠ 历史陷阱，命名时请守住这条边界：
- `UiSnapshotFund.signals` 是 **rbsa 裸信号字典**（`{ma20, above_ma20, ...}`），
  给 React 终端的行情芯片直接用；
- `ArtifactFundSection.signalChips` 是 **展示用字符串列表**（`{label, level}`），
  只喂给看板 HTML 的渲染模板。
两者形状不兼容，务必保持两个不同的键名。

这是纯类型契约，**不做运行时校验**——不引入 pydantic / attrs 等第三方依赖，也不在
写入路径上加校验开销；与 TS 侧只做 interface 声明的做法一致，宽松解析由各自的
消费方（看板模板 / React 终端）自己兜底。
"""

from __future__ import annotations

from typing import Any, NotRequired, TypedDict


# ---------- 通用片段 ----------


class WeightRow(TypedDict):
    """因子篮子权重行 `{"name": 篮子名, "pct": 权重百分比}`（只收 pct >= 1 的）。"""

    name: str
    pct: float


class SignalChip(TypedDict):
    """看板用的展示信号 `{"label": 文案, "level": ok|warn|bad}`。"""

    label: str
    level: str


class TrackRec(TypedDict):
    """一条战绩核对记录（pred_log 的锁定预测 vs 官方实际收益）。"""

    code: str
    navDate: str
    predRet: float | None
    actualRet: float | None
    dev: float | None


class FundSignal(TypedDict):
    """rbsa.run() 的裸技术信号（api.ts `FundSignal`，snapshot 原样透传）。"""

    ma20: float
    above_ma20: bool
    trough: float
    below_trough: bool
    ath: float
    dd_from_ath: float


class IntradayDetail(TypedDict):
    """盘中估算的单个篮子明细。"""

    name: str
    live: float
    w: float


class Intraday(TypedDict):
    """盘中参考估算：最新锁定链式净值 ×（1 + 各因子最新价收益 × 权重）。"""

    date: str
    estRet: float
    estNav: float
    detail: list[IntradayDetail]
    note: str


# ---------- state/ui_snapshot.json（Finance 终端） ----------


class SnapshotMeta(TypedDict):
    """快照的来源信息：FINANCE_HOME、artifact 是否缺失、artifact 的更新时间/类型/摘要。"""

    finance_home: str
    pending_artifact: bool
    artifact_updated_at: str | None
    artifact_job_kind: str | None
    artifact_summary: str | None


class SnapshotSummary(TypedDict):
    """组合级汇总（board ops 数 / 基金数由 snapshot.build() 追加写入）。"""

    total_cost: float
    total_value: float | None
    total_pnl: float | None
    total_pnl_pct: float | None
    nav_asof: str
    positions_count: int
    valued_count: int
    ops_count: int
    funds_count: int


class Holding(TypedDict):
    """看板口径的单只基金持仓（baseline + ops 演变后的份额/成本/盈亏）。"""

    code: str
    name: str
    shares: float
    cost: float
    avg: float | None
    nav: float | None
    navDate: str
    value: float | None
    pnl: float | None
    pnl_pct: float | None


class Op(TypedDict):
    """一条看板操作（buy/sell），`index` 是 ops() 返回里的数组下标。

    `type` 用 `str` 而非 Literal['buy','sell']：这条记录是 agent/用户手写进来的，
    形状由看板自己兜底（非法值照样原样存、原样展示）。
    """

    index: int
    date: str
    code: str
    type: str
    shares: float
    price: float
    amount: float
    note: str


class FundAccuracy(TypedDict, total=False):
    """单基金战绩：样本数必有；avg_dev / hit_rate 仅在有样本时写（api.ts 的行内 `{n, avg_dev?, hit_rate?}`）。"""

    n: int
    avg_dev: float
    hit_rate: float


class AccuracyBlock(TypedDict):
    """组合级战绩块：n / recent 必有；avg_dev / hit_rate 仅在有样本时写。"""

    n: int
    avg_dev: NotRequired[float]
    hit_rate: NotRequired[float]
    recent: list[TrackRec]


class HotspotCatalyst(TypedDict):
    """市场/主题催化事件。"""

    date: str | None
    title: str
    source: str | None


class HotspotMarket(TypedDict):
    """热点雷达的市场层。"""

    regime: str
    breadth: float | None
    summary: str
    catalysts: NotRequired[list[HotspotCatalyst]]


class HotspotTopPick(TypedDict):
    """热点雷达的个股精选。"""

    ticker: str
    name: str
    theme: str
    ret20: float
    heat: float
    reason: str


class HotspotTheme(TypedDict):
    """热点雷达的单个主题。"""

    name: str
    market: str
    heat: float
    band: str
    live: float
    ret1: float | None
    ret5: float | None
    ret20: float | None
    ret60: float | None
    ma20_dev: float | None
    dist_high: float | None
    vol20: float | None
    maxdd60: float | None
    pos_pct: float | None
    member_breadth: float | None
    vol_ratio: float | None
    above_ma20: bool
    pe_med: float | None
    leaders: list[dict[str, Any]]
    laggards: list[dict[str, Any]]
    catalysts: NotRequired[list[HotspotCatalyst]]


class HotspotData(TypedDict):
    """`state/hotspot.json` 全文（snapshot 原样内嵌）。"""

    generated_at: str
    market: HotspotMarket
    themes: list[HotspotTheme]
    top_picks: NotRequired[list[HotspotTopPick]]


class HotspotBlock(TypedDict):
    """快照里的热点雷达块：数据原文 + 新鲜度（秒）。"""

    data: HotspotData | None
    age_seconds: float | None


class UiSnapshotFund(TypedDict):
    """快照的每只基金（api.ts `FundInfo`）。

    `signals` 是 **裸 rbsa 信号字典**（不是看板的展示信号列表——那个叫
    `signalChips`，见 `ArtifactFundSection`）。
    """

    code: str
    name: str
    official_nav: float | None
    official_date: str | None
    pred_nav: float | None
    pred_ret: float | None
    pred_date: str | None
    pred_label: str | None
    pred_note: str | None
    intraday: Intraday | None
    r2: float | None
    mae: float | None
    mae60: float | None
    p10: float | None
    p90: float | None
    weights: list[WeightRow]
    signals: FundSignal | None
    nav_tail: dict[str, float] | None
    result_updated_at: str | None
    accuracy: FundAccuracy


class UiSnapshot(TypedDict):
    """`state/ui_snapshot.json` 全文（api.ts `Snapshot`）。"""

    version: int
    generated_at: str
    meta: SnapshotMeta
    summary: SnapshotSummary
    holdings: list[Holding]
    ops: list[Op]
    funds: list[UiSnapshotFund]
    accuracy: AccuracyBlock
    hotspot: HotspotBlock
    lookthrough: dict[str, Any] | None


# ---------- state/artifact_*.json 的 funds[] 段（看板） ----------


class ArtifactFundSection(TypedDict, total=False):
    """`jobs.fund_section()` 的展示形状（键名是看板的驼峰式，与 UiSnapshot 的蛇形不同）。

    报错降级的那条只写 `code/name/officialNav/officialDate/error/weights/
    signalChips/alert/intraday`，所以其余键全部可选。
    `signalChips` 是展示信号列表；裸 rbsa 信号字典只存在于 result.json 与
    `UiSnapshotFund.signals`，不落在这里。
    """

    code: str
    name: str
    officialNav: float
    officialDate: str
    officialRet: float
    predDate: str | None
    predRet: float | None
    predNav: float | None
    predLabel: str
    predNote: str
    band: str
    r2: float
    mae: float
    mae60: float
    weights: list[WeightRow]
    signalChips: list[SignalChip]
    alert: str | None
    intraday: Intraday | None
    error: str | None


# ---------- state/briefing.json（AI 首页） ----------


class BriefingIndex(TypedDict):
    """首页指数行（Yahoo 最新两根收盘）。"""

    name: str
    value: float
    pct: float


class BriefingNews(TypedDict, total=False):
    """首页新闻卡。title/prompt 由 agent 补全时必有，其余可选。

    候选（briefing_candidates.json）就是"去掉 impact/prompt 的 news"，因此键名
    本来就必须对得上 —— 时间字段叫 `time`，不叫 `date`。
    `impact` 用 `str` 而非 Literal：这三个值是 agent 写进来的，服务端原样透传。
    """

    title: str
    source: str
    time: str
    impact: str
    funds: list[str]
    prompt: str


class Briefing(TypedDict):
    """`state/briefing.json` 全文（api.ts `Briefing`）。

    `greeting` 与 `suggestions` 可选：AI 首页自带浏览器本地问候与建议兜底，
    服务端只在调用方显式传入时才写。
    """

    date: str
    greeting: NotRequired[str]
    indices: list[BriefingIndex]
    news: list[BriefingNews]
    suggestions: NotRequired[list[str]]
