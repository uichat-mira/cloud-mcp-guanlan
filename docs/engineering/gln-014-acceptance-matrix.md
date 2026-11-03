# GLN-014 · 验收矩阵、令牌骨架与部署前提清单

> 任务：`[GLN-014 准备] 负例矩阵、令牌获取骨架与部署前提清单`（t14）。
> 分支 `feat/gln-014-real-token-mcp`，基线 `origin/dev` = `fbaecaa`；在先前的
> [契约盘点](gln-014-contract-recon.md)（PR #27）之上追加。
>
> **本卡边界**：只做**离线可完成**的准备——验收矩阵、只读令牌骨架、部署前提清单、缺口建议。
> 不联网执行、不部署、不改 `src/**`、不加管理 UI、不实现 GLN-014 主体。
> 本文件里的「可离线」用例是**可执行计划**，不是已经跑过的真实链路证据。

## 0. 维护者裁决（2026-11-04，经 lead 转达）与本卡对齐

| # | 裁决 | 对验收的影响 |
| --- | --- | --- |
| ① | `consumer_id` = **当前 Cloud Account id**（方案 A），由 Cloud Auth 从已验证、设备绑定的 Cloud Session 派生，不接受客户端自报；观澜 provisioning 负责建 `(account_id, account_id)` consumer 行 | 令牌里 `sub == consumer_id`；观澜**必须**有该行，否则一律 `guanlan_principal_unavailable`。见 §6 缺陷 G1 |
| ② | 空间闸门是**前置**：Cloud Auth 读 GLN-012 outbox，`delivered` 才签发；PR #130 未合并且 outbox 表不在 `dev` | GLN-014 **硬阻塞**：没有 delivered 注册就不该有令牌，有令牌也必须读不到数据 |
| ③ | 撤销 = **短 TTL（≤300s）+ 签发时复核**，不引入 `jti`/吊销表 | 验收只能证明「停止续签 + ≤TTL 内失效」，**禁止**写成「即时可撤销」 |
| ④ | `scope` 受约束数组：至少 `guanlan.read`，写需 `guanlan.write`，服务端限定只作用于本人账本 | 负例 N04 必须证明只读凭证无法写本人以外/任何账本 |
| ⑤ | `aud` 精确 `mira:cloud-guanlan`；`consumer_id` 为固定 claim 名；`device_id` 保留且观澜忽略 | 与 `src/mcp/config.ts:24,105-106`、`src/mcp/auth.ts:81-86` 一致（已验证） |

## 1. 证据层定义

| 层 | 含义 | 可执行位置 | 是否可离线 |
| --- | --- | --- | --- |
| **L1** | 纯契约：真实 `src/mcp/auth.ts` / `config.ts` 打包后跑，配本地 Ed25519/JWKS；无 D1、无网络 | `node scripts/gln-014-contract-probe.mjs`（已 18/18 通过） | ✅ 离线 |
| **L2** | 离线隔离：Miniflare/workerd + 真实 D1 + 官方 `@modelcontextprotocol/client` | `npm run test:integration`（`tests/*-workerd.test.mjs`） | ✅ 离线 |
| **L3** | 真实链路：真实 Cloud Auth 令牌 + 真实 `/mcp` 部署 + 真实隔离 D1 + 真实账号 | 需 §6 前提全部满足 | ❌ 需真实环境 |

**判定分层原则**：L1/L2 只能证明「资源侧合同正确」，**不能**证明「真实 Cloud Auth 签发可用」。
Issue #26 的验收要求 L3；L1/L2 只用于在等令牌期间把资源侧风险清零。

## 2. 负例矩阵（对应 Issue #26 验收项 2/3）

判定列写的是**可机械判定的结果**，不接受「看起来被拒绝」。`L2` 行同时给出既有测试位置（`未覆盖` 表示需要在 GLN-014 补）。

| ID | 场景 | 输入 | 判定（精确） | 层 | 既有覆盖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| N01 | 错误 audience（Shiyan） | `aud=mira:cloud-shiyan` | `/mcp` → `401` + `WWW-Authenticate: Bearer resource_metadata=...`，无工具结果 | L1/L3 | L1 probe（已实测）；`tests/mcp-workerd.test.mjs:257` | 可离线(L1)；L3 待令牌 |
| N02 | 错误 audience（Relay） | `aud=mira:cloud-relay-transport` | 同 N01 | L1/L3 | L1 probe；`mcp-workerd:258` | 同上 |
| N03 | 合法令牌但缺读 scope | `scope=[]` 或 `["news.write"]` | `403 insufficient_scope`；`tools/list` 与 `tools/call` 均无结果 | L2/L3 | `mcp-workerd:261`、`mcp-auth.test.mjs:116` | 可离线(L2) |
| N04 | 仅读凭证调用写工具 | `scope=["guanlan.read"]` → `guanlan_news_decide` | 工具 `isError:true`、文本含 `guanlan_decision_forbidden`；**且** `guanlan_consumer_news_states` 行数不变（0 行） | L2/L3 | `tests/decision-workerd.test.mjs:168-194`（含零写入断言） | 可离线(L2) |
| N05 | 过期令牌 | `exp = now-60` | `401 invalid_token` | L1/L3 | L1 probe；`mcp-workerd:259` | 可离线(L1) |
| N06 | 伪造签名 | claims 完美，签名 key 不在 JWKS | `401 invalid_token`（不区分「key 未知」与「claims 错」） | L1/L3 | L1 probe（已实测） | 可离线(L1) |
| N07 | 撤销令牌 | 已禁用账号 / 已撤销设备会话的旧令牌 | **按裁决③**：观澜侧不查撤销，只能判「`exp` 前仍有效」；可判定部分是**签发端**对禁用/撤销会话返回拒绝 | L3 | 无 | **不可判定为 pass**；只能判「停止续签 + ≤300s 失效」，需 t8 的 Cloud Auth 证据 |
| N08 | 跨账户读取 | A1 令牌 + B 的 `sourceId`；A1 令牌列页 | 读页**不含** B 的任何 item；指定 B 的 `sourceId` → 空页；A1 账本行不变 | L2/L3 | `tests/decision-workerd.test.mjs:329-361`、`news-workerd`（A/B 账户） | 可离线(L2) |
| N09 | 同账户跨消费者 | A1 令牌 vs A2 的决策 | A1 看不到 A2 的 `stateVersion`/状态；A2 行不变 | L2/L3 | `decision-workerd:329-361`（consumer-1/consumer-2） | 可离线(L2) |
| N10 | 无空间（合法令牌，无 `guanlan_accounts/consumers` 行） | 已签名令牌，D1 无该主体 | 读 = `guanlan_principal_unavailable`；写 = 同一错误；**不得**降级成空页或成功 | L2/L3 | `news-workerd:408`、`decision-workerd:558` | 可离线(L2) |
| N11 | 禁用账户 | 账号被 Cloud Auth 禁用 | ① 禁用后**不得**获得新令牌；② 已发令牌在 `exp` 前仍可用（裁决③）；③ 观澜没有 `disabled` 列，删空间行属于数据清理而非「禁用」 | L3 | 无 | **部分不可判定**：②必须作为已知残留写进验收报告 |
| N12 | 令牌把 `sub=A`、`consumer_id=B`（跨账户消费者） | 错误签发 | 观澜按 `(account_id, consumer_id)` 复合查询找不到行 → `guanlan_principal_unavailable`；**不得**读出 B 的数据 | L2/L3 | 结构性覆盖（复合外键 `migrations/0003:45-47`，`subscriptions.ts:333-340`） | 可离线(L2) |
| N13 | 空/畸形 `sub` | `sub=""` | `401 invalid_token` | L1 | L1 probe；`mcp-auth.test.mjs:305` | 可离线(L1) |
| N14 | 空 `consumer_id` | `consumer_id=""` | `401 invalid_token` | L1 | L1 probe；`mcp-auth.test.mjs:306` | 可离线(L1) |
| N15 | 畸形 scope 数组 | `scope=[123]` | `401 invalid_token`（整体拒绝，不丢弃坏项） | L1 | L1 probe；`mcp-auth.test.mjs:307` | 可离线(L1) |
| N16 | 非规范 Host / Origin | `host: evil.example.com` 或跨域 `origin` | 请求在鉴权前被拒（无工具结果、无数据） | L1/L2 | `mcp-auth.test.mjs:124-133` | 可离线(L1) |
| N17 | 未配置信任 | 缺 `MCP_RESOURCE_URL`/`CLOUD_AUTH_*`/`MCP_AUDIENCE` | `/mcp` 与 metadata 均 `503 mcp_not_configured`，且**不构造** handler | L2/L3 | `mcp-workerd.test.mjs:361-378` | 可离线(L2) |
| N18 | 游标跨身份/被篡改 | 他主体或改过的 `cursor` | `guanlan_news_cursor_invalid`（不返回任何页） | L2/L3 | `news-workerd.test.mjs:353-402` | 可离线(L2) |
| N19 | 未知文章 vs 无权来源 | 不存在 URL / 未订阅来源 | **同一个**不透明 `guanlan_decision_not_available`，文本不可区分 | L2/L3 | `decision-workerd:379-398` | 可离线(L2) |
| N20 | 陈旧 `expectedVersion` | 读 v1 后用 `expectedVersion=0` | `guanlan_decision_version_conflict` + 文本附当前状态 JSON；DB 版本不变 | L2/L3 | `decision-workerd:207-264` | 可离线(L2) |
| N21 | 同 `operationId` 不同内容 | 复用 id 改 status | `guanlan_decision_operation_conflict`；不静默改写 | L2/L3 | `decision-workerd:266-276` | 可离线(L2) |
| N22 | D1 故障 | 存储层失败 | 读 `guanlan_news_unavailable` / 写 `guanlan_decision_unavailable`；**不得**是 conflict/forbidden/not_available | L2/L3 | `decision-workerd:513-528`、`mcp-workerd:299` | 可离线(L2) |
| N23 | 超大请求体 | `> 256 KiB` | 请求被拒（不进入工具） | L2/L3 | **未覆盖** | 需在 GLN-014 补测（`server.ts:51`） |
| N24 | 匿名访问 | 无 `Authorization` | `/mcp` → `401` 且带 `resource_metadata`；metadata `200`，`scopes_supported` 仅含 `guanlan.read`；**不可** `tools/list` | L2/L3 | `mcp-workerd:227-253` | 可离线(L2) |
| N25 | 错误 `kid` / JWKS 不含该 key | 合法 claims、未知 `kid` | `401 invalid_token`（不抓取、不回退到 fixture） | L1/L3 | L1 probe（未知 key 已实测） | 可离线(L1) |

## 3. 正例与持久化矩阵（对应 Issue #26 验收项 1/3）

| ID | 场景 | 判定（精确） | 层 | 既有覆盖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P01 | 读 → 决策 → 重读 | 读页 `stateVersion=0` → decide `result:"updated"`、`version:1` → 重读该 URL 得 `status=adopted`、`version=1`；JSON 与 Markdown 同源 | L2/L3 | `decision-workerd:207-264` | 可离线(L2) |
| P02 | 幂等重放 | 同 `operationId`+同内容 → `result:"replayed"`，`version` 不涨、`decidedAt` 不变 | L2/L3 | `decision-workerd`（replay 段） | 可离线(L2) |
| P03 | 并发同版本 | 两个客户端同 `expectedVersion` → 恰好一个成功，另一个 `version_conflict` | L2/L3 | `decision-workerd:438-457` | 可离线(L2) |
| P04 | 重启后持久 | 换 Miniflare 实例后状态、版本不变，同 `operationId` 仍为 `replayed` | L2/L3 | `decision-workerd:472-499` | 可离线(L2) |
| P05 | 真实令牌走完整链路 | 真实 Cloud Auth 令牌 → 真实 `/mcp` → read/decide/re-read；`whoami` 的 `accountId/consumerId` 与令牌一致且 `consumerId == accountId`（裁决①） | L3 | 无 | **阻塞**（§6） |
| P06 | 真实 JWKS 取回与 `kid` 轮换 | 真实 JWKS 一次取回后可验证；`kid` overlap 期间新旧令牌都能过 | L3 | 无 | **完全未覆盖**，需真实环境观测 |
| P07 | 跨设备同一消费者 | 两个独立客户端/设备用同一消费者令牌 → 看到同一 `stateVersion` 与进度 | L3 | 无 | **阻塞**（需两端或两客户端 + 真实令牌） |
| P08 | 真实注册 → 空间行 → 可读 | GLN-012 outbox `delivered` 后，观澜存在 `(account_id, account_id)` 行，读不再 `principal_unavailable` | L3 | 无 | **阻塞**（G1/G2） |

## 4. 判定规则（防止「假通过」）

1. **状态码/工具错误码必须精确匹配**（`401` vs `403` vs `200`；`guanlan_decision_forbidden` vs `not_available` vs `unavailable`），不接受「返回了错误」。
2. **负例必须附带数据不变量**：涉及写路径的负例要断言 `guanlan_consumer_news_states` 的行数与版本不变；只读调用要断言 `poc_sources`/`poc_news`/租约未被写（`mcp-workerd:275-297`）。
3. **不泄漏检查**：错误文本不得包含他账户/消费者的标识、指纹、原始 token；未知与无权必须不可区分（N19）。
4. **禁止的「通过」方式**：fixture 令牌冒充真实签发；L1/L2 代替 L3；CI 绿灯代替产品验收；「签名有效」代替「可撤销」；用 seed 数据冒充 GLN-012 注册能力（seed 必须在报告里标注为 test-only）。
5. **每条 L3 结果必须记录**：被测 Git SHA、Worker 部署标识、D1 迁移版本（4 个 migration 均已应用）、令牌 `aud/scope/exp/TTL`（`token` 只写 sha256 前 12 位）、真实时间戳。

## 5. 令牌获取骨架（只读，默认不联网）

脚本：`scripts/gln-014-token-fetch.mjs`（本卡新增；**不改 `src/**`、不写 `.env`、不硬编码任何密钥**）。

| 模式 | 是否联网 | 作用 | 已执行结果（本机） |
| --- | --- | --- | --- |
| `plan`（默认） | ❌ | 打印所需入参、实际签发端点、请求体、期望 claims；缺项即 fail-closed | 缺 env → exit `2` 并逐条列出缺失；补齐（用占位值）→ exit `0`，端点推导正确 |
| `verify` | ❌ | 用**真实** `src/mcp/auth.ts` 验证器 + 本地 JWKS 文件离线验证令牌 | 缺入参 → exit `2` |
| `self-test` | ❌ | 生成临时 Ed25519 密钥、签一个合同令牌并验证；再验证「缺 `consumer_id` 必拒」 | **PASS / PASS**，exit `0` |
| `fetch` | ✅（唯一） | `POST /v1/service-credentials`，`{audience}` + Cloud Session bearer | **已拒绝**：无 `--allow-network` 且无 `GLN014_ALLOW_NETWORK=yes` → exit `4` |

入参（全部来自环境，不落盘）：

| 变量 | 必需 | 含义 |
| --- | --- | --- |
| `MIRA_CLOUD_AUTH_BASE_URL` | `plan`/`fetch` | Cloud Auth 基址（https，localhost http 例外）；端点由 `/v1/service-credentials` 推导 |
| `MIRA_CLOUD_SESSION_TOKEN` | `plan`/`fetch` | 设备绑定的 Cloud Session bearer；**永不打印**（只打印 sha256 前 12 位） |
| `GLN014_TOKEN` 或 `--token-file` | `verify` | 待验证令牌 |
| `--jwks-file` / `GLN014_JWKS_FILE` | `verify` | 本地 JWKS JSON（离线；不联网抓） |
| `MIRA_GUANLAN_AUDIENCE` | 可选 | 默认 `mira:cloud-guanlan`；**任何其他值直接拒绝**（exit 2） |
| `CLOUD_AUTH_JWKS_URL` / `MCP_RESOURCE_URL` | 可选 | 仅用于 `plan` 打印期望值 |

骨架已实现的守卫：非 https 拒绝；非观澜 audience 拒绝；缺 session/令牌拒绝；未知 `kid`/无 `consumer_id` 由真实验证器拒绝；
`verify` 额外把「`consumer_id != accountId`」与「TTL > 300s」判为合同告警（exit 3），与裁决①③对齐。
`fetch` 只读取 Cloud Auth 文档化的公开字段（`audience`、`expiresAt`），不透传 body。

## 6. 部署前提清单（给维护者一次配齐）

现状（已验证）：

| 事实 | 证据 |
| --- | --- |
| 仓库默认配置**明确不可部署**：Worker 名 `cloud-guanlan-poc-do-not-deploy`、`workers_dev:false`、D1 `database_id` 全 0 | `wrangler.jsonc:3-15` |
| 只暴露 `/health`、`/mcp`、`/.well-known/oauth-protected-resource/mcp`、`404`；无管理/REST 面 | `src/app.ts:21-38` |
| 真实 D1 里**没有** `guanlan_*` 表：GLN-003 Canary 只应用过 `0001`/`0002` | `docs/engineering/gln-003-cloudflare-canary.md:4,20,127` |
| Cloud Auth 只有生产 `cloud-auth.tomzlab.cn`；`test` 是手动 workflow（与生产共用 8788），无 `dev` | `cloud-auth/docs/deployment.md` §1/§2.3 |
| GLN-012 的 outbox 表只存在于 PR #130（未合入 `dev`），且其接收端**未实现** | `cloud-auth` PR #130 文件 `apps/api/migrations/008_guanlan_registration_outbox.sql`；PR 正文 Boundary |

### 前提项（按执行顺序；每项给出完成判据）

| ID | 前提 | 操作（示例，均需授权） | 完成判据 | 不满足则不能宣称 |
| --- | --- | --- | --- | --- |
| PR-1 | 隔离 D1 | `npx wrangler d1 create cloud-guanlan-gln014-<env>`，记录**新建** UUID（UUID 不入仓库文本） | `wrangler d1 list` 可见且归属隔离环境 | 任何真实 D1 结论 |
| PR-2 | 4 个迁移已应用 | `wrangler d1 migrations apply <db> --remote`（`0001`→`0004`） | 4 个 migration 均 `applied`；表存在：`poc_sources`、`poc_news`、`guanlan_accounts`、`guanlan_consumers`、`guanlan_account_subscriptions`、`guanlan_consumer_subscriptions`、`guanlan_consumer_news_states` | 「真实账本/隔离」验收 |
| PR-3 | 隔离部署配置 | 生成式配置（参考 `scripts/gln003-config.mjs` 的做法），**Cron 关闭**、`workers_dev` 开启、单一 D1 binding；不提交真实 UUID/账号 ID | `wrangler deploy --dry-run` 绑定正确、`crons: []` | 「部署」结论 |
| PR-4 | 4 个运行时绑定 | `MCP_RESOURCE_URL`（https，路径必须 `/mcp`）、`CLOUD_AUTH_ISSUER`、`CLOUD_AUTH_JWKS_URL`、`MCP_AUDIENCE=mira:cloud-guanlan` | `/mcp` 不再 `503`；匿名请求得 `401` + `resource_metadata` | 任何 `/mcp` 验收 |
| PR-5 | 部署并冒烟 | 授权后 `wrangler deploy --config <generated>` | `GET /health` → `200 {publicApi:false}`；匿名 `POST /mcp` → `401`；metadata → `200` 且 `scopes_supported` 含 `guanlan.read` | 「有真实端点」 |
| PR-6 | Worker 出网可达 Cloud Auth JWKS | 用一份**真实**令牌触发一次 `/mcp` 调用 | 该调用达到「令牌通过/被拒」分支而不是 JWKS 网络错误（日志可区分） | 「真实验证器可用」 |
| PR-7 | Cloud Auth 隔离环境 | 维护者开 test 窗口或本地 compose 实例（不得用生产做 GLN-014 验收） | 基线 `POST /v1/service-credentials` 可达、`GET /.well-known/jwks.json` 返回 Ed25519 公钥 | 任何真实签发 |
| PR-8 | 隔离测试账号 | 在 PR-7 环境创建 1 个账号（假名 A1） | 能登录并取得**设备绑定** Cloud Session | 令牌获取 |
| PR-9 | 观澜空间行（**当前无供应者**，见 G1） | 优先：Guanlan 侧注册接收实现（独立工作项）；GLN-014 过渡期：**test-only** `wrangler d1 execute` 插入 `guanlan_accounts(account_id)` 与 `guanlan_consumers(account_id, account_id)` | 两行存在且 `consumer_id == account_id` | 任何读取/写入（否则必然 `guanlan_principal_unavailable`） |
| PR-10 | 来源与新闻数据 | 至少 1 个 `poc_sources` 行（建议用 `src/source-allowlist.ts:38-54` 已批准的 3 个 URL）+ 该主体的订阅行（`guanlan_account_subscriptions` 或 `guanlan_consumer_subscriptions`）+ 若干 `poc_news` 行 | 读页非空；空订阅时读页为空（这是合法结果，不能当失败） | 读/决策的正例 |
| PR-11 | GLN-013 签发实现 | `cloud-auth` 增加 `mira:cloud-guanlan`、`guanlan.read`/`guanlan.write`、`consumer_id`（=account id）、TTL ≤300s、签发时复核空间 delivered | 用骨架 `plan`→`fetch`→`verify` 三段全部通过 | 任何「真实令牌」结论 |
| PR-12 | 证据脱敏与记录 | 证据只写：`aud`、`scope[]`、`exp`、TTL、token sha256 前 12 位、HTTP 状态、工具错误码、D1 行数/版本、被测 SHA | 报告里不含 token/session/原始账号 ID/消息内容 | 「证据合规」 |

### 6.1 空间供应者缺口（G1，待 lead 裁决归属）

- **事实**：`src/**` 里 `guanlan_accounts` / `guanlan_consumers` **只有 SELECT/COUNT，没有任何 INSERT/upsert**（`src/subscriptions.ts:333-340`、`src/subscription-mutations.ts:275-374`）。
- **事实**：`src/app.ts:21-38` 没有注册接收路由；仓库里也没有 HMAC 校验或幂等注册代码。
- **结论**：裁决①要求「观澜 provisioning 负责建 `(account_id, account_id)` consumer 行」，但**观澜侧当前没有任何供应者**。
  按 `cloud-auth` PR #130 的接收契约（`x-mira-timestamp` + `x-mira-signature: sha256=HMAC(secret, timestamp + "." + body)`，POST `{"version":1,"accountId":...}`，幂等 + 账户匹配收据），观澜需要新增一个**独立工作项**：注册接收路由 + HMAC 校验 + 时间窗 + 幂等 upsert（`guanlan_accounts` + `guanlan_consumers(aid, aid)`）。
- **谁建、何时建**：由 Guanlan 仓库新建工作项（建议紧随 GLN-012 合入）；GLN-014 之前不实现，只用 PR-9 的 test-only seed 打通链路，并在报告中标注「seed ≠ A2 能力」。

## 7. 订阅变更工具缺口（G2，交 lead，本卡不实现）

确认结果：**只有领域 port，没有 MCP 工具面，也没有 HTTP 面**。

| 证据 | 结论 |
| --- | --- |
| `docs/engineering/gln-011-subscription-mutations.md:4` | 明确「未开放 HTTP/MCP 管理接口、未改 MCP Server」 |
| `docs/engineering/gln-011-subscription-mutations.md:110` | 把「订阅变更写工具」列为未做项 |
| `src/mcp/server.ts:136-246` | 只注册 3 个工具，无订阅工具 |
| `src/app.ts:36-38` | 明确无公共 REST 新闻/配置接口 |
| `docs/product-design.md:157` | 订阅修改是**用户管理操作**，Agent 只能提议（C1 才做批准流） |

**建议（交 lead 裁决，不在 GLN-014 实现）**：
新增独立工作项「观澜订阅变更的授权面与用户批准契约」——需要同时解决三件事：(a) 管理授权凭证（GLN-011 §2 目前只有 test fixture policy）；(b) 用户批准/提议流转（产品设计 C1）；(c) MCP 工具或管理 API 的唯一领域合同复用。
GLN-014 的验收**不覆盖**该能力，也不得因为「读/写新闻账本通过」被误读为「订阅可改」。

## 8. 复现命令（本机已执行的部分）

```bash
npm ci --no-audit --no-fund
npm run typecheck

# 契约探针（18/18）
node scripts/gln-014-contract-probe.mjs

# 令牌骨架：全部离线
node scripts/gln-014-token-fetch.mjs self-test     # PASS/PASS, exit 0
node scripts/gln-014-token-fetch.mjs plan          # 缺 env → exit 2（fail-closed）
node scripts/gln-014-token-fetch.mjs verify        # 缺入参 → exit 2
node scripts/gln-014-token-fetch.mjs fetch         # 未授权联网 → exit 4

# 需要真实环境的步骤（本机未执行、本机不可执行）
#   MIRA_CLOUD_AUTH_BASE_URL=... MIRA_CLOUD_SESSION_TOKEN=... \
#   GLN014_ALLOW_NETWORK=yes node scripts/gln-014-token-fetch.mjs fetch --allow-network
```

`bash scripts/check.sh` 仍未在本机执行（无 Git Bash；WSL 入口挂起），Ubuntu CI 为权威门禁。

## 9. 与既有文档的关系

- [gln-014-contract-recon.md](gln-014-contract-recon.md)：资源侧契约事实与 GLN-013 令牌合同草案（本卡在其上追加，裁决①③⑤已对齐到该文 §5）。
- `docs/engineering/gln-003-cloudflare-canary.md`：真实部署/CPU 证据的唯一来源（并说明 Canary 只有 `0001`/`0002`）。
- `docs/engineering/gln-010-mcp-consumption-write.md`、`gln-011-subscription-mutations.md`：写工具与订阅领域合同。
- 本文件是**计划与前提清单**，不新增任何「已通过」的真实链路结论。
