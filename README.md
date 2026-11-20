# Crypto Market Data (Phase 1)

这是独立于518880黄金ETF仓库的加密货币市场数据系统。第一阶段只验证云端自动采集链路，不下单、不使用API密钥、不持久化历史。

## 当前功能
- 六币 BTC、ETH、SOL、LINK、PENDLE、ONDO；Bitget公开现货USDT交易对。
- 分别读取Ticker、4H、1D K线；不把未收盘K线当成已完成。
- 检查行情时间戳、OHLC合理性、正成交量、最近4根K线连续性。
- GET /health：确认Worker已部署；不代表行情可用。
- GET /snapshot：在线采集6币；只有6/6全部通过才返回HTTP 200，其他情况为HTTP 503及逐币错误。
- Cloudflare Cron每15分钟执行一次并写结构化日志；失败即抛异常。

## 重要限制
当前没有GitHub/R2/KV持久化，也没有OI、资金费率、清算事件或第二交易所备用源。当前版本不能用于正式交易信号。
已收盘日线按Bitget UTC+8日界限（UTC 16:00）处理；4H按UTC 4小时边界。
无真实成交或缺失的K线不会被补造。

## Cloudflare部署
在Cloudflare账户中：Workers & Pages -> Create -> 从GitHub导入本仓库。
如要求构建命令，可使用 npm run deploy；配置文件位于仓库根目录 wrangler.jsonc。
部署后访问Workers域名 /health 和 /snapshot，并查看 Cron Invocations。
请不要把任何访问令牌写入公开仓库。

下一阶段：持续运行验证、数据持久化和交易所备用源，最后再接入OI/清算与信号引擎。

参考：https://www.bitget.com/docs/catalog/market/market-data
Cloudflare Cron：https://developers.cloudflare.com/workers/configuration/cron-triggers/
