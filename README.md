# Crypto Market Data — Phase 3A (Gate Spot + Derivatives + D1)

独立于黄金 ETF 项目的加密货币**公开市场数据**服务，不连接交易账户、不读取个人持仓、不存交易密钥、不自动下单。

六币：BTC、ETH、SOL、LINK、PENDLE、ONDO。

## 原有现货功能
- Gate Global 现货报价、真实成交、已收盘4H/1D K线校验，15分钟 Cron 写入 D1 的 crypto_snapshots。
- GET /snapshot、/latest、/audit、/health、/sources、/gate-snapshot、/gate-trades 原有接口保留。

## Phase 3A 衍生品采集
- Gate futures/usdt/contract_stats：每币最近24个5分钟样本，过滤未闭合、过期和无效记录；存储 OI 合约数、OI USD 名义价值及 5m 强平美元金额。
- Gate futures/usdt/funding_rate：每币最近4条历史已结算资金费率，不能当成未来费率预测。
- Gate futures/usdt/liq_orders：每币最近30分钟公开强平订单，15分钟 Cron 重叠抓取；接口无公开的 offset/cursor 分页。返回满100条时按时间窗拆分（每币最多4次请求，六币合计最多追加6次请求），仍无法完整获取即标记 INCOMPLETE。
- 公开强平订单无唯一事件ID，用合约、秒级时间、订单大小及价格字段生成稳定指纹；完全相同字段的不同事件可能被合并，事件计数只能视为公开记录的下界。
- 每轮每币最多保存80条去重强平订单；超限标记 INCOMPLETE，控制 D1 写入量。强平金额优先使用 contract_stats 5分钟聚合，不根据订单数猜测总金额。
- 现货与衍生品在同一15分钟 Cron 内并行、独立保存，某项数据失败不阻止另一项持久化。

D1 新表：
- derivative_slots：每币每15分钟质量状态、真实请求结果。
- derivative_stats：5分钟 OI 与聚合强平金额。
- derivative_funding：已结算历史资金费率。
- derivative_liq_events：基于稳定指纹去重的 Gate 公开强平订单。

保存30天，现有 MARKET_DB 绑定不变。

## 新增只读接口
- GET /derivatives-probe：原有一次性连通性探针，不写D1。
- GET /derivatives-audit：每币录得/完整/不完整/逾期缺失的15分钟槽，7分钟宽限。
- GET /derivatives-latest：基于 D1 历史显示 OI 1h/4h/24h 变化，过去30分钟与再前30分钟 Gate 强平金额对比，最近已结算资金费率。历史不足/不连续时明确显示 INSUFFICIENT_HISTORY / INCOMPLETE_HISTORY。

上述指标均为描述性观察，**不生成买卖信号**。Gate 单一交易所不等于全市场；零条公开强平记录不等于无强平。

## 验收
1. 执行 npm test（Node 内置测试，无额外运行依赖）。
2. 合并后验证 Cloudflare GitHub 集成或手动部署已发布 main 最新提交；GitHub 合并并不保证已经部署。
3. 检查 /health 版本 0.4.0-phase3a，persistence_enabled=true。
4. 下一次实际 Cron 后检查 /derivatives-audit、/derivatives-latest，并用 /audit 验证现货未受影响。
5. 连续24小时（96个时间槽）检查漏采和数据质量，再用3–7天观察初步稳定性；暂不把这些样本称为历史回测。
6. Phase 3B 另行增加跨交易所校验、策略回测与信号判定。

Workers Free 每次最多50次外部请求。当前单轮约24次现货 + 18次衍生品基础请求 + 最多6次强平拆分请求 = 48次，留2次余量。Cloudflare Free 的 D1/Workers 配额要持续核查；该设计仅限制程序发起的请求数量，意外重定向及其他消耗仍需监控。

官方资料：https://www.gate.com/docs/developers/apiv4/en/futures/ ；https://developers.cloudflare.com/d1/worker-api/d1-database/ ；https://developers.cloudflare.com/d1/platform/pricing/

## Phase 3A.1：现货币种级独立读取

- 旧 `GET /latest` 保持原语义：只返回最近一条六币全部 READY 的现货快照；若此前6/6样本过期，仍会标记 STALE。
- 新 `GET /latest-assets` 从最近12个 D1 现货快照中，为每个币独立选取最近一条经过真实成交时间校验的记录；最近快照采集时间不得超过20分钟、交易所最后成交时间不得超过15分钟，交易所成交时间也不能晚于快照本身。合并不同时间槽时，每个币独立标注各自原始样本时间。
- `RECENT_PARTIAL` 不是六币全通过。若PENDLE现货超过5分钟没有成交、原始快照将PENDLE标记UNKNOWN，新接口会单独报告 `NO_RECENT_VERIFIED_SPOT`，保留错误原因，同时仍提供BTC/ETH/SOL/LINK/ONDO各自经过验证的数据。
- `RECENT_VERIFIED` 只表示来自历史D1样本、满足设定时效，不等于毫秒级实时行情或买入信号。接口不引入新的外部 API 请求，不放松既有 `/snapshot` 资格标准。
