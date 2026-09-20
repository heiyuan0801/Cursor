# PostgreSQL + Redis 生产部署

当前后端只支持 API Sidecar + Node SDK Bridge + PostgreSQL + Redis，不再提供 Worker、D1、Durable Object 或 R2 文件服务入口。

## 启动

1. 复制 .env.docker.example 为 .env，设置强管理员密码、ENCRYPTION_KEY、POSTGRES_PASSWORD 和 Bridge Token。
2. 新部署执行 docker compose up -d --build；升级前先阅读 [数据迁移指南](POSTGRES_REDIS_MIGRATION.md)，停止旧写入、备份、导入，再启动新 API。
3. 通过 /health 检查 PostgreSQL/Redis 可达性。用 Dashboard 创建客户端 Key，验证模型列表和流式请求。
4. 只暴露 API 端口，用可信反向代理提供 HTTPS。数据库和 Redis 不应直接暴露到公网。

## 运维

- 所有 API 副本共享数据库、Redis 前缀和同一 ENCRYPTION_KEY。
- 账号按对话固定，绑定由 Redis Lua 原子分配和续期；新对话才参与轮询。所有副本统一设置 CURSOR_ACCOUNT_STICKY_TTL_SECONDS（默认 7200 秒，范围 60–86400 秒）。
- 显式会话 ID 应在同一对话中保持不变，不同对话/分支不能共用。无 ID 的完整历史会自动识别续聊；换号或过期后会冷启动 SDK 会话。该行为优化缓存复用机会，不承诺上游命中率。
- SDK Bridge 当前保持单实例；活跃 SDK Agent/gRPC 连接不是 Redis 数据。
- 定期备份 PostgreSQL 和 ENCRYPTION_KEY。Redis 使用持久数据卷与 AOF。
- 数据库连接失败时健康检查失败，不会回退到 JSON 文件；Redis 故障不会回退到本地登录会话。
- 日志清理是管理员手动操作；无定时自动删除策略。
- 登录限流使用实际 TCP 对端地址。反向代理后的管理登录会共用代理 IP 的限流窗口，不信任客户端伪造的转发头。
- 旧 Worker 的 /download、/releases 和 /appcast.xml 服务不再存在。桌面安装包若需发布，使用独立文件托管服务；仓库的可选 R2 上传脚本仅上传发布文件，不参与网关存储。
- 本次代码清理不会自动卸载或删除已部署的旧云资源。

## 发布验证

先运行 npm ci、npm run typecheck、npm test、npm run build，再构建 API 与 Bridge 镜像。CI 的独立 PostgreSQL/Redis 服务执行真实存储集成测试；无 TEST_DATABASE_URL 和 TEST_REDIS_URL 时本地跳过该组测试。

Windows 托盘为可选客户端启动器，必须提供数据库、Redis 与加密配置；它不会安装或管理这两项数据库服务。
