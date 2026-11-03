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
| `CLOUD_AUTH_ISSUER` | 初建时为占位 `https://cloud-auth.invalid/`；**t10 起改为可用的 HTTPS URL**，当前为 **`https://mira-auth-jwks-test.pages.dev`**（测试期元数据占位，见 §7 G1）。注意：它必须是 URL，不能填 `mira:cloud-auth`（那是 JWT 的 `iss` 常量，填进变量会让 `/mcp` 503） |
| `CLOUD_AUTH_JWKS_URL` | 初建时为占位 `https://cloud-auth.invalid/.well-known/jwks.json`；当前为 **`https://mira-auth-jwks-test.pages.dev/.well-known/jwks.json`**（静态公钥，见 §7 G1 与 t10 验收记录 §13） |
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
| S2 | `GET /.well-known/oauth-protected-resource/mcp` | 200 | `200`，`resource`=本 Worker `/mcp`，`scopes_supported:["guanlan.read"]`，`bearer_methods_supported:["header"]`；`authorization_servers` 在建库时是占位 `https://cloud-auth.invalid/`，当前为 `https://mira-auth-jwks-test.pages.dev`（同一字段结构） |
| S3 | `POST /mcp` 匿名 | 401 + `WWW-Authenticate` | `401`，`Bearer error="invalid_token", error_description="Missing Authorization header", scope="guanlan.read", resource_metadata="…/.well-known/oauth-protected-resource/mcp"` |
| S4 | `POST /mcp` 垃圾 bearer | 401 | `401 {"error":"invalid_token","error_description":"invalid_token"}`（建库时 JWKS 为占位域名，fail closed；换成真实 JWKS 后该用例仍 401，见 t10 验收记录 N2） |
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

> **前置（重要，F-30-6 已更新）**：`migrations/0005_guanlan_registration_receipts.sql` 与 `src/registration.ts` **已随 PR #29 合入 `dev`**
> （merge `aa1808c`，2026-11-03T17:59:13Z）。因此**直接以 `origin/dev` HEAD 为准**（本卡复核时为 `e3aefe0`）：
> ```powershell
> git -c http.proxy=http://127.0.0.1:1080 fetch origin dev
> git cat-file -e origin/dev:migrations/0005_guanlan_registration_receipts.sql   # 存在即满足前置
> git cat-file -e origin/dev:src/registration.ts
> ```
> 本节首次实测用的是当时未合并的分支 `feat/gln-015-registration-receiver`（`57c7b52`，现已落后 `dev` **10 个提交**）。
> **照抄时必须从 `dev` HEAD 构建**，否则会构建到旧代码（可能缺后续修复）。

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

# 1) 构建（worktree 处于 origin/dev HEAD；含 0005 与 registration.ts）
cd <cloud-mcp-guanlan worktree at origin/dev HEAD>; git switch --detach origin/dev; npm ci; npm run build

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
    "CLOUD_AUTH_ISSUER": "https://mira-auth-jwks-test.pages.dev",
    "CLOUD_AUTH_JWKS_URL": "https://mira-auth-jwks-test.pages.dev/.well-known/jwks.json",
    "MCP_AUDIENCE": "mira:cloud-guanlan"
  }
}
```

> `migrations_dir` 在 deploy 时会被 wrangler 标为未知顶级字段（仅迁移命令需要），可安全忽略。
>
> **JWKS 用现成值即可**（`https://mira-auth-jwks-test.pages.dev/.well-known/jwks.json`，仅公钥、`max-age=300`）。
> 不要照抄初建时的占位域名 `cloud-auth.invalid` —— 那样 `/mcp` 会因 JWKS 取不到而对**所有**真实令牌 401（fail closed），
> 这正是 F-30-7 指出的旧文档矛盾。该 JWKS 是**测试期措施**（见 §7 G1），不是产品形态。

## 6. 如何销毁

需要删除的资源共 **3 个**：**Worker** `cloud-guanlan-gln014-3c872be6`（连同 secret 绑定）、**D1** `cloud-guanlan-gln014-3c872be6`、
**静态 JWKS**（Cloudflare Pages 项目 `mira-auth-jwks-test`）。
> 命名说明（F-30-9）：为验证「Worker 能否承载 JWKS」曾临时建过**同名**诊断 Worker `mira-auth-jwks-test`（平台返回 `error code: 1042`，
> 结论与证据已固化在 t10 验收记录 §13）。该 Worker **已于 2026-11-04 删除**，因此不存在与 Pages 项目同名的资源歧义；
> 销毁清单里也不再包含它。
下面整段自包含，可直接复制执行：

```powershell
# 0) 注入凭证（值不打印），并定位仓库外配置
$raw = [IO.File]::ReadAllText("$env:USERPROFILE\.mira-secrets\cloudflare.env")
$env:CLOUDFLARE_API_TOKEN  = [regex]::Match($raw,'(?m)^\s*CLOUDFLARE_API_TOKEN\s*=(.*)$').Groups[1].Value.Trim()
$env:CLOUDFLARE_ACCOUNT_ID = [regex]::Match($raw,'(?m)^\s*CLOUDFLARE_ACCOUNT_ID\s*=(.*)$').Groups[1].Value.Trim()
$tmp  = "$env:LOCALAPPDATA\Temp\gln014-env"
$name = if (Test-Path "$tmp\env-name.txt") { (Get-Content "$tmp\env-name.txt" -Raw).Trim() } else { "cloud-guanlan-gln014-3c872be6" }

cd <含 wrangler 的 cloud-mcp-guanlan worktree>
# 1) 删 Guanlan Worker（wrangler 4.156 的 delete 只有 --force / --dry-run，**没有 --yes**）
.\node_modules\.bin\wrangler.cmd delete --config "$tmp\wrangler.jsonc" --force
# 2) 删 D1（不可恢复；此子命令用 --skip-confirmation）
.\node_modules\.bin\wrangler.cmd d1 delete $name --skip-confirmation
# 3) 删静态 JWKS（Pages 项目用 --yes；公钥文件随项目一起消失）
.\node_modules\.bin\wrangler.cmd pages project delete mira-auth-jwks-test --yes
# 4) 清理仓库外临时配置与产物（内含 D1 UUID、静态 JWKS 副本）
Remove-Item -Recurse -Force $tmp
```

> 三个子命令的确认参数**各不相同**，照抄时最容易在这里失败（F-30-5）：`delete` → `--force`；`d1 delete` → `--skip-confirmation`；`pages project delete` → `--yes`。

- 删除 D1 会一并丢弃所有空间行与收据，不可恢复；销毁前确认已无验证依赖（**t9 未跑完前不要销毁**）。
- 账号下另有 `cloud-guanlan-gln003-canary`、`mira-shiyan` 两个库与既有 Worker，**都不属于本环境**，销毁时不要对它们执行任何删除命令。
- 若只销毁 JWKS（密钥轮换或不再需要稳定性措施）：先删 Pages 项目，**再**把 Guanlan Worker 的 `CLOUD_AUTH_JWKS_URL` 改回可用地址，否则 `/mcp` 会因 JWKS 取不到而全 401。

### 6.1 「未改变既有资源」的可判定口径与快照（F-30-2 / F-30-10）

本卡执行过的**变更类**命令只有：`d1 create`（新库）、`d1 migrations apply`（仅对新库）、`secret put`（仅对新 Worker）、`deploy`（仅对新 Worker）、一次 `d1 execute` 写入 t10 用的合成 fixture 行，以及 2026-11-04 为静态 JWKS 新建的**新资源**（`pages project create mira-auth-jwks-test` + `pages deploy`，和当时用于验证 1042 的诊断 Worker `mira-auth-jwks-test`；后者已于 2026-11-04 删除）。

**可判定口径**（替代模糊的「未碰生产」）：本卡不存在任何以既有资源名为目标的写命令。可用两条机械判据复核：

1. **命令侧**：所有变更命令都显式带 `--config "$tmp\…jsonc"`（目标名只能是 `cloud-guanlan-gln014-<suffix>`）或显式新资源名（`mira-auth-jwks-test`）。对既有资源执行过的命令**只有只读列举**：`wrangler d1 list`、`wrangler deployments list`、Workers API 的 `GET /accounts/<acct>/workers/scripts`、`GET …/settings`。
2. **资源侧**：下表快照中，既有库/Worker 的 `created_at` 均早于本卡执行时间（2026-11-04），而本卡新建的两个库/Worker 的 `created_at` 落在本卡时间窗内 —— 若曾对既有资源做过 rename/delete，它们的 `created_at`/存在性会变化。

**采集方式与脱敏（F-30-10）**：
- 原始命令：`wrangler d1 list --json`（字段 `name`/`uuid`/`created_at`/`num_tables`）与 Workers API `GET /accounts/<acct>/workers/scripts`（字段 `id`/`created_on`）。
- 脱敏规则：Cloudflare account id → `<已脱敏>`；D1/Worker 的 uuid 一律不入库（只保留本卡自建对象的库名与 `created_at`，因为它们已是公开可见的资源名）；不含令牌、密钥、用户标识。
- 可复核性：上述两条命令为只读，维护者可在同一账号重跑并比对 `created_at` 与资源名集合。

| D1 库 | `created_at`（UTC） | 归属 |
| --- | --- | --- |
| `cloud-guanlan-gln014-3c872be6` | 2026-11-03T17:22:57Z | 本卡创建 |
| `cloud-guanlan-gln003-canary` | 2026-10-31T17:18:26Z | 既有，未改 |
| `mira-shiyan` | 2026-08-31T01:23:39Z | 既有，未改 |

Worker 脚本共 14 个：13 个既有脚本的 `modified_on` 全部 ≤ `2026-11-03T14:49:04Z`（早于本卡首次 deploy），第 14 个是本卡创建的同名 Worker，`modified_on = 2026-11-03T17:54:03Z`。
（2026-11-04 曾临时部署同名诊断 Worker 验证 Worker→Worker 子请求，`error code: 1042` 证据采集后已删除；因此当前脚本数仍为 **14**。）

## 7. 缺口状态（2026-11-04 更新）

| # | 缺口 | 当前状态 | 解除方 |
| --- | --- | --- | --- |
| G1 | **非生产 Cloud Auth 的 JWKS 可达性** | **已稳定（测试期措施）**：2026-11-04 起 JWKS 以**公钥静态发布**在 Cloudflare Pages（`https://mira-auth-jwks-test.pages.dev/.well-known/jwks.json`，`max-age=300`），Worker 不再依赖隧道；真实令牌已被接受（t10 验收记录 §13）。**⚠️ 这是隔离测试环境的稳定性措施，不是产品形态**：生产必须使用常驻 Cloud Auth 的真实 JWKS；公钥静态发布 ≠ 密钥托管（私钥仍在 auth-dev 本机），密钥轮换后必须重新发布，否则 `/mcp` 全 401（fail closed） | — |
| G2 | **测试账号 + 设备绑定 Cloud Session** | **已满足**（t23）：`127.0.0.1:8788` 实例 + 设备绑定会话 + `POST /v1/service-credentials` 现签（TTL 300s） | auth-dev |
| G3 | **真实空间行** | **已满足**：测试账号经 GLN-012 真实投递 `pending → delivered`（attempts=2），D1 里 `accountId == consumerId` 的空间行存在，`/mcp` 不再返回 `guanlan_principal_unavailable` | auth-dev |
| G4 | **已批准新闻源 / 真实内容** | **仍缺**：`poc_sources`/`poc_news` 只有 t10 用的 1 行合成 fixture；真实采集内容未验证 | 维护者批准源清单 + ingest 授权 |
| G5 | 真实模型 / 企业微信通道 | 不属于本卡与 GLN-014 范围 | lead 统一排期 |
| G6 | **错误 audience 负例** | **已解除**：用 `aud=mira:cloud-shiyan` 的 Shiyan 令牌打 Guanlan `/mcp` → **401 `invalid_token`**（非 503），见 t10 验收记录 §5.2。注意签发侧 audience 常量是 `mira:cloud-shiyan`，`mira:shiyan` 会 400 | — |

## 8. 与 t10（GLN-014 L3 验收）的接口

1. 把 `…/internal/guanlan-registrations` 交给 auth-dev 配置为 Cloud Auth 的 `MIRA_GUANLAN_REGISTRATION_URL`（必须 https）。
2. G1 已按测试期方式满足（静态 JWKS，见 §7）；**生产化时**需把 `CLOUD_AUTH_ISSUER` / `CLOUD_AUTH_JWKS_URL` 换成真实授权服务器的地址后重新 `wrangler deploy`（只需改变量，不必重建 D1）。
3. 用真实令牌 `POST /mcp`（`initialize` → 只读工具），沿 GLN-014 验收矩阵的 N/P 用例逐项取证；此时 `guanlan_principal_unavailable` 应不再出现（G3 已满足）。
4. 全程禁止指向生产 Cloud Auth 或生产 D1/Worker。
