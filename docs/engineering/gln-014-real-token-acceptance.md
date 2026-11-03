# GLN-014 L3：真实令牌的 Guanlan MCP 读写验收（t10）

> 工作项：t10 · [GLN-014] 真实令牌的 Guanlan MCP 读写与隔离验收
> 关联 Issue：[#26 `[GLN-014]`](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/26)
> 证据类型：**真实 Cloud Auth 非生产实例签发 → 真实公网 Worker → 真实 D1**。内容侧使用一行**合成 fixture 文章**（见 §9-1），身份链路无任何 fixture。
> 时间：2026-11-04。

## 1. 环境与身份链路

| 组件 | 事实 |
| --- | --- |
| 资源服务 | `https://cloud-guanlan-gln014-3c872be6.dangjingtao.workers.dev`（`workers_dev: true`，`triggers.crons: []`） |
| 部署版本 | `752ae9d7-73b0-420a-b50f-635ab9855900`（本文件证据对应的最后一次 deploy） |
| D1 | `cloud-guanlan-gln014-3c872be6`，迁移 0001..0005 |
| Cloud Auth（非生产） | `127.0.0.1:8788`（auth-dev t23 实例），签发 `POST /v1/service-credentials` |
| JWKS | `https://<current-host>/.well-known/jwks.json`（localhost.run 临时隧道；单 key `kid=gln013-t23-1`、`kty=OKP`/`Ed25519`/`EdDSA`） |
| 主体 | 前缀 `5728cbcd`（`sha256_12 = a5600cdf992a`），`accountId == consumerId`（维护者裁决①） |

Worker 绑定：`DB`、`MCP_RESOURCE_URL`、`MCP_AUDIENCE=mira:cloud-guanlan`、`CLOUD_AUTH_JWKS_URL=https://<host>/.well-known/jwks.json`、`CLOUD_AUTH_ISSUER=https://<host>`。

> **契约澄清（易错点）**：`CLOUD_AUTH_ISSUER` 是 RFC 9728 发现里对外公布的 **OAuth 授权服务器 URL**，`resolveMcpConfig` 要求它是合法 HTTPS URL；JWT 的 `iss` 由代码常量 `CLOUD_AUTH_TOKEN_ISSUER = "mira:cloud-auth"` 单独校验。因此**不能**把 `CLOUD_AUTH_ISSUER` 设成 `mira:cloud-auth`（会被判 `cloud_auth_issuer` → `/mcp` 503）。见 `src/mcp/config.ts:82-83` 与 `src/mcp/config.ts:114`。

## 2. 令牌合同核对（不打印令牌原文）

`mint.mjs` 现签、令牌只落本机受限临时文件；下列为脱敏投影：

| 项 | 值 | 与资源服务期望一致 |
| --- | --- | --- |
| `alg` / `kid` | `EdDSA` / `gln013-t23-1` | ✅ 与 JWKS 单 key 匹配 |
| `iss` | `mira:cloud-auth` | ✅ 与 `CLOUD_AUTH_TOKEN_ISSUER` 相同 |
| `aud` | `mira:cloud-guanlan`（单值） | ✅ 与 `MCP_AUDIENCE` 精确相等 |
| `scope` | `["guanlan.read"]`（写令牌为 `["guanlan.read","guanlan.write"]`） | ✅ 含全局读门 `guanlan.read` |
| `consumer_id` | 存在且 `=== sub` | ✅ |
| `ttl` | 300s | ✅ ≤ 维护者裁决的 300s 上限 |

## 3. 主链路：read → CAS decide → 重读（全部真实令牌）

协议：Streamable HTTP，`legacy: "stateless"`，无需会话 id（`mcp-session-id` 响应头 absent，未影响调用）。

| # | 调用 | HTTP | isError | 结果 / 工具错误码 | stateVersion |
| --- | --- | --- | --- | --- | --- |
| 1 | `initialize` | 200 | – | `serverInfo` 返回，`capabilities.tools` 存在 | – |
| 2 | `tools/list` | 200 | – | 3 个工具：`guanlan_news_recent`(ro)、`guanlan_whoami`(ro)、`guanlan_news_decide`(write, idempotent) | – |
| 3 | `guanlan_whoami` | 200 | false | `accountId == consumerId`（前缀 `5728cbcd`），`scopes:["guanlan.read"]` | – |
| 4 | `guanlan_news_recent`（读前） | 200 | false | 1 条，`status:"unread"`，`sourceId:"t10-fixture-source"` | **0** |
| 5 | `guanlan_news_decide`（`expectedVersion: 0`, operationId A, `status:"adopted"`） | 200 | false | `result:"updated"`、`status:"adopted"` | **1** |
| 6 | 同 operationId A 重放（同内容） | 200 | false | `result:"replayed"`，版本不再上涨 | 1 |
| 7 | 旧 `expectedVersion: 0` 再判（新 operationId B, `status:"ignored"`） | 200 | **true** | `guanlan_decision_version_conflict`，正文回显当前 `version:1`，**未覆盖** | 1 |
| 8 | `guanlan_news_recent`（读后，含 adopted/ignored/pending） | 200 | false | 1 条，`status:"adopted"` | **1** |
| 9 | 再判（`expectedVersion: 1`, operationId C, `status:"ignored"`） | 200 | false | `result:"updated"` | **2** |

要点：
- **CAS 生效**：第 7 步用过期版本被判冲突，且错误正文带出真实当前状态（便于客户端重读），不是静默覆盖。
- **幂等生效**：第 6 步同 `operationId` 被判 `replayed`，版本保持 1。
- **持久化可观察**：第 8/9 步读回 `adopted@1`→`ignored@2`，与 D1 行一致（§4）。
- MCP 语义：工具级拒绝以 **HTTP 200 + `isError:true`** 返回（协议约定），不是 HTTP 4xx；认证级拒绝才是 401（§5）。

## 4. 真实 D1 侧不变量

`wrangler d1 execute --remote` 只读取证：

| 表 | 值 | 说明 |
| --- | --- | --- |
| `guanlan_consumer_news_states` | 1 行：`status=ignored`、`version=2`、`source_id=t10-fixture-source`、`news_fingerprint` 前缀 `a6fccf469acd`、`reason` 长度 30、`last_operation_id` 前缀 `t10-179372` | 与第 9 步一致；**仅 1 行**，冲突/重放都没有产生额外行 |
| `guanlan_accounts` / `guanlan_consumers` | 3 / 3（`5728cbcd` + 两条 t18 合成 UUID） | 未新增/删除 |
| `guanlan_account_subscriptions` / `..._consumer_subscriptions` | 1 / 1（本次 seed 的 fixture 源） | 写路径未改动订阅 |
| `guanlan_account_interests` / `..._consumer_interests` | 0 / 0 | 未产生 |
| `poc_sources` / `poc_news` | 1 / 1（fixture） | 未新增 |

**结论**：写工具只动 `guanlan_consumer_news_states`，不越权写订阅/关注点/新闻索引。

## 5. 负例矩阵

| # | 负例 | 构造 | 结果 | 数据不变 |
| --- | --- | --- | --- | --- |
| N1 | 无凭据 | 不带 `Authorization` | **401**，`WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", scope="guanlan.read", resource_metadata="…/oauth-protected-resource/mcp"` | ✅ |
| N2 | 垃圾/伪造令牌 | `Bearer not-a-jwt` | **401** `invalid_token` | ✅ |
| N3 | 篡改签名 | 取真令牌，改写签名尾 4 字节 | **401**（签名校验拒绝） | ✅ |
| N4 | 仅读令牌调写工具 | `scopes:["guanlan.read"]` 打 `guanlan_news_decide` | HTTP 200 + `isError:true`，`guanlan_decision_forbidden`（「read access never grants state changes」） | ✅ 版本仍 2 |
| N5 | 过期令牌 | 现签后等过 300s TTL 再调 `guanlan_whoami` | **401**（见 §5.1） | ✅ |
| N6 | 错误 audience | 用 `--audience=mira:shiyan` 签一枚 Shiyan 令牌再打 Guanlan `/mcp` | **blocker（未取到证据）**：两次尝试都撞上非生产实例掉线（`ECONNREFUSED 127.0.0.1:8788`）。此前一次直接构造 `{"audience":"mira:shiyan"}`（不带 scope）的探测返回 **400 `SERVICE_CREDENTIAL_INVALID_REQUEST`**，说明签发侧对非 Guanlan audience 至少会拒绝一部分请求；但「资源服务侧拒绝错误 aud」仍未用真实令牌验证过，**不以推断代替证据** | n/a |
| N7 | 跨账户 | 需要第二个已 `delivered` 的真实身份 | **blocker**：非生产实例只有一个测试账号；签发器对未 `delivered` 账户一律 409 | n/a |
| N8 | 跨 consumer | `consumer_id` 恒等于 `sub`（裁决①），签发器不接受自报 consumer | **结构性不可构造**；由 GLN-013 单测与 `consumer_id===sub` refine 覆盖 | n/a |
| N9 | 无空间（未供应） | 未 `delivered` 账户取令牌 | **blocker**：签发前置即为 409 `SERVICE_CREDENTIAL_PRINCIPAL_NOT_READY`，无法获得令牌去验证资源服务侧分支 | n/a |
| N10 | 禁用账户 | 需要非生产实例的禁用开关 | **blocker**：t23 实例未提供禁用 API；生产未触碰 | n/a |

### 5.1 N5 过期令牌（已实测）

现签（`exp - iat = 300`）→ 等到 `exp + 15s` → 打 `/mcp` `tools/call guanlan_whoami`：

```
HTTP 401
WWW-Authenticate: Bearer error="invalid_token", error_description="invalid_token", scope="guanlan.read", resource_metadata="…/oauth-protected-resource/mcp"
body: {"error":"invalid_token","error_description":"invalid_token"}
```

即超过 TTL 的令牌被拒绝，且响应不透露「是过期还是签名不对」——与既有不透明 401 语义一致。

## 6. 撤销语义（按既定裁决）

- **不宣称即时撤销**：令牌无 `jti`、无撤销表，撤销 = 短 TTL。因此「停止续签后 ≤300s 内失效」是本设计能达到的最强保证。
- **禁用账户的残留**：账户被禁用后，已签发令牌在 `exp` 前仍然可用（≤300s 窗口）。本轮**未验证**该残留（见 N10 blocker），报告必须写明它是设计允许的窗口，而非已消除。
- 已实测：超过 TTL 的令牌被 401 拒绝（N5）。

## 7. fail-closed 与不退化项

| 项 | 结果 | 来源 |
| --- | --- | --- |
| JWKS 不可达时拒绝令牌 | **401**（占位 `cloud-auth.invalid` 期间所有令牌 401） | t18 冒烟 S4；本轮 host 轮换期间同样只出现 401，没有 5xx 或放行 |
| RFC 9728 metadata | 200，`resource`/`scopes_supported`/`bearer_methods_supported`/`authorization_servers` 正确 | t18 S2（变量替换后 host 变了，字段结构不变） |
| 未知路径 | 404 `not_found` | t18 S5 |
| Host/Origin 校验 | 既有单测；本轮真实请求未触发 403（`Origin` 未发送、`Host` 为 Worker 自身） | `src/mcp/server.ts:326-331` |
| legacy `stateless` | 本轮全部调用成功，未要求会话 id | 本文件 §3 |
| 只读工具面不退化 | `tools/list` 仍 3 个工具，annotations 与既有一致 | 本文件 §3-2 |

## 8. 复现步骤

```powershell
# 0) 每次 deploy 前从文件读 JWKS host（隧道重连会换 host，禁止用聊天里的旧值）
$h = (Get-Content "$env:TEMP\gln013-t23\current-host.txt").Trim()

# 1) 只改变量重 deploy（不重建 D1；配置在仓库外，含 D1 UUID）
#    CLOUD_AUTH_JWKS_URL = https://$h/.well-known/jwks.json
#    CLOUD_AUTH_ISSUER   = https://$h            # 必须是 https URL，不能是 mira:cloud-auth
.\node_modules\.bin\wrangler.cmd deploy --config "$env:LOCALAPPDATA\Temp\gln014-env\wrangler.jsonc"

# 2) 现签令牌（TTL 300s，只打印摘要，令牌落本机受限文件）
node "$env:TEMP\gln013-t23\mint.mjs" "$env:TEMP\gln013-t23" guanlan.read guanlan.write

# 3) 跑验收客户端（真实公网；Client 仅用标准 JSON-RPC over Streamable HTTP）
$env:MCP_BASE='https://cloud-guanlan-gln014-3c872be6.dangjingtao.workers.dev'
$env:MINT_DIR="$env:TEMP\gln013-t23"
$env:NODE_USE_ENV_PROXY=1; $env:HTTPS_PROXY='http://127.0.0.1:1080'; $env:NO_PROXY='127.0.0.1,localhost'
node "$env:TEMP\gln014-env\mcp-acceptance.mjs" main      # 主链路
node "$env:TEMP\gln014-env\mcp-acceptance.mjs" readonly  # N4
node "$env:TEMP\gln014-env\mcp-acceptance.mjs" tampered  # N3
node "$env:TEMP\gln014-env\expired-token.mjs"            # N5（等 300s）
```

上述客户端脚本位于**仓库外**临时目录（含令牌路径假设），不入库；实现是通用 JSON-RPC，不依赖本仓内部代码。

## 9. 诚实性边界（验收口径）

1. **内容侧是 fixture**：`poc_sources`/`poc_news` 里只有一行合成文章（URL `https://fixture.invalid/...`），因为维护者尚未批准任何真实新闻源（G4）。这证明「读→判→重读」的**机制与身份链路**，不证明真实采集内容。身份、令牌、JWKS、Worker、D1、CAS、幂等全部真实。
2. **单身份**：只有 `5728cbcd` 一个真实主体，因此跨账户/跨 consumer/无空间/禁用账户四类负例见 §5 的 blocker，不以推断代替证据。
3. **JWKS 是临时隧道**：localhost.run 重连会换 host；换 host 期间 `/mcp` 全部 401（fail closed）。真实长期验证需要非生产 Cloud Auth 的公网常驻入口。
4. **撤销是 TTL 语义**：没有即时撤销；禁用账户的 ≤300s 残留未消除（§6）。
5. **`bash scripts/check.sh` 本机不可执行**：`C:\Windows\system32\bash.exe` 是 WSL 且 25s 内无响应（探测已记录），故以 `npm run check` 与 Ubuntu CI 为权威。这是环境限制，不是脚本缺陷。
6. **测试命令结果**：`npm run check` exit 0（typecheck + unit + workerd integration + dry-run + benchmark + canary + profile），见 §10。

## 10. 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run check`（`D:\cloud-mcp-guanlan-wt\gln-014`） | **exit 0**（末尾 profile `pass 1 / fail 0`） |
| `bash scripts/check.sh` | **未执行**：本机只有 WSL `bash.exe`，探测 25s 无响应；Ubuntu CI 为权威 |
| `wrangler deploy --config <仓库外配置>` | exit 0，version `752ae9d7-73b0-420a-b50f-635ab9855900` |
| `wrangler d1 execute --remote`（只读核对） | 见 §4 |

## 11. 资源服务侧改动

**无需改动**：真实令牌链路暴露的失败最初全部来自环境（JWKS host 轮换），不是代码缺陷。本轮**未修改** `src/**`、`migrations/**`、`wrangler.jsonc`；本卡只新增本文档。
