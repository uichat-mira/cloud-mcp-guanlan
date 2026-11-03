# GLN-014 隔离非生产环境（t18 实测记录）

> 工作项：[t18 · 隔离非生产 Guanlan 环境供给]，关联 Issue [#26 `[GLN-014]`](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/26)
> 状态：**已创建并冒烟通过**（2026-11-04）；仅非生产，生产资源未触碰。
> 该环境服务于 GLN-013/GLN-014 的真实链路验证，不承担生产职责。

## 1. 端点（真实可达）

| 用途 | 端点 |
| --- | --- |
| Worker（workers.dev） | `https://cloud-guanlan-gln014-3c872be6.dangjingtao.workers.dev` |
| 健康检查 | `…/health` |
| MCP 资源端点 | `…/mcp` |
| RFC 9728 资源元数据 | `…/.well-known/oauth-protected-resource/mcp` |
| Cloud Auth 注册接收端（GLN-015） | `…/internal/guanlan-registrations` |

- Worker 名与 D1 名都带随机后缀 `3c872be6`；重建会得到不同后缀，勿把此处主机名当作长期常量。
- `workers.dev` 子域 `dangjingtao` 已由维护者确认开通，**未使用自定义域**，无需域名/证书决策。
- 记录到 host 级为止：D1 UUID 与 Cloudflare account id **不在本文件、不在仓库任何位置**。

## 2. D1 与迁移

| 项 | 值 |
| --- | --- |
| 数据库名 | `cloud-guanlan-gln014-3c872be6` |
| 区域 | WNAM |
| 迁移 | `0001_poc.sql`、`0002_source_leases.sql`、`0003_guanlan_accounts.sql`、`0004_consumer_news_state.sql`、`0005_guanlan_registration_receipts.sql` —— **全部 ✅** |
| `d1_migrations` 记录 | 5 行，与磁盘迁移集合一致（`tests/migration-workerd.test.mjs` 现在由磁盘派生集合，防止漏跑） |

实际建成的表（11 张）：

`d1_migrations`、`poc_sources`、`poc_news`、
`guanlan_accounts`、`guanlan_consumers`、
`guanlan_account_subscriptions`、`guanlan_consumer_subscriptions`、
`guanlan_account_interests`、`guanlan_consumer_interests`、
`guanlan_consumer_news_states`、`guanlan_registration_receipts`。

`database_id` 只保存在**仓库外**临时配置 `%LOCALAPPDATA%\Temp\gln014-env\wrangler.jsonc`；
任何时候可用 `wrangler d1 list` 按名字重新取得。仓库内 `wrangler.jsonc` 仍是不可部署占位。

## 3. 绑定与开关

| 绑定 | 值 |
| --- | --- |
| `DB` | 上表 D1 |
| `MCP_RESOURCE_URL` | `https://cloud-guanlan-gln014-3c872be6.dangjingtao.workers.dev/mcp` |
| `CLOUD_AUTH_ISSUER` | `https://cloud-auth.invalid/`（**占位**，见 §7） |
| `CLOUD_AUTH_JWKS_URL` | `https://cloud-auth.invalid/.well-known/jwks.json`（**占位**，见 §7） |
| `MCP_AUDIENCE` | `mira:cloud-guanlan` |
| `MCP_REQUIRED_SCOPES` | 未设 → 默认 `guanlan.read` |
| `MIRA_GUANLAN_REGISTRATION_SECRET` | 已用 `wrangler secret put` 注入（值只存在于维护者侧共享文件，入库与文档均不含明文） |
| `workers_dev` | `true` |
| `triggers.crons` | `[]`（Cron 关闭，不会产生定时采集/投递） |

## 4. 冒烟结果（真实公网请求）

请求经本机代理 `127.0.0.1:1080`（直连 workers.dev 会超时，属本机网络问题，不是部署问题）。时间：2026-11-04。

| # | 用例 | 期望 | 实测 |
| --- | --- | --- | --- |
| S1 | `GET /health` | 200 | `200 {"service":"cloud-guanlan-poc","status":"ok","publicApi":false}` |
| S2 | `GET /.well-known/oauth-protected-resource/mcp` | 200 | `200`，`resource`=本 Worker `/mcp`，`scopes_supported:["guanlan.read"]`，`authorization_servers:["https://cloud-auth.invalid/"]`，`bearer_methods_supported:["header"]` |
| S3 | `POST /mcp` 匿名 | 401 + `WWW-Authenticate` | `401`，`Bearer error="invalid_token", error_description="Missing Authorization header", scope="guanlan.read", resource_metadata="…/.well-known/oauth-protected-resource/mcp"` |
| S4 | `POST /mcp` 垃圾 bearer | 401 | `401 {"error":"invalid_token","error_description":"invalid_token"}`（JWKS 为占位域名，fail closed） |
| S5 | `GET /internal/unknown` | 404 | `404 {"error":"not_found"}` |
| S6 | `POST /internal/guanlan-registrations` 首次 | 200 + 收据 | `200 {"accountId":"<synthetic>","registered":true}` |
| S7 | 同上（重复投递） | 200、不重复建行 | `200`，D1 行数不变、`deliveries` 递增 |
| S8 | 同上（时间戳 −301s） | 401 | `401 {"error":"invalid_timestamp"}` |
| S9 | 同上（错误 secret 签名） | 401 | `401 {"error":"invalid_signature"}` |

签名由 Node 自带 `crypto` 独立计算（`HMAC-SHA256(secret, timestamp + "." + body)`），签名脚本与方法无关，仅作外部验证。

**真实 D1 副作用核对**（`wrangler d1 execute --remote`，账号为合成 UUID `1111…`/`2222…`，非真实账号）：

| 表 | 结果 |
| --- | --- |
| `guanlan_accounts` | 2 行 |
| `guanlan_consumers` | 2 行，`consumer_id` 与 `account_id` 相同（维护者裁决①） |
| `guanlan_registration_receipts` | 2 行，`deliveries` 分别为 4、1 |
| 订阅 / 关注点 / 账本 / `poc_sources` / `poc_news` | **0 行**（接收端不写任何私有数据） |

> 说明：`2222…` 这一行是首次冒烟脚本里「错误 secret」用例的构造缺陷（当时签名函数忽略了传入的 secret），
> 该请求实际带了正确签名，因此被正确受理。修正脚本后同一用例返回 `401 invalid_signature`（S9）。
> 这一行保留为合成数据，不代表任何真实账号。

## 5. 如何重建（可复制）

前置：维护者凭证文件 `C:\Users\Administrator\.mira-secrets\cloudflare.env`（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`），
以及共享注册密钥文件 `C:\Users\Administrator\.mira-secrets\guanlan-registration.env`。
两者都**只在运行环境注入**，不写入仓库、`.env` 或日志。

```powershell
# 0) 同一次 pwsh 调用内注入（值不打印）
$raw = [IO.File]::ReadAllText('C:\Users\Administrator\.mira-secrets\cloudflare.env')
$env:CLOUDFLARE_API_TOKEN  = [regex]::Match($raw,'(?m)^\s*CLOUDFLARE_API_TOKEN\s*=(.*)$').Groups[1].Value.Trim()
$env:CLOUDFLARE_ACCOUNT_ID = [regex]::Match($raw,'(?m)^\s*CLOUDFLARE_ACCOUNT_ID\s*=(.*)$').Groups[1].Value.Trim()
$reg = [IO.File]::ReadAllText('C:\Users\Administrator\.mira-secrets\guanlan-registration.env')
$env:MIRA_GUANLAN_REGISTRATION_SECRET = [regex]::Match($reg,'(?m)^MIRA_GUANLAN_REGISTRATION_SECRET=(.+)$').Groups[1].Value.Trim()

# 1) 构建（仓库内）
cd <cloud-mcp-guanlan worktree>; npm ci; npm run build

# 2) 建独立 D1（非生产）
$suffix = -join ((1..8) | % { '{0:x}' -f (Get-Random -Minimum 0 -Maximum 16) })
$name = "cloud-guanlan-gln014-$suffix"
.\node_modules\.bin\wrangler.cmd d1 create $name     # 记下 database_id

# 3) 仓库外临时配置（把 <DB_ID> 换成上一步的值）
$tmp = "$env:LOCALAPPDATA\Temp\gln014-env"; New-Item -ItemType Directory -Force $tmp, "$tmp\migrations" | Out-Null
Copy-Item .\dist\worker.mjs "$tmp\worker.mjs" -Force
Copy-Item .\migrations\*.sql "$tmp\migrations\" -Force
# wrangler.jsonc 模板见下方代码块

# 4) 迁移（注意：wrangler 4.156 的 d1 migrations apply 不接受 --yes；非交互环境会自动跳过确认）
.\node_modules\.bin\wrangler.cmd d1 migrations apply $name --remote --config "$tmp\wrangler.jsonc"

# 5) 注入共享密钥并部署
$env:MIRA_GUANLAN_REGISTRATION_SECRET | .\node_modules\.bin\wrangler.cmd secret put MIRA_GUANLAN_REGISTRATION_SECRET --config "$tmp\wrangler.jsonc"
.\node_modules\.bin\wrangler.cmd deploy --config "$tmp\wrangler.jsonc"
```

`<tmp>\wrangler.jsonc` 模板（**仓库外**，含真实 UUID，勿提交）：

```jsonc
{
  "name": "cloud-guanlan-gln014-<SUFFIX>",
  "main": "./worker.mjs",
  "compatibility_date": "2026-08-06",
  "workers_dev": true,
  "migrations_dir": "./migrations",
  "triggers": { "crons": [] },
  "d1_databases": [
    { "binding": "DB", "database_name": "cloud-guanlan-gln014-<SUFFIX>", "database_id": "<DB_ID>" }
  ],
  "vars": {
    "MCP_RESOURCE_URL": "https://cloud-guanlan-gln014-<SUFFIX>.dangjingtao.workers.dev/mcp",
    "CLOUD_AUTH_ISSUER": "https://cloud-auth.invalid/",
    "CLOUD_AUTH_JWKS_URL": "https://cloud-auth.invalid/.well-known/jwks.json",
    "MCP_AUDIENCE": "mira:cloud-guanlan"
  }
}
```

> `migrations_dir` 在 deploy 时会被 wrangler 标为未知顶级字段（仅迁移命令需要），可安全忽略。

## 6. 如何销毁

```powershell
# 先在同一个 pwsh 调用里注入凭证（同 §5 第 0 步）
.\node_modules\.bin\wrangler.cmd delete --config "$tmp\wrangler.jsonc"          # 删 Worker（含 secret 绑定）
.\node_modules\.bin\wrangler.cmd d1 delete $name --skip-confirmation            # 删 D1（不可恢复）
Remove-Item -Recurse -Force "$tmp"                                              # 删仓库外临时配置与产物
```

- 删除 D1 会一并丢弃所有空间行与收据，不可恢复；销毁前确认已无验证依赖。
- **绝不触碰**账号下现有 `cloud-guanlan-gln003-canary` 与 `mira-shiyan` 两个库，以及任何既有 Worker 脚本。

## 7. 仍缺的条件（阻塞真实链路验收的部分）

| # | 缺口 | 影响 | 解除方 |
| --- | --- | --- | --- |
| G1 | **非生产 Cloud Auth 实例**（公网可达的 JWKS + 签发端点）。当前 `CLOUD_AUTH_JWKS_URL` 是 `https://cloud-auth.invalid/...` 占位 | 任何 bearer 都 401（fail closed）；**「错误 audience 401」只验证到「JWKS 不可验证」分支**，真正的 `iss`/`aud`/`scope` 校验要等替换成真实 JWKS 后才能验证 | auth-dev（禁止指向生产 `cloud-auth.tomzlab.cn`） |
| G2 | **测试账号 + 设备绑定 Cloud Session** | 无法走 GLN-013 `POST /v1/service-credentials` 取得真实令牌 | auth-dev（t23） |
| G3 | **真实空间行** | 已用合成 UUID 证明接收端可建行；真实账号的行必须由 GLN-012 向 `…/internal/guanlan-registrations` 投递（outbox → `delivered`）产生 | auth-dev 配置 `MIRA_GUANLAN_REGISTRATION_URL` 指向本端点 |
| G4 | **已批准新闻源** | `poc_sources`/`poc_news` 现为 0 行，`guanlan_news_list` 只能返回空集，无法验证有内容的读路径 | 维护者批准源清单 + ingest 授权 |
| G5 | 真实模型 / 企业微信通道 | 不属于本卡与 GLN-014 范围 | lead 统一排期 |

## 8. 与 t10（GLN-014 L3 验收）的接口

1. 把 `…/internal/guanlan-registrations` 交给 auth-dev 配置为 Cloud Auth 的 `MIRA_GUANLAN_REGISTRATION_URL`（必须 https）。
2. G1 解除后，用真实的 `CLOUD_AUTH_ISSUER` / `CLOUD_AUTH_JWKS_URL` 重新 `wrangler deploy`（只需改变量，不必重建 D1）。
3. 用真实令牌 `POST /mcp`（`initialize` → 只读工具），沿 GLN-014 验收矩阵的 N/P 用例逐项取证；此时 `guanlan_principal_unavailable` 应不再出现（G3 已满足）。
4. 全程禁止指向生产 Cloud Auth 或生产 D1/Worker。
