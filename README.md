# Crypto Market Data — Phase 2B (Gate + Cloudflare D1)

独立于 518880 黄金ETF项目的加密货币公开数据服务。当前不进行自动交易，也未具备正式策略信号所需的完整衍生品数据。

## 现已验证的范围
- Bitget现货API从Cloudflare返回403，OKX返回429，Binance公开API返回403。
- Gate国际站（api.gateio.ws）BTC / ETH / SOL / LINK / PENDLE / ONDO：六币报价、近期4H和1D K线在Cloudflare真实探针中全部通过。
- Gate公开最近成交：六币均取得带交易所时间戳的真实成交，价格和ticker差异通过检查。上述单次通过不等于保证长期稳定。

## 当前Worker接口
- `/snapshot`：实时获取Gate国际站六币报价、最近成交、4H及1D已收盘K线，验证OHLC/成交量/连续性/新鲜度。仅6/6通过返回200，其余为503。
- `/latest`：从绑定的D1读取最近有效快照；超过30分钟标记STALE。未绑定或表未初始化时明确返回503。
- `/health`：Worker及D1绑定诊断，不代表行情全部有效。
- `/gate-snapshot`：Gate全球站和美国站现货资格探针；`/gate-trades`：六币真实成交时间探针。
- `/sources`：多来源连通性探针（非正式数据切换）。

## 自动运行与存储
- Cron：每15分钟，在Worker上执行六币Gate现货采集。
- 可选D1数据库绑定变量名：`MARKET_DB`；尚未在`wrangler.jsonc`填写，等待用户先从Cloudflare控制台创建数据库，取得database_id后再更新配置。
- 绑定后第一次Cron自动建表 `crypto_snapshots`；每15分钟时间槽最多1条（同槽仅在通过数改善时替换）。
- 单个快照最大160KB。每日最多96个时间槽，数据保留30天，每日UTC零点附近执行清理。
- 无数据库时仍可诊断，但绝不标记持久化成功。
- /snapshot为GET只读接口，不允许公众触发写入；D1写入仅由Cron触发。
- 未经授权不会存储账户API密钥、真实持仓或下单信息。

## D1免费配额
Workers Free下D1每日500万行读取、10万行写入；单数据库500MB，账户总存储5GB。超过免费配额时停止受限数据库操作，而非自动超额计费（前提是账户仍为Workers Free）。请勿升级到付费计划以免改变此保护。来源：https://developers.cloudflare.com/d1/platform/pricing/ 和 https://developers.cloudflare.com/d1/platform/limits/

## 仍待完成
1. 在Cloudflare创建D1数据库 `crypto-market-db`。
2. 将其ID写入wrangler.jsonc的 `d1_databases`：`binding: MARKET_DB`，然后部署。
3. 验证真实定时触发、D1读写、故障时不误报READY和连续运行稳定性。
4. 后续再增加独立备用交易所、OI/资金费率/强平事件的保存。现阶段不能用于正式策略交易信号。
