# PostgreSQL + Redis 迁移指南

## 范围与存储分工

本项目现仅保留 PostgreSQL + Redis 网关。旧 Worker 路由、D1 表迁移、Durable Object 容器绑定和 Wrangler 配置已移除，共享协议代码迁至 core/。本地源码清理不会删除已部署的远端资源；JSON 导入命令也不会读取旧 D1 数据。

| 数据 | 新存储 |
| --- | --- |
| 管理员密码（scrypt 哈希）、客户端 Key（SHA-256 哈希）、对外地址 | PostgreSQL |
| Cursor 凭据（AES-256-GCM 加密）、账号与模型禁用状态 | PostgreSQL |
| 使用日志、Token、费用、耗时、导入记录 | PostgreSQL |
| 管理员登录会话 | Redis，7 天 TTL |
| 对话指纹、轮询计数 | Redis，2 小时 TTL |
| SDK 会话映射 | Redis，6 小时 TTL |
| Responses 响应缓存（按客户端 Key 隔离） | Redis，1 天 TTL |
| 模型目录 | Redis，60 秒新鲜缓存，临时上游错误最多使用 10 分钟内旧缓存 |
| 登录尝试计数 | Redis，60 秒窗口 |

同一网关的副本必须共享数据库、Redis 前缀和 ENCRYPTION_KEY。Redis 不可用时不会回退到进程内登录会话；健康检查失败。模型缓存不可用时仍可直接请求上游目录，不会生成假目录。

SDK Bridge 的活跃 Agent、gRPC 连接和本地 SDK SQLite 工作目录属于运行中的 SDK 资源，不能序列化进 Redis。API 副本可以共享一个 Bridge；不要据此直接把 Bridge 扩为多副本。Bridge 重启会重建 Agent 并发送完整上下文。启动器的 PID、stdout 日志和本机加密密钥配置也仍保留在本机，不属于业务数据。

## 新部署

推荐 PostgreSQL 16+、Redis 7+。无数据库配置时服务会拒绝启动。

```bash
cp .env.docker.example .env
# 填写 ADMIN_PASSWORD、ENCRYPTION_KEY、POSTGRES_PASSWORD、CURSOR_SDK_BRIDGE_TOKEN
docker compose up --build
```

当前修改尚未发布到公共镜像时必须使用源码构建；不要直接拉取旧的 latest 镜像。只对外暴露 API 端口，PostgreSQL 和 Redis 不发布宿主机端口。生产环境请设置强密码，限制容器网络访问；使用外部数据库/Redis 时配置 TLS、访问控制和备份。

本地启动需先准备数据库和 Redis，设置 DATABASE_URL（或 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD）、REDIS_URL、ENCRYPTION_KEY。例如把配置放入本机 .env 后：

```bash
node --env-file=.env server.mjs start
```

Sidecar 启动时自动执行建表事务。也可安装 Bun 后单独执行：

```bash
npm run db:migrate
```

SQL 对应 migrations/postgres 下的文件。自动建表使用事务级 advisory lock，可安全应对多副本同时启动。当前启动过程会执行建表检查，数据库账号需要相应 schema 权限及业务表读写权限。

## 从旧版 JSON 数据升级

1. 停止旧网关写入，备份旧数据卷/JSON 文件，以及原来的 ENCRYPTION_KEY。本地启动器自动生成的密钥位于 ~/.cursor2api/config.json；不要生成新密钥代替旧密钥。
2. 准备 PostgreSQL 和 Redis，使用原 ENCRYPTION_KEY。首次导入前不要启动新 API 或配置新管理员密码。
3. 显式指定要导入的文件。缺失、损坏、解密失败会中止导入并回滚；只传实际存在的文件。

本地导入（Bun 会读取当前目录 .env；确认指向正确的目标库）：

```bash
npm run db:import -- \
  --auth /absolute/path/auth-state.json \
  --router /absolute/path/router-state.json \
  --usage /absolute/path/auth-state.json.usage
```

Docker 升级（原 router-data 数据卷保持原 Compose 项目名称，不要改名或删除）：

```bash
docker compose stop api bridge
docker compose up -d postgres redis
docker compose build api bridge
docker compose run --rm --no-deps \
  --entrypoint /usr/local/bin/cursor2api-migrate api --import \
  --auth /var/lib/api-for-cursor/auth-state.json \
  --router /var/lib/api-for-cursor/router-state.json \
  --usage /var/lib/api-for-cursor/auth-state.json.usage
docker compose up -d --build
```

如果旧版本未产生 usage 文件，移除 --usage 参数。本次保留 router-data 只读挂载，运行期间不再写入 JSON；迁移工具打包在 API 镜像内。旧版由环境变量提供的 Cursor Key 没有写入路由文件的密文，导入时必须同时配置原 CURSOR_API_KEY(S)，才能恢复这些 Key 的禁用状态。

导入行为：

- 保留密码哈希、Key 哈希、加密凭据、日志 ID、原时间和费用。
- 已存在的记录不覆盖；如果新库已设置管理员密码，仍使用新库密码。
- 以“文件类型 + 绝对路径”记录成功导入。重复运行同一路径不会重复计数，也不会复活随后撤销的客户端 Key。不要改名后反复导入同一份旧备份。
- 不复制旧登录会话；升级后重新登录即可。
- 原文件不修改、不删除。不要在验证和完成备份前执行 docker compose down -v。

## 验证与回滚

启动后检查 /health，再登录 Dashboard 核对账号、禁用模型、客户端 Key 数量，以及全部时间范围内的日志数、Token 和费用。验证旧客户端 Key 仍可使用，并确认撤销后立即失效。日期筛选和手动清理直接操作 PostgreSQL，不依赖本地文件。纯日期按 UTC 解释，end_date 包含当天；非法日期、反向时间范围和未来清理截止时间会返回 400。

PostgreSQL 是业务数据主存储，需要定期备份。Redis 使用 AOF 数据卷；清空 Redis 会注销会话并丢失暂存响应/缓存，但不会删除账号和使用日志。

如需回滚，先停止新网关，再恢复旧版本及保留的旧数据卷。新版本运行后的新增记录只在 PostgreSQL 中，不能自动反向写回旧 JSON；回滚前先备份新库并核对这部分数据。

## 开发验证

```bash
npm run typecheck
npm test
npm run build:client
```

PostgreSQL SQL 回归使用嵌入式 PostgreSQL（PGlite）执行，不需要 Docker。真实 PostgreSQL/Redis 集成测试只在显式设置 TEST_DATABASE_URL 和 TEST_REDIS_URL 时运行；CI 提供独立测试服务，测试会创建并清理自己生成的临时 schema/Redis 前缀，不使用应用的 DATABASE_URL。
