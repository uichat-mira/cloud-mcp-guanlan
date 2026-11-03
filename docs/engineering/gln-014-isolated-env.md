# GLN-014 隔离非生产环境（t18 实测记录）

> 工作项：[t18 · 隔离非生产 Guanlan 环境供给]，关联 Issue [#26 `[GLN-014]`](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/26)
> 状态：**已创建并冒烟通过**（2026-11-04）；仅非生产，生产资源未触碰。
> 该环境服务于 GLN-013/GLN-014 的真实链路验证，不承担生产职责。
> **销毁方式**：`wrangler delete --config <仓库外配置>`（删 Worker，含 secret 绑定）+ `wrangler d1 delete cloud-guanlan-gln014-<后缀> --skip-confirmation`（删 D1，不可恢复），详见 §6。

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
| `CLOUD_AUTH_ISSUER` | 初建时为占位 `https://cloud-auth.invalid/`；**t10 起改为非生产 Cloud Auth 的 HTTPS URL**（当前 `https://<current-host>`，见 §7 G1）。注意：它必须是 URL，不能填 `mira:cloud-auth`（那是 JWT 的 `iss` 常量，填进变量会让 `/mcp` 503） |
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

> **前置（重要，F-30-1）**：`migrations/0005_guanlan_registration_receipts.sql` 与 `src/registration.ts` **目前只在未合并分支**
> `feat/gln-015-registration-receiver`（PR #29，SHA `57c7b52`）上；`dev` 分支**没有**这两个文件，直接在 `dev` 上照抄本节会在
> `d1 migrations apply` 阶段因缺 `0005` 而建不出收据表（注册端点会以 `500 registration_unavailable` fail closed）。
> 二选一：① 先合并 PR #29；② 从该分支构建：`git worktree add ../gln-015 57c7b52`，在**那个** worktree 里跑 `npm ci && npm run build`，
> 后续命令的 `.\dist\worker.mjs` 与 `.\migrations\*.sql` 都指该 worktree。本节记录的实测环境即用 ②。

前置：维护者凭证文件 `$env:USERPROFILE\.mira-secrets\cloudflare.env`（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`），
以及共享注册密钥文件 `$env:USERPROFILE\.mira-secrets\guanlan-registration.env`。
两者都**只在运行环境注入**，不写入仓库、`.env` 或日志。

```powershell
# 0) 同一次 pwsh 调用内注入（值不打印）
$raw = [IO.File]::ReadAllText("$env:USERPROFILE\.mira-secrets\cloudflare.env")
$env:CLOUDFLARE_API_TOKEN  = [regex]::Match($raw,'(?m)^\s*CLOUDFLARE_API_TOKEN\s*=(.*)$').Groups[1].Value.Trim()
$env:CLOUDFLARE_ACCOUNT_ID = [regex]::Match($raw,'(?m)^\s*CLOUDFLARE_ACCOUNT_ID\s*=(.*)$').Groups[1].Value.Trim()
$reg = [IO.File]::ReadAllText("$env:USERPROFILE\.mira-secrets\guanlan-registration.env")
$env:MIRA_GUANLAN_REGISTRATION_SECRET = [regex]::Match($reg,'(?m)^MIRA_GUANLAN_REGISTRATION_SECRET=(.+)$').Groups[1].Value.Trim()

# 1) 构建（在含 0005/registration.ts 的 worktree 内）
cd <cloud-mcp-guanlan worktree at 57c7b52>; npm ci; npm run build

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

需要删除的资源只有两个：**Worker**（`cloud-guanlan-gln014-3c872be6`，连同其 secret 绑定）与 **D1**（`cloud-guanlan-gln014-3c872be6`）。
下面整段自包含，可直接复制执行：

```powershell
# 0) 注入凭证（值不打印），并定位仓库外配置
$raw = [IO.File]::ReadAllText("$env:USERPROFILE\.mira-secrets\cloudflare.env")
$env:CLOUDFLARE_API_TOKEN  = [regex]::Match($raw,'(?m)^\s*CLOUDFLARE_API_TOKEN\s*=(.*)$').Groups[1].Value.Trim()
$env:CLOUDFLARE_ACCOUNT_ID = [regex]::Match($raw,'(?m)^\s*CLOUDFLARE_ACCOUNT_ID\s*=(.*)$').Groups[1].Value.Trim()
$tmp  = "$env:LOCALAPPDATA\Temp\gln014-env"
$name = if (Test-Path "$tmp\env-name.txt") { (Get-Content "$tmp\env-name.txt" -Raw).Trim() } else { "cloud-guanlan-gln014-3c872be6" }

cd <含 wrangler 的 cloud-mcp-guanlan worktree>
# 1) 删 Worker（--yes 跳过交互确认；secret 绑定随 Worker 一起消失）
.\node_modules\.bin\wrangler.cmd delete --config "$tmp\wrangler.jsonc" --yes
# 2) 删 D1（不可恢复）
.\node_modules\.bin\wrangler.cmd d1 delete $name --skip-confirmation
# 3) 清理仓库外临时配置与产物（内含 D1 UUID）
Remove-Item -Recurse -Force $tmp
```

- 删除 D1 会一并丢弃所有空间行与收据，不可恢复；销毁前确认已无验证依赖（**t9 未跑完前不要销毁**）。
- 账号下另有 `cloud-guanlan-gln003-canary`、`mira-shiyan` 两个库与 13 个既有 Worker，**都不属于本环境**，销毁时不要对它们执行任何删除命令。

### 6.1 「本卡未改变既有资源」的可复核快照（F-30-2）

本卡执行过的**变更类**命令只有：`d1 create`（新库）、`d1 migrations apply`（仅对新库）、`secret put`（仅对新 Worker）、`deploy`（仅对新 Worker），以及一次 `d1 execute` 写入了 t10 用的合成 fixture 行。
**没有对任何既有资源执行变更命令**（无 delete / rename / 权限修改）。以下是事后只读快照（`wrangler d1 list` 与 Workers API `GET /accounts/<已脱敏>/workers/scripts`，2026-11-04 采集）：

| D1 库 | `created_at`（UTC） | 归属 |
| --- | --- | --- |
| `cloud-guanlan-gln014-3c872be6` | 2026-11-03T17:22:57Z | 本卡创建 |
| `cloud-guanlan-gln003-canary` | 2026-10-31T17:18:26Z | 既有，未改 |
| `mira-shiyan` | 2026-08-31T01:23:39Z | 既有，未改 |

Worker 脚本共 14 个：13 个既有脚本的 `modified_on` 全部 ≤ `2026-11-03T14:49:04Z`（早于本卡首次 deploy），第 14 个是本卡创建的同名 Worker，`modified_on = 2026-11-03T17:54:03Z`。

## 7. 缺口状态（2026-11-04 更新）

| # | 缺口 | 当前状态 | 解除方 |
| --- | --- | --- | --- |
| G1 | **非生产 Cloud Auth 实例**（公网可达 JWKS） | **已临时满足**：JWKS 指向 auth-dev t23 实例的 localhost.run 隧道（`CLOUD_AUTH_JWKS_URL=https://<current-host>/.well-known/jwks.json`，`kid=gln013-t23-1`），真实令牌已被接受（见 t10 验收记录）。仍属**临时设施**：隧道重连换 host，换址期间 `/mcp` 全部 401（fail closed） | auth-dev；长期需常驻非生产入口（禁止指向生产 `cloud-auth.tomzlab.cn`） |
| G2 | **测试账号 + 设备绑定 Cloud Session** | **已满足**（t23）：`127.0.0.1:8788` 实例 + 设备绑定会话 + `POST /v1/service-credentials` 现签（TTL 300s） | auth-dev |
| G3 | **真实空间行** | **已满足**：测试账号经 GLN-012 真实投递 `pending → delivered`（attempts=2），D1 里 `accountId == consumerId` 的空间行存在，`/mcp` 不再返回 `guanlan_principal_unavailable` | auth-dev |
| G4 | **已批准新闻源 / 真实内容** | **仍缺**：`poc_sources`/`poc_news` 只有 t10 用的 1 行合成 fixture；真实采集内容未验证 | 维护者批准源清单 + ingest 授权 |
| G5 | 真实模型 / 企业微信通道 | 不属于本卡与 GLN-014 范围 | lead 统一排期 |
| G6 | **错误 audience 负例** | **已解除**：用 `aud=mira:cloud-shiyan` 的 Shiyan 令牌打 Guanlan `/mcp` → **401 `invalid_token`**（非 503），见 t10 验收记录 §5.2。注意签发侧 audience 常量是 `mira:cloud-shiyan`，`mira:shiyan` 会 400 | — |

## 8. 与 t10（GLN-014 L3 验收）的接口

1. 把 `…/internal/guanlan-registrations` 交给 auth-dev 配置为 Cloud Auth 的 `MIRA_GUANLAN_REGISTRATION_URL`（必须 https）。
2. G1 解除后，用真实的 `CLOUD_AUTH_ISSUER` / `CLOUD_AUTH_JWKS_URL` 重新 `wrangler deploy`（只需改变量，不必重建 D1）。
3. 用真实令牌 `POST /mcp`（`initialize` → 只读工具），沿 GLN-014 验收矩阵的 N/P 用例逐项取证；此时 `guanlan_principal_unavailable` 应不再出现（G3 已满足）。
4. 全程禁止指向生产 Cloud Auth 或生产 D1/Worker。
