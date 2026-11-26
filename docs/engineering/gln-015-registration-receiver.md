# GLN-015 · 观澜 Mira ID V1 应用实例与标准 MCP 切换

> Issue: uichat-mira/cloud-mcp-guanlan#28  
> Current architecture: Mira ID Open Platform V1 + standard MCP 2026-07-28  
> Supersedes: the former Cloud Auth → Guanlan HMAC account-space registration receiver.

## 1. Architecture

观澜不再作为 Cloud Auth 内部的特殊下游服务接入。它是一个正常的 **Mira ID 应用实例**：

1. 部署实例生成并保存自己的 `APP_ID` 与 server-only `AppSecret`。
2. `GET /.well-known/mira-application` 公布应用、品牌、OAuth 与服务元信息。
3. Mira ID 通过同源 `POST /mira/verify-registration` 验证 `APP_ID + AppSecret`，完成实例所有权登记。
4. 观澜声明一个 `serviceId = news` 的标准 MCP 服务，resource 为该实例真实 `/mcp` URL。
5. Mira ID 按 `APP_ID + serviceId + resource` 为获准账号/终端签发短期服务凭据。
6. 观澜只验证并消费该凭据；真实工具能力继续由标准 MCP `tools/list` / `tools/call` 提供。

Mira ID 的应用/服务声明属于 MCP 外层。它不能复制 Tool Schema、替代 ToolAnnotations、扩张业务权限或引入 Mira 私有 MCP wire protocol。

## 2. Deployment identity

部署必须显式提供：

- `GUANLAN_APP_ID`: 稳定实例身份；同一部署升级时保持不变，复制为另一个实例时重新生成。
- `GUANLAN_APP_SECRET`: 只用于实例登记证明，不进入 manifest、浏览器状态、日志或 MCP token。
- `GUANLAN_MANIFEST_REVISION`: manifest 内容变化时递增。
- `MCP_RESOURCE_URL`: 精确的 HTTPS `/mcp` resource。
- `CLOUD_AUTH_ISSUER` / `CLOUD_AUTH_JWKS_URL`: Mira ID 授权服务器与签名验证来源。

旧 `MIRA_GUANLAN_REGISTRATION_SECRET`、`MCP_AUDIENCE=mira:cloud-guanlan`、`MCP_CONSUMER_CLAIM` 与 serviceId-only 发行合同均不再属于目标运行配置。

## 3. Public application declaration

应用品牌：

- Application: **观澜 Guanlan**
- Project ID: `guanlan`
- Service: **观澜新闻服务**
- Service ID: `news`
- Protocol: `mcp@2026-07-28`

当前 MCP tools：

- `guanlan_whoami`
- `guanlan_news_recent`
- `guanlan_news_decide`

manifest 只保存这些 tool name 的引用与可选治理提示；输入/输出 schema、description 与官方 ToolAnnotations 以实时 `tools/list` 为准。

## 4. Access credential

观澜 V1 凭据必须同时满足：

- JWT `iss = mira:cloud-auth`
- `aud === resource === MCP_RESOURCE_URL`
- `app_id === GUANLAN_APP_ID`
- `service_id === news`
- 有非空 `sub`、`device_id`
- `iat / nbf / exp` 合法且总寿命不超过 10 分钟
- scope 是封闭集合：当前 `news` service 在 manifest 中声明 `guanlan.read + guanlan.write`，Mira ID V1 按当前声明签发完整 scope 集合
- 不接受未声明扩展 claim

本阶段 `consumerId = sub`：账号主体就是默认稳定消费身份。数据库里历史上支持的多消费者模型不因此自动删除，但任何新的命名消费者/切换能力必须另立产品与授权合同，不能靠客户端参数或自定义 JWT claim 偷渡。

`guanlan_news_decide` 继续独立检查 `guanlan.write` 作为资源端纵深防御。当前 Mira ID V1 **不支持 application service 按次选择 scope 子集**：合法 `news` 凭据会携带 manifest 声明的 read + write；如果未来需要只读 grant，应先扩展开放平台合同或另立清晰服务边界，不能在观澜私自发明半套签发协议。

## 5. MCP contract

- 只接受 MCP `2026-07-28`。
- 官方 SDK handler 使用 `legacy: "reject"`。
- RFC 9728 protected-resource metadata 公开可发现；真实 `/mcp` 仍执行 Host/Origin/bearer 验证。
- 旧 `2025-06-18` / `2025-11-25` initialize 客户端必须失败，不做静默降级。
- 标准 MCP Client 在取得合法凭据后应可直接互操作，不要求理解 Mira 外层 manifest。

## 6. Retired HMAC receiver

旧 `POST /internal/guanlan-registrations` 已退出运行入口；旧 receiver 源码与其专项测试删除。

历史 migration / receipt 表可以暂时保留，原因是已执行数据库迁移不可假装从未存在；保留历史表不等于保留旧协议。不得重新接回 HMAC endpoint、共享 secret 或 Cloud Auth 账号创建投递链。

## 7. Verification gates

合并前至少证明：

- manifest 与登记验证的单元合同；
- manifest toolRefs 与实际 `tools/list` 一致；
- 真实 2026-07-28 client 的 `tools/list` / `tools/call`；
- V1 EdDSA 凭据的 app/service/resource/scope/expiry 负例；
- legacy client 失败；
- 旧 HMAC route 为 404；
- `npm run check` 与 Mira Gate 通过；
- 真实 Cloud Auth dev + real workerd/D1 的隔离纵切，记录精确 SHA。

生产发布、生产密钥、生产账号、生产 Cron 与 Cloudflare 容量结论不由本合同自动授权。
