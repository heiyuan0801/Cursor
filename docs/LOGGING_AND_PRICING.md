# 使用日志与费用统计

本项目仅使用 PostgreSQL + Redis。使用日志保存在 PostgreSQL 的 cursor_usage_logs 表；Redis 保存登录会话和缓存，不保存业务日志。

## 访问与筛选

管理接口需要 Dashboard 登录后获得的 HttpOnly 会话 Cookie，不能使用客户端 sk- API Key 读取或删除日志。

- GET /api/usage：查询请求数、成功/失败数、Token、费用、平均耗时及模型汇总。
- GET /api/logs：查询日志，limit 默认 100、最大 1000，offset 从 0 开始。
- 两个查询接口均支持 start_date、end_date；省略时查询全部。
- 使用 ISO 时间戳（带 Z 或时区偏移）表达本地范围。纯 YYYY-MM-DD 按 UTC 解释；end_date 包含当天最后一毫秒。
- Dashboard 提供今天、昨天、近一周、近一月、全部快捷筛选。model/status 查询参数目前不提供筛选功能。
- 非法日期、反向范围、非法分页参数返回 400。

## 清理

DELETE /api/logs?before=2026-01-01T00:00:00.000Z 删除 created_at 严格早于截止时间的日志，返回实际 deleted 数量。必须显式指定 before，且不能是未来时间；不支持用 start_date/end_date 删除区间。

Dashboard 提供清理 7、30 或 90 天前数据的手动操作。清理会直接删除 PostgreSQL 行，没有自动回收站，操作前应备份；这不是定时保留策略。

## 记录字段

每条记录包含 id、endpoint、model、status（completed/error）、created_at、completed_at、duration_ms、error，以及：

- total_tokens、input_tokens、output_tokens、cache_read_tokens、cache_write_tokens。
- total_cost、input_cost、output_cost、cache_read_cost、cache_write_cost，金额单位 USD。

created_at 是请求开始时间，completed_at 是响应结束时间；按开始时间筛选。当前不单独持久化 reasoning_tokens、Agent ID、Conversation ID 或首 Token 耗时，averageFirstTokenMs 返回 null。

## 计费口径

优先使用上游返回的 usage；未返回时，协议适配器按文本字符量估算 Token。流式 Chat 即使未设置 stream_options.include_usage，也会在网关内部统计，且不会额外改变客户端收到的流格式。

输入、输出、缓存读取、缓存写入分别计费。OpenAI 的总输入已包含缓存部分，统计时会拆分，避免重复计算；Anthropic 的缓存字段单独累计。价格表位于 core/pricing.ts，是仓库内置数据，不会自动同步上游价格。未知模型使用默认基准价格估算，控制台数字不等同于 Cursor 最终账单。

## 迁移与部署

启动时自动建表，也可通过 npm run db:migrate 执行。旧 JSON 文件需显式导入，参见 [迁移指南](POSTGRES_REDIS_MIGRATION.md)。旧 Worker/D1 的建表与部署命令已删除。
