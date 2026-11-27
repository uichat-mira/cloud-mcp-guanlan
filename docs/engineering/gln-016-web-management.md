# GLN-016 · 观澜 Web 管理界面 V1

> Work item: [Issue #34](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/34)

## 1. 产品位置

观澜 Web 管理面是 **Guanlan 云端配置权威的官方 UI**，不是 Desktop/Mobile 的影子配置页。

- Guanlan owns: 账户/消费者订阅、关注点、来源采集健康与消费状态。
- Mira ID owns: Cloud Account 身份、应用授权、OAuth 会话与服务凭据。
- Desktop/Mobile 后续只需要提供观澜入口、登录上下文衔接和 Agent 工具消费；不得复制一份独立订阅状态机。
- MCP 继续只服务 Agent 工具调用；Web 管理写入不是 MCP scope 的副作用，也不增加私有 MCP 工具。

V1 页面路径：

- `GET /manage`：账户/当前 consumer 的有效配置与来源健康。
- `POST /manage/subscriptions`：账户级或当前 consumer 级来源订阅 upsert/remove。
- `POST /manage/logout`：清除当前浏览器的 Guanlan 管理会话。

## 2. 身份与管理会话

GLN-015 的 OAuth 回调会：

1. 用 authorization code + PKCE S256 向 Mira ID 换取短时 application access token；
2. 用 `GET /v1/oauth/application-session` 再确认 identity；
3. 核对 issuer / subject / client audience / APP_ID / expiry；
4. **不保存 application access token**；
5. 若 `GUANLAN_WEB_SESSION_SECRET` 配置有效，则由 Guanlan 自己签发最多 15 分钟的 `__Host-guanlan_manage` 管理 Cookie。

Cloud Auth 当前 `dev` 的 `ApplicationOAuthRepository.identity()` 明确把 `application_oauth_sessions.account_id` 作为 `subject` 返回；session 校验同时要求 access token secret 匹配、未撤销、未过期、账户 active，且应用实例/revision 仍匹配。因此管理 identity 只从该已验证 `subject` 派生：

- `accountId = subject`
- `consumerId = subject`（沿用 GLN-015 首期稳定 consumer 决策）
- management authority = 仅管理**自己的** account baseline 和**自己的** consumer increment
- 页面/表单/API 都没有 accountId / consumerId 可选字段，不能指定兄弟 consumer 或其他账户。

管理 Cookie：

- HMAC-SHA256 签名；
- `HttpOnly; Secure; SameSite=Lax; Path=/`；
- 仅包含 app-bound identity、签发/过期时间和固定的 self-management authority；
- 不包含 Mira ID access token、AppSecret、密码或 MCP service credential；
- 最大 TTL 15 分钟，不能自行 refresh；过期必须重新经过 Mira ID OAuth。

### 撤销传播边界

Guanlan 不保存 Mira ID access token，因此管理请求不会每次回查 `application-session`。Mira ID 在 Cookie 签发后发生的远端 revoke/disable，最坏在本地管理会话剩余 TTL 内生效，当前上限 **15 分钟**。本卡不虚构“即时跨服务撤销”。

- 用户点击 `/manage/logout` 会立即清除本地 Cookie；
- 全局紧急失效可轮换 `GUANLAN_WEB_SESSION_SECRET`；
- 若未来产品要求秒级远端撤销，应设计可验证的 server-side session/revocation 合同，而不是持久化 Mira ID access token 到 localStorage/D1。

## 3. 读取合同

`src/manage/service.ts` 不实现第二套订阅合并算法：

1. 先用 GLN-006 `createD1SubscriptionReader().read(subject)` 得到 effective sources / interests；
2. 再只读 `poc_sources` 的采集健康，以及当前 account/current consumer 的原始 interval rows；
3. 只把 GLN-008 `APPROVED_PUBLIC_FEEDS` 中的来源映射到 UI。

展示字段包括：

- 公共来源 identity / URL；
- 是否已进入共享采集库；
- scheduler interval（平台采集状态）；
- `due_at / last_checked_at / last_status / last_error / retry_count`；
- account interval；
- current consumer interval；
- effective origin / interval / interval source；
- effective interests（V1 只读）。

D1 失败、主体空间缺失和空配置是不同结果。存储失败绝不能渲染成“没有订阅”。

## 4. 写入合同

V1 只开放已有安全领域合同的来源订阅修改。

请求 body 严格限于：

- `level = account | consumer`
- `op = upsert | remove`
- `sourceId`
- `intervalHours = 1..24`（仅 upsert）

边界：

- exact same-origin `Origin` 校验；
- `application/x-www-form-urlencoded` only；
- 不接受 accountId / consumerId / role / arbitrary URL；
- management session 中的 authority 必须包含请求 level；
- route 只通过 `managementGrantFromPrincipal` 形成 grant；
- 所有实际写入复用 GLN-011 `createD1SubscriptionMutator`；
- GLN-011 继续负责来源存在/allowlist 校验、幂等、D1 batch、主体隔离和写后 GLN-006 effective read。

因此 UI route 不直接写 `guanlan_*_subscriptions` SQL。

## 5. 明确未开放

### 自定义 RSS / Atom

GLN-008 当前仍采用精确维护者 allowlist，因为 Workers 没有可依赖的 API 来证明任意域名最终 DNS/IP 不会发生 rebinding。V1 只展示批准目录，不提供 arbitrary URL 输入框。

### 关注点编辑

D1 已有 account/consumer interests，但当前没有与 GLN-011 同等级的 mutation + authority 合同。V1 只展示 effective interests。

### Consumer 创建/切换/撤销

GLN-015 首期 `consumerId = sub`。V1 不引入命名 consumer 的管理状态机。

## 6. UI 约束

- 服务端渲染，核心功能无 JavaScript 依赖；
- 与 Guanlan 品牌层共用 mark / tokens / typography；
- source health、effective configuration 与 account/consumer override 在一页可见；
- “尚未开放”能力必须明确标注，不能画出伪可用按钮；
- 动态文本 HTML escape；
- management 响应 `no-store`；
- CSP 默认拒绝外部资源，管理页只允许 self form action；
- 管理 POST 采用 PRG（Post/Redirect/Get）。

## 7. 验证

本卡应留下：

- T1/T2：session 签发/篡改/过期/app drift、OAuth token 不持久化、HTML escaping、表单不含 identity selecting fields；
- T3 workerd + D1：未登录 redirect、真实 D1 snapshot、account/consumer mutation、继承/覆盖、cross-tenant 不变、CSRF、subject injection、invalid interval、unapproved source、storage failure；
- `npm run check` / `bash scripts/check.sh` / Wrangler dry-run；
- 本地 renderer preview 仅用于视觉走查，不是认证证据。

## 8. 部署边界

GLN-016 本卡**不部署生产、不启用 Cron**。正式环境要启用管理面，除了 GLN-015 既有 bindings，还需要独立的高熵 `GUANLAN_WEB_SESSION_SECRET`。该值不得提交到 Git、日志或前端。
