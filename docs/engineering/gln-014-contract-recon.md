# GLN-014 · Guanlan 资源服务契约盘点与 GLN-013 签发合同草案

> 任务契约：[Issue #26](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/26)（GLN-014）。
> 分支：`feat/gln-014-real-token-mcp`，基线 `origin/dev` = `fbaecaa`（GLN-010 已入 dev）。
> **本文是盘点和前置草案，不是 GLN-014 的交付**：不修改生产逻辑、不加管理 UI、不开放第三方 OAuth、
> 不部署、不宣称任何真实 Cloud Auth 令牌或真实端点已经联调。第 6 节逐条记录当前真实缺口。

- Organization 政策：`uichat-mira/.github` `main` `AGENTS.md`，**Policy revision `2026-09-16.2` / Constitution `v1.1`**（本次实际取回，非记忆）。
- 仓库规则：`AGENTS.md`（cloud-mcp-guanlan，`dev`）。
- 事实优先级：当前代码 > Issue 契约 > 文档；每行都标注**已验证**（本机执行或代码位置）或**未验证**（缺真实环境）。

## 0. 本次可执行的证据

| 项目 | 结果 |
| --- | --- |
| `node -v` / `npm -v` | `v24.9.0` / `11.6.0` |
| `npm ci --no-audit --no-fund` | 通过（`added 181 packages`） |
| `npm run typecheck` | 通过（`tsc --noEmit`，exit 0） |
| `node scripts/gln-014-contract-probe.mjs` | 通过，**18/18** 条契约期望成立（只读探针，见第 4 节） |
| `bash scripts/check.sh` | **未执行**：本机未安装 Git Bash（`C:\Program Files\Git\bin\bash.exe` 不存在）；`C:\Windows\System32\bash.exe` 是 WSL 入口，探测挂起，已终止。Ubuntu CI 仍是该门禁的权威执行环境（`scripts/check.sh:11-18`） |
| 真实 Cloud Auth 令牌 / 真实 `/mcp` 端点 | **未验证**，两者当前都不存在（第 6 节） |

## 1. 结论摘要

1. `/mcp` 的**资源服务侧合同已经完整**：双 issuer 分离、EdDSA-only JWKS、`MCP_AUDIENCE` 只接受观澜、
   `sub` + `consumer_id` 双主体、`guanlan.read` 全局 gate、`guanlan.write` 工具级独立授权、
   `stateVersion` CAS、错误不泄漏、Host/Origin 校验，全部有代码位置且被探针实测。
2. **Cloud Auth 当前签发合同与 Guanlan 验证器不兼容**，且有 3 处硬冲突：`aud` 枚举只有
   `mira:cloud-shiyan` / `mira:cloud-relay-transport`；`scope` 是字面量元组；claims 里**没有 `consumer_id`**。
   因此今天**不存在**任何 Cloud Auth 签出的令牌能通过 Guanlan 验证器（探针实测拒绝）。
3. **没有可用的真实端点**：Guanlan 仓库的 `wrangler.jsonc` 是 `cloud-guanlan-poc-do-not-deploy`、D1 UUID 全 0、
   `workers_dev:false`；GLN-003 Canary 真的部署过，但它只跑 `0001`/`0002`、只暴露 `/health`、Cron 已关闭。
   即：**没有跑 `/mcp` 的观澜实例，也没有已执行 `0003`/`0004` 的真实 D1**。
4. Cloud Auth 只有生产 `https://cloud-auth.tomzlab.cn`；`test` 不是常驻实例（手动 workflow、与生产共用 8788），
   **没有 dev 实例**。所以真实签发联调需要维护者给出隔离测试窗口或本地实例。
5. 真实链路的**顺序阻塞**：GLN-012（`cloud-auth` PR #130，open）不落地 → `guanlan_accounts/consumers` 无行 →
   即使令牌合法，读/写都会得到 `guanlan_principal_unavailable`。

## 2. 资源服务契约（逐项，带代码位置）

### 2.1 双 issuer（OAuth 发现 URL ≠ JWT `iss`）

| 断言 | 位置 | 状态 |
| --- | --- | --- |
| JWT `iss` 固定为部署中立的 `mira:cloud-auth`，不是按环境变化 | `src/mcp/config.ts:23`、`src/mcp/runtime.ts:66`（`issuer: config.tokenIssuer`） | 已验证（代码 + 探针） |
| `CLOUD_AUTH_ISSUER`（HTTPS OAuth AS URL）只用于 RFC 9728 discovery，**不参与** JWT `iss` 比较 | `src/mcp/config.ts:41-43`、`src/mcp/config.ts:82-83`、`src/mcp/config.ts:123-134`、`docs/engineering/gln-004-mcp.md` §3 | 已验证（代码） |
| 验证器用 `jwtVerify(..., { issuer: tokenIssuer })` 做精确匹配 | `src/mcp/auth.ts:68-75` | 已验证（探针拒绝 `iss=https://relay.example.com`） |

### 2.2 audience

| 断言 | 位置 | 状态 |
| --- | --- | --- |
| 服务 audience 常量 `mira:cloud-guanlan` | `src/mcp/config.ts:24` | 已验证（探针） |
| `MCP_AUDIENCE` 只接受 `mira:cloud-guanlan` 或**精确等于** `/mcp` 资源 URL 的两种值 | `src/mcp/config.ts:88-96` | 已验证（探针：`mira:cloud-shiyan`、`mira:cloud-relay-transport` 均返回 `mcp_audience_not_guanlan`；资源 URL 通过） |
| MCP 层 `expectedResource` 始终是真实 `/mcp` URL，与 JWT 用服务名 audience 解耦 | `src/mcp/server.ts:305-310` | 已验证（代码 + `tests/mcp-auth.test.mjs:265-297`） |

### 2.3 JWKS 获取与缓存

| 断言 | 位置 | 状态 |
| --- | --- | --- |
| 生产路径用 `jose` 的 `createRemoteJWKSet(new URL(CLOUD_AUTH_JWKS_URL))` 远程取公钥 | `src/mcp/auth.ts:63` | 已验证（代码） |
| JWKS 绑定缺失/非法 → `/mcp` 与 metadata 一起 `503 mcp_not_configured`，无匿名回退 | `src/mcp/config.ts:85-86`、`src/app.ts:25-34` | 已验证（探针 `cloud_auth_jwks_url`） |
| `keySet` 注入点只给测试/集成，部署入口不提供 | `src/mcp/auth.ts:28-36,63`、`src/mcp/runtime.ts:13-18,36-46` | 已验证（代码） |
| JWKS 实际取回、TTL/缓存冷却、轮换（`kid` overlap）行为 | `jose` 库默认行为 + Cloud Auth `apps/api/src/service-credentials/keyring.ts`（active + retiring 公钥） | **未验证**（无真实端点；未观测缓存与轮换） |
| `createMcpRuntime` 按配置键缓存 runtime（含 verifier），避免每请求重建 | `src/mcp/runtime.ts:48-76` | 已验证（代码） |

### 2.4 必需 claim

| claim | 要求 | 位置 | 状态 |
| --- | --- | --- | --- |
| `iss` | 必须存在且 `= mira:cloud-auth` | `src/mcp/auth.ts:74`、`:69` | 已验证（探针） |
| `aud` | 必须存在且匹配配置 audience | `src/mcp/auth.ts:74`、`:70` | 已验证（探针） |
| `exp` | 必须存在、数字、未过期（`clockTolerance` 默认 5s） | `src/mcp/auth.ts:74,73,85-86` | 已验证（探针：过期拒绝） |
| `sub` | 必须非空字符串 → 映射 `accountId` | `src/mcp/auth.ts:74,81,86` | 已验证（探针：空 `sub` 拒绝） |
| `consumer_id`（可配置名，默认） | 必须非空字符串 → 映射 `consumerId` | `src/mcp/config.ts:105-106`、`src/mcp/auth.ts:82-86` | 已验证（探针：缺失/空均拒绝） |
| `scope` | `string[]`（每项非空）或空格分隔 `string`；**malformed 数组整体拒绝**而不是丢弃坏项 | `src/mcp/auth.ts:41-55` | 已验证（探针：`[123]` 拒绝；空格串接受） |
| `alg` | 仅 `EdDSA`（Cloud Auth 公钥为 Ed25519） | `src/mcp/auth.ts:72` | 已验证（代码） |
| `device_id` | Guanlan **不使用**（不参与授权，也不映射身份） | 无引用；`GuanlanPrincipal` 只有 account/consumer/scope/exp/iss/aud（`src/mcp/auth.ts:8-18`） | 已验证（代码） |
| `iat`/`nbf` | Guanlan 不单独校验（由 `jose` 语义与 Cloud Auth 侧保证） | `src/mcp/auth.ts:68-75`（未列 `requiredClaims`） | 已验证（代码；无独立断言） |

主体长度/形态与 D1 一致：`account_id`、`consumer_id` 均为 `1..128` 且 `= trim(...)`（`migrations/0003_guanlan_accounts.sql:4-20`、`src/subscriptions.ts:26`）。

### 2.5 scope 名称与读写分离

| 断言 | 位置 | 状态 |
| --- | --- | --- |
| 读 gate scope：`guanlan.read`，默认值，也是 metadata `scopes_supported` | `src/mcp/config.ts:10,98-103,127` | 已验证（探针：默认 `requiredScopes=["guanlan.read"]`） |
| 写 scope：`guanlan.write`，**故意不进** `requiredScopes`，因此只读凭证仍能进 `/mcp` | `src/mcp/config.ts:11-21`、`src/mcp/server.ts:305-310` | 已验证（代码） |
| `guanlan_news_decide` 自己检查写 scope，缺失返回 `guanlan_decision_forbidden` 且**不访问 D1** | `src/mcp/server.ts:203-213`、`src/mcp/capabilities.ts:73-75` | 已验证（代码；`tests/decision-workerd.test.mjs` 覆盖零写入） |
| `scopes_supported` 目前仍只声明读 scope（写 scope 未签发前不冒充已开通） | `src/mcp/config.ts:123-134`、`docs/engineering/gln-010-mcp-consumption-write.md` §6.5 | 已验证（代码） |

### 2.6 401 / 403 语义与不泄漏

| 情形 | 结果 | 位置 | 状态 |
| --- | --- | --- | --- |
| 无/坏/过期/跨主体令牌、未知签名 key | `401 invalid_token`（不透明，不区分原因） | `src/mcp/auth.ts:38-39,77-79,86` | 已验证（探针全部落到同一 `invalid_token`） |
| 令牌合法但缺 `guanlan.read` | `403 insufficient_scope` | `src/mcp/server.ts:305-310`（SDK `requireBearerAuth`）；`tests/mcp-auth.test.mjs:109-116` | 已验证（既有 T1 测试；本机未重跑该文件） |
| Host / Origin 不匹配 | SDK `hostHeaderValidationResponse` / `originValidationResponse` 拒绝 | `src/mcp/server.ts:326-329` | 已验证（代码） |
| 未配置信任 | `503 {"error":"mcp_not_configured","reason":...}` | `src/app.ts:25-34` | 已验证（探针 + 代码） |
| 读失败 | 显式工具错误，绝不当空页 | `src/mcp/server.ts:58-72,162-168` | 已验证（代码） |
| 未知新闻 vs 无权来源 | 同一个不透明 `guanlan_decision_not_available` | `src/mcp/server.ts:101-102`、`src/mcp/service.ts:749-751`、`src/mcp/capabilities.ts:79-85` | 已验证（代码） |
| 未 provisioning 主体 | `guanlan_principal_unavailable`（读/写同名） | `src/mcp/service.ts:557-565,752-755`、`src/mcp/capabilities.ts:86-87,101-102` | 已验证（代码） |
| 冲突回传 | 只回当前主体的受限状态 JSON（url/status/version/reason/outcomeUrl/decidedAt），无指纹、无他主体数据 | `src/mcp/server.ts:80-108` | 已验证（代码） |
| 未知路径 | `404 not_found`（`/mcp` 与 metadata 之外全部拒绝） | `src/mcp/server.ts:320-324`、`src/app.ts:38` | 已验证（代码） |
| 请求体上限 | 256 KiB；工具参数元素上限 100 | `src/mcp/server.ts:51,313`、`src/mcp/server.ts:133` | 已验证（代码） |

### 2.7 状态 CAS（`stateVersion` / `expectedVersion`）

| 断言 | 位置 | 状态 |
| --- | --- | --- |
| 读页每项带 `stateVersion`：已存决策 = ledger `version`（≥1），未读 = `0`，读路径零写入 | `src/mcp/capabilities.ts:135-140`、`src/mcp/service.ts:498-521`（尤其 `:518-520`） | 已验证（代码） |
| 写工具 `expectedVersion` 为 CAS 前置条件；`0` 表示「尚无决策」 | `src/mcp/capabilities.ts:181-182` | 已验证（代码） |
| 单条条件 UPSERT 完成 CAS：插入要求来源在有效集合内且版本期望为 0；更新要求 `version = expectedVersion` 且 `last_operation_id <> operationId` | `src/consumption.ts:478-504` | 已验证（代码） |
| 版本 +1 单调，排序权威是 `version`，不是客户端时钟 | `src/consumption.ts:501`、`migrations/0004_consumer_news_state.sql:34-36` | 已验证（代码） |
| 幂等：`(account, consumer, news_fingerprint)` 上 `last_operation_id` 相同且内容相同 → `replayed`（不升版本、不改时间）；同 id 不同内容 → `operation_conflict`；重放判定先于版本判定 | `src/consumption.ts:583-597` | 已验证（代码） |
| 过期版本 → `version_conflict`，绝不静默覆盖；无行却传非零版本也回 `version_conflict`（`unreadView`） | `src/consumption.ts:569-580,595-597` | 已验证（代码） |
| 存储批 = 写 + 回读状态 + 回读新闻来源，其余形状异常一律 `storage_failure` | `src/consumption.ts:524-551` | 已验证（代码） |
| 并发同版本恰好一个胜出、跨重启幂等、跨设备恢复 | `tests/decision-workerd.test.mjs`（T3，Miniflare/workerd + D1） | 已验证（既有 CI 证据；本机未重跑） |

### 2.8 工具名与入参/出参（`tools/list` 当前 **3** 个）

单一真相源：`src/mcp/capabilities.ts`；注册处：`src/mcp/server.ts:136-246`。

| 工具 | 入参 | 出参 | 注解 | 状态 |
| --- | --- | --- | --- | --- |
| `guanlan_whoami` | 无 | `{ accountId, consumerId, scopes[] }`（全部来自 token） | 只读 | 已验证（`capabilities.ts:10,149-153`；`server.ts:172-191`） |
| `guanlan_news_recent` | `limit`(1..50,默认20)、`cursor`、`sourceId`、`status[]`(unread/pending/adopted/ignored，默认 unread+pending)、`keyword`(≤200，≤8 词，ASCII 不分大小写 AND)、`ingestedAfter/Before`、`publishedAfter/Before` | `{ items[], count, limit, nextCursor }`；item = `{ id,title,summary,url,sourceId,publishedAt,ingestedAt,status,stateVersion }` | 只读 | 已验证（`capabilities.ts:9,105-147`；`server.ts:136-170`） |
| `guanlan_news_decide` | `url`、`status`(pending/adopted/ignored；`unread` 不可写)、`expectedVersion`、`operationId`(1..128)、`reason?`(1..500)、`outcomeUrl?`(≤2048,http(s)) | `{ result: "updated"\|"replayed", state: { url,status,version,sourceId,reason,outcomeUrl,decidedAt } }` | `readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false` | 已验证（`capabilities.ts:11,170-223`；`server.ts:193-246`） |
| **订阅变更工具** | — | — | — | **不存在**：GLN-011 只交付领域 port，明确把「MCP 订阅编辑工具」列为非目标（`docs/engineering/gln-011-subscription-mutations.md:4,110`）；`server.ts` 只注册上述 3 个工具 |

补充契约事实：

- `guanlan_news_recent` 的 `id` 就是规范 URL（不截断，超界直接报错）；来源 id 也**不截断**（`capabilities.ts:126-140`、`service.ts:498-521`）。
- 页大小上限 50、单请求最多扫 8×50 行，游标绑定主体 + 过滤集合并带完整性摘要（`service.ts:67-69,353-439`）。
- 读默认只返回 `unread+pending`；写入 `adopted/ignored` 后必须显式请求才可见（`capabilities.ts:38-41`、`service.ts:183-196`）。
- 迁移 `0004` 的账本**没有** `poc_news` 外键，90 天清理新闻不会连带清除消费记忆（`migrations/0004_consumer_news_state.sql:7-9,43-47`）。

## 3. 与 GLN-011 领域订阅变更的关系（不是 MCP 工具）

`src/subscription-mutations.ts` 提供的是**领域 port**：`managementGrantFromPrincipal` + `GuanlanManagementPolicy` + `createD1SubscriptionMutator`，
输入 `{ level: "account"|"consumer", op: "upsert"|"remove", sourceId, intervalHours? }`，输出
`{ ok, changed, level, sourceId, intervalHours, effective }`（`docs/engineering/gln-011-subscription-mutations.md:6-55`）。

因此 GLN-014 若需要「Agent 改订阅」这条验收，**当前没有可调用面**：既无 MCP 工具，也无 HTTP 管理路由（`src/app.ts:36-38` 明确无 REST）。
按产品设计 §5 与 §12 C1，订阅修改属于**用户管理操作**，Agent 只能提议；MCP 读身份无权直接改配置
（`docs/product-design.md:157`）。这条应作为独立工作项裁决，不应塞进 GLN-014。

## 4. 只读探针：真实执行结果

命令：`node scripts/gln-014-contract-probe.mjs`（本次新增，**只读**，不联网、不改生产模块）。

它用 esbuild 把真实的 `src/mcp/auth.ts` / `src/mcp/config.ts` 打包后导入（**不是**重写验证器），
用本地生成的 Ed25519 密钥通过文档化的 `keySet` 注入点替代远程 JWKS，因此它证明的是**验证器契约**，
不是任何真实 Cloud Auth 部署。

本机结果（2026-11-04，Windows，Node `v24.9.0`）：**18/18 通过**。

| # | 期望 | 结果 |
| --- | --- | --- |
| 1 | 常量 = `mira:cloud-auth` / `mira:cloud-guanlan` / `guanlan.read` / `guanlan.write` | PASS |
| 2 | 配置默认 `consumerClaim=consumer_id`、`requiredScopes=[guanlan.read]` | PASS |
| 3-4 | `mira:cloud-shiyan`、`mira:cloud-relay-transport` audience 被拒（`mcp_audience_not_guanlan`） | PASS |
| 5 | 缺 JWKS 绑定 → `cloud_auth_jwks_url` | PASS |
| 6 | `/mcp` 资源 URL 作为 audience 可用 | PASS |
| 7 | **Cloud Auth 现行 Shiyan 凭证（`aud=mira:cloud-shiyan`,`scope=[shiyan:authenticate]`）被 Guanlan 拒绝** | PASS |
| 8 | **带 guanlan audience 但**没有 `consumer_id`**的令牌被拒** | PASS |
| 9 | 带正确 `consumer_id` 的 guanlan 令牌被接受（account/consumer/scopes 映射正确） | PASS |
| 10-11 | `scope` 数组与空格串都可携带 `guanlan.write` | PASS |
| 12-16 | Relay audience / 异 issuer / 空 `sub` / 空 `consumer_id` / 畸形 scope 数组 / 过期 exp 全部拒绝 | PASS |
| 17 | 未知签名 key（即使 claims 完美）拒绝 | PASS |

## 5. GLN-013 需要签发的令牌合同（精确草案）

> 目的：给 `cloud-auth` 侧（Issue #129 / GLN-013）一份**可对照实现**的资源侧要求。
> 它只覆盖 Guanlan 资源服务**已经强制**的字段；不扩张 audience，不引入第三方 OAuth，
> 不允许客户端自报 `consumer_id`（主体必须由 Cloud Auth 从已验证 Cloud Session 派生）。

### 5.1 必需字段

| 字段 | 精确要求 | 依据 |
| --- | --- | --- |
| `iss` | 字符串，**恰好** `mira:cloud-auth`（部署中立，不随环境变化） | `src/mcp/auth.ts:69-74`、`src/mcp/config.ts:23` |
| `aud` | 字符串，**恰好** `mira:cloud-guanlan`（推荐）。也接受与 `/mcp` 资源 URL 完全相等的值，但服务名更稳定，建议固定用服务名 | `src/mcp/config.ts:24,93-96` |
| `sub` | Cloud Account 标识，`1..128` 字符、无首尾空白；映射为 Guanlan `account_id` | `src/mcp/auth.ts:81,86`、`migrations/0003_guanlan_accounts.sql:5-7` |
| `consumer_id` | **稳定消费者标识**（同一消费者跨设备/跨会话不变），`1..128` 字符、无首尾空白；**必须属于 `sub` 账户**；映射为 Guanlan `consumer_id` | `src/mcp/auth.ts:82-86`、`src/mcp/config.ts:105-106`、`migrations/0003_guanlan_accounts.sql:11-20` |
| `scope` | 至少 `["guanlan.read"]`；需要写回时必须**显式**包含 `"guanlan.write"`。数组形式（Cloud Auth 现行形状）与空格串都被接受；数组里出现非字符串会被整体拒绝 | `src/mcp/auth.ts:41-55`、`src/mcp/config.ts:10,18-21` |
| `exp` | 数字，秒级；必须存在且未过期（容许 5s 时钟误差） | `src/mcp/auth.ts:73,74,85-86` |
| `iat`/`nbf` | 数字、秒级；Guanlan 不单独校验，但请保持 `nbf <= iat` 且 `exp > nbf` | Cloud Auth 已校验（`.../signer.ts`、`.../service-credential.ts` `refineTemporalClaims`）；Guanlan 侧见 `src/mcp/auth.ts:68-75` |
| `alg` / `kid` | 头 `alg=EdDSA`、`typ=JWT`、`kid` 必须在 Cloud Auth JWKS 中 | `src/mcp/auth.ts:72,63`；Cloud Auth `keyring.ts` |
| `device_id` | 可保留（Cloud Auth 现行必填），Guanlan 忽略。**不得**用它替代 consumer | 无引用；`src/mcp/auth.ts:8-18` |

### 5.2 时效与撤销

| 项目 | 建议/现状 | 依据 |
| --- | --- | --- |
| TTL | Cloud Auth 现行：默认 **300s**、上限 **600s**（`DEFAULT_SERVICE_CREDENTIAL_TTL_SECONDS` / `MAX_...`）。Guanlan **不设上限**，但建议沿用 ≤300s，因为资源侧无法撤销已签发令牌 | Cloud Auth `apps/api/src/service-credentials/signer.ts`；Guanlan 无 TTL 上限检查（`src/mcp/auth.ts:68-75`） |
| 已签发令牌的撤销 | **当前无机制**：Cloud Auth 无 token revocation list / `jti`；Guanlan 只校验签名 + 有效期，没有撤销名单查询 | Cloud Auth `verifier.ts`（只查 iss/aud/iat/nbf/exp/signature/TTL）；Guanlan `src/mcp/auth.ts` |
| 现有可控边界 | ① 短 TTL；② 设备/会话撤销（`DELETE /v1/devices/:deviceId`）只**阻断新签发**（`issueWithinActiveDeviceSession` 在同一 `BEGIN IMMEDIATE` 事务里检查会话/设备），**不能让已发出的令牌提前失效**；③ 账号禁用同理 | Cloud Auth `service.ts`（`issueWithinActiveDeviceSession`）、`docs/deployment.md` |
| 结论（待维护者裁决） | 若 GLN-014 要验收「撤销」，只有两条正路：**(a)** 接受「撤销 = 停止续签 + 短 TTL 自然过期」并在验收里写明时效；**(b)** 在 Cloud Auth 增加可查询的撤销语义（例如账号/设备/消费者级 epoch 或 `jti` 拒绝表）并让 Guanlan 增加一次检查。**不能**用「签名有效」冒充「可撤销」（Issue #26 已明确禁止） | Issue #26 Verification 段 |

### 5.3 签发入口（Cloud Auth 现状，供联调对齐）

| 事项 | 现值 | 依据 |
| --- | --- | --- |
| 签发端点 | `POST /v1/service-credentials`，Body `{ audience }`（客户端只选目标服务，不选账号/消费者） | Cloud Auth `apps/api/src/service-credentials/routes.ts`、`packages/contracts/src/service-credential.ts` |
| JWKS | `GET /.well-known/jwks.json`，`cache-control: public, max-age=300`，支持 active + retiring 公钥 | 同上 `routes.ts`、`keyring.ts` |
| 生产基址 | `https://cloud-auth.tomzlab.cn`（Caddy → `127.0.0.1:8788`） | Cloud Auth `docs/deployment.md` §1 |
| `test` 环境 | 手动 workflow，**不是常驻实例**，与生产共用 8788，需要专门测试窗口 | 同上 §2.3 |
| `dev` 环境 | **不存在** | 同上 |
| 现有 audience/scope 枚举 | 只有 `mira:cloud-shiyan`/`mira:cloud-relay-transport` 与 `shiyan:authenticate`/`relay:transport` | Cloud Auth `packages/contracts/src/service-credential.ts` |
| 现有 claims 形状 | `iss, sub, device_id, aud, scope[], iat, nbf, exp`（relay 另带 `relay`），`.strict()` 且按 `aud` 判别 | 同上 |

### 5.4 GLN-013 必须改动的最小集合（供 auth-dev 对照，非本仓实现）

1. `serviceCredentialAudienceSchema` 增加 `mira:cloud-guanlan`；`serviceCredentialScopeSchema` 增加 `guanlan.read` / `guanlan.write`。
2. 新增 guanlan claims 变体（`.strict()` 内）：在通用字段上**增加 `consumer_id`**，`scope` 至少 `guanlan.read`，**写 scope 必须独立**、不能因读到就自带写。
3. 签发时 `consumer_id` 只能由服务端从已验证 Cloud Session / 设备-账号关系派生，**不接受请求体自报**（现行请求体只有 `{audience}`，保持这个最小面）。
4. 无观澜空间 / 禁用账号 / 账号删除 → fail-closed（与 GLN-012 的状态联动），不能签发。
5. 撤销语义按 §5.2 裁决落地，并在合同里写明「token 失效时延」的实测值。
6. 若签发侧真按上述改动完成，Guanlan 侧**无需任何改动**即可验证（本探针已证明契约吻合）。

## 6. GLN-014 阻塞项（谁提供 / 哪个端点 / 缺什么）

| # | 阻塞项 | 现状证据 | 需要谁 / 缺什么 |
| --- | --- | --- | --- |
| B1 | **没有能通过 Guanlan 验证的令牌** | Cloud Auth `service-credential.ts` 的 audience/scope 枚举与 claims 无 `consumer_id`；本探针实测现行 Shiyan 凭证被拒 | `cloud-auth` GLN-013（Issue #129）。缺：guanlan audience/scope + `consumer_id` claim 的实现与测试 |
| B2 | **没有跑 `/mcp` 的真实观澜端点** | `wrangler.jsonc:3-15`：`cloud-guanlan-poc-do-not-deploy`、`workers_dev:false`、D1 `database_id` 全 0；`src/app.ts:25-34` 只有 `/mcp` + metadata | 需要一个隔离（dev/test）部署：真实 `MCP_RESOURCE_URL`、`CLOUD_AUTH_ISSUER`、`CLOUD_AUTH_JWKS_URL`、`MCP_AUDIENCE` 四个 binding。缺：部署授权 + 绑定 + 账号 |
| B3 | **没有已执行 `0003`/`0004` 的真实 D1** | GLN-003 Canary 只执行 `0001`/`0002` 且已关闭 Cron（`docs/engineering/gln-003-cloudflare-canary.md:4,20,127`）；`0003`/`0004` 只在本地 Miniflare 测试里跑过 | 需要一个执行过 4 个迁移的隔离 D1，且**不含**真实用户数据 |
| B4 | **真实账户没有观澜空间行** | 注册链路 GLN-012 的 PR（`cloud-auth` #130）仍 open；`guanlan_accounts`/`guanlan_consumers` 只能由 provisioning 写入（`migrations/0003:4-20`） | `cloud-auth` GLN-012 合并 + 观测到真实注册成功；否则读写都会 `guanlan_principal_unavailable`（`src/mcp/service.ts:557-565`） |
| B5 | **Cloud Auth 无隔离环境** | 只有生产 `cloud-auth.tomzlab.cn`；`test` 非常驻；无 `dev`（`docs/deployment.md` §2.3） | 维护者指定：隔离测试窗口（test workflow）或本地 compose 实例 + 测试账号；**不得**拿生产做 GLN-014 验收 |
| B6 | **撤销语义未裁决** | Cloud Auth 无撤销表；Guanlan 无撤销检查（见 §5.2） | 维护者裁决 (a)/(b)；选 (b) 则两边都要改 |
| B7 | **订阅变更没有可调用面** | 仅领域 port，无 MCP 工具、无 HTTP 路由（`gln-011...md:4,110`、`src/app.ts:36-38`） | 若验收要求覆盖，另立工作项；GLN-014 不扩张 |
| B8 | **fixture 不能替代真实链路** | `tests/mcp-fixtures.ts:24-43` 的 `FIXTURE_TOKENS` 是测试凭证表，部署模块无法通过环境变量选中它（`src/mcp/auth.ts:102-121`、`src/mcp/runtime.ts:13-18`） | 验收必须用真实签发令牌；fixture 只证明拒绝/接受逻辑 |

## 7. 与 auth-dev（GLN-013）草案的交叉核对

- 本文 §5 就是提交给 `cloud-auth` 侧的**资源侧要求摘要**，请通过 lead 转交 `auth-dev`。
- **交叉核对状态：未验证（待回执）**。截至本文提交时，尚未取得 `auth-dev` 的令牌合同草案文本；
  §5 只由 Guanlan 当前代码 + 本探针推导，不代表双方已确认。
- 已知需要双方一致的三点（当前只有 Guanlan 侧事实）：
  1. `consumer_id` 的**名字**与**派生来源**（本文按验证器默认 `consumer_id` 写；若改用别的 claim 名，必须同时给 `MCP_CONSUMER_CLAIM` 绑定，`config.ts:105-106`）；
  2. 写权限是否用独立 scope `guanlan.write`（Guanlan 已实现工具级检查，`server.ts:203-213`）；
  3. 撤销语义（§5.2 的 (a)/(b)）。
- 任何一条与 `cloud-auth` 现有 `.strict()` claims 冲突时，**以跨仓库裁决为准，不在任一仓私自扩张**（组织 AGENTS §5/§8）。

## 8. 本文没有证明什么

- 没有真实 Cloud Auth 令牌、没有真实 JWKS 取回、没有真实 `kid` 轮换观测。
- 没有真实观澜部署、没有真实 D1、没有 Cloudflare CPU/配额结论。
- 没有 Desktop/Mobile 客户端接线，没有 Pi SDK / Cloud Agent 侧联调。
- 没有重跑全量 `npm run check`（只跑了 `npm run typecheck` 与探针）；T3 结论引用自既有测试文件，本机未重跑。
- 不是 GLN-014 的验收证据，只是它的**前置输入**。

## 9. 复现命令

```bash
# 依赖（本机已执行，Node 24）
npm ci --no-audit --no-fund

# 类型与只读契约探针（本机已执行，18/18）
npm run typecheck
node scripts/gln-014-contract-probe.mjs

# 仓库门禁（需 Git Bash 或 Ubuntu CI；本机未安装 Git Bash）
bash scripts/check.sh
```
