# 设计：推推（TuiTui）渠道 adapter

日期：2026-08-31
状态：用户已批准（2026-08-31，交互式确认：单聊+群聊、interactive 卡片审批、全媒体、本机开发→迁生产、现成凭据、路线 A）

## 1. 背景与目标

在 `Claude-to-IM-skill`（Node.js daemon，将 Claude Code / Codex 桥接到 IM 平台）中新增「推推」渠道。

推推是公司内网 IM（`alarm.im.qihoo.net`），本系统 intent-os-platform 已在 Rust 侧实现完整协议
（`crates/domain/intent-im-bridge/src/tuitui_provider.rs`，1539 行，含发送/WS 接收/媒体/交互卡片/重连）。
本设计参考该实现，将其协议移植到 skill 的 adapter 架构中。

**已确认的需求范围：**
- 单聊 + 群聊（群聊仅响应 @提及，对齐 Rust `check_mentioned`）
- 权限确认用 interactive 卡片按钮（对齐 Rust 版）——比微信 adapter 的文本 /perm 体验好
- 图片/文件全媒体（入站下载、出站上传）
- 已有推推应用凭据（App ID / Secret / 机器人名）
- 开发在本机（/ssd2/baobao，内网可达 alarm.im.qihoo.net），验证后迁 Linux Host 生产
- 实现路线：在 skill 内新增 adapter（路线 A），复用 skill 框架的会话/权限/日志/进程能力

## 2. 现状调研结论

### 2.1 Claude-to-IM-skill（目标项目）
- `package.json` 依赖 `claude-to-im: file:../Claude-to-IM`（本地源码包，已克隆到 `/ssd2/baobao/Claude-to-IM`）
- Adapter 模式：`BaseChannelAdapter` 子类 + `registerAdapterFactory(channelType, factory)`，
  `main.ts` 侧副作用 import 注册（`import './adapters/weixin-adapter.js'`）
- adapter 接口：`start/stop/isRunning/consumeOne/send/validateConfig/isAuthorized`，
  可选 `onMessageStart/onMessageEnd/acknowledgeUpdate/answerCallback` 等
- 配置：`config.env` 的 `CTI_*` 变量经 `src/config.ts` 映射为 Config 与 bridge settings
  （`bridge_<channel>_enabled` 控制启用；bridge-manager 遍历 `getRegisteredTypes()` 检查该 key）
- 权限流程（bridge 包 `permission-broker.ts`）：permission 请求 → 对 `qq`/`weixin`（黑名单特判）
  发文本 /perm 提示，其它渠道发 `HTML` 文本 + `inlineButtons`（`perm:allow|allow_session|deny:<permId>`）
  → adapter `send()` 渲染 → 回调以 `InboundMessage{callbackData, callbackMessageId}` 回流 →
  bridge-manager 调 `handlePermissionCallback`（校验 chat/msg 一致性 + 防重复解析）
- 微信 adapter 用轮询（iLink API），推推协议更简单：HTTP 发送 + WS 接收

### 2.2 推推协议（Rust 版 `tuitui_provider.rs` 事实）
- 凭据：`appid` + `secret`（+ `bot_name` 用于 @提及文本兜底检测）
- 发送：`POST {base}/message/custom/send?appid=&secret=`，body：
  `{togroups?/tousers?, msgtype: "text"|"link"|"interactive"|"image"|"attachment", ...}`
  - 目标判定：全 ASCII 数字 → 群（`togroups:[target]`），否则 → 用户（`tousers:[target]`）
  - `interactive` 卡片：`{id, url, mobileurl, head{text,bgcolor,tcolor}, body{content},
    footer[{text,rtext}], action[{text,name,value,color,bgcolor}]}`；
    发按钮请求用 `msgtype:"interactive"`；更新已发卡片走 `POST /message/custom/modify`，
    body `{tousers:[{user,msgid}]/togroups:[{group,msgid}], msgtype:"interactive", interactive:{...}}`
  - 文本响应 `{errcode, errmsg, msgids:[{user?, msgid?}]}`；`errcode != 0` 视为失败
- 接收：WS 长连接 `wss://alarm.im.qihoo.net/callback/ws?auth=<appid>.<secret>`（固定域名，不入参）
  - 事件信封 `{event_id, body}`；**每个事件须 3 秒内回 `{"ack": event_id}`**，否则后续消息不投递
  - `body.event`：`single_chat` / `group_chat`（`msgtype` 可为 `single_chat_open`/`group_chat_open`
    带文本 → 当文本消息；无文本 → 只 ACK）/ `keepalive`（只 ACK）
  - `body` 字段：`user_account`（发送人账号，即 userId）、`user_name`、`msgtype`、`text`、
    `group_id`、`group_name`、`at_users`（数组或逗号串）、`data{msgid, msg_type, text, images[], image_ids[], file{name,url,file_id}, mixed[]}`、
    混排消息图片在 `body.extra.images` 平铺
  - 非 chat 事件（action 回调等）：原样进 `raw_payload`，字段在 extra 里（action/message/fields）
  - @提及检测：`at_users` 含 appid 或文本含 `@bot_name` / `@appid`
- 媒体：上传 `POST {base}/media/upload?appid=&secret=&type=image|file`（multipart 字段 `media`，
  `application/octet-stream`）→ `{errcode, media_id}`；获取 `POST {base}/media/fetch?appid=&secret=`
  body `{media_ids:[...]}` → `{media_url: {media_id: url}}`
- 连接管理：启动时 `test_connection` 一次性握手预检（15s 超时），401/403 认证失败熔断不重连；
  WS 断线指数退避重连 1s→30s，上限 100 次；Ping→Pong 应答

## 3. 实施方案（路线 A，用户已批准）

### 3.1 新增文件（skill 仓库 `src/adapters/tuitui/`）

| 文件 | 职责 |
|---|---|
| `src/adapters/tuitui-adapter.ts` | adapter 壳体：start/stop（WS 生命周期）、队列、群聊过滤、回调路由、send 分发、inlineButtons→卡片 |
| `src/adapters/tuitui/tuitui-api.ts` | HTTP 发送 API：sendText/sendLink/sendImage/sendFile/sendInteractive/modifyInteractive/uploadMedia/fetchMedia；URL 构造（appid/secret query） |
| `src/adapters/tuitui/tuitui-ws.ts` | WS 客户端：连接、逐事件 ACK、keepalive、指数退避重连、认证熔断、Ping/Pong、触发解析回调 |
| `src/adapters/tuitui/tuitui-types.ts` | 协议类型：WsEnvelope/WsBody/WsData/WsMixedItem/发送请求/响应 |
| `src/adapters/tuitui/tuitui-ids.ts` | chatId 编解码：`tuitui:<appid>:<single|group>:<target>` + 目标类型判定（全数字=群） |
| `src/__tests__/tuitui-api.test.ts` | HTTP 层单测（尽量不依赖网络：协议序列化/目标判定/错误分支） |
| `src/__tests__/tuitui-adapter.test.ts` | WS 解析单测：移植 Rust 用例（open 带/不带文本、keepalive）、@提及、inlineButtons→卡片序列化 |

### 3.2 修改文件

| 文件 | 改动 |
|---|---|
| skill `src/config.ts` | 新增 `CTI_TUITUI_APPID` / `CTI_TUITUI_SECRET` / `CTI_TUITUI_BOT_NAME` / `CTI_TUITUI_API_BASE`（默认 `https://alarm.im.qihoo.net`）/ `CTI_TUITUI_MEDIA_ENABLED` / `CTI_TUITUI_CARD_URL`（默认 `https://intent-os.qihoo.net`）；`enabledChannels` 支持 `tuitui`；`configToSettings` 映射 `bridge_tuitui_enabled`（及 media/card 设置） |
| skill `src/main.ts` | `import './adapters/tuitui-adapter.js';`（注册） |
| skill `package.json` | 新增 `ws` 依赖（Node 20 无内置 WebSocket；协议上对齐 Rust tokio-tungstenite 行为） |
| skill `README*.md` / `SKILL.md` | 渠道支持列表、配置项、权限卡片说明 |
| claude-to-im 包 `src/lib/bridge/types.ts` | `PLATFORM_LIMITS` 加 `tuitui: 4000` |
| claude-to-im 包 `src/lib/bridge/permission-broker.ts` | **零改动**（`qq`/`weixin` 文本特判为黑名单式，tuitui 自然走 inlineButtons 分支） |

说明：skill 与 claude-to-im 包均为本地可改源码，改动以本地分支维护（skill 在 `feature/tuitui-adapter` 分支）。

### 3.3 消息流设计

**入站（WS）**
1. WS 收到文本帧 → 解析信封 → 立即 ACK（任意事件含 keepalive，3s 窗口内）
2. `single_chat`/`group_chat`：提取 msg_type/text/图片/文件；`*_chat_open` 带文本归一为 text；
   群聊做 @提及过滤（at_users 或文本兜底），未提及 → 丢弃
3. 组 `InboundMessage`：`messageId = data.msgid`（缺省 `tuitui_<appid>_<seq>`）、
   `address = {channelType:'tuitui', chatId: 编码, userId: user_account, displayName: user_name}`、
   `attachments`（图片/文件下载成 FileAttachment）
4. 非 chat 事件（action 回调）：解析出 callbackData（action.value 中的 `perm:*` 数据）、
   原消息 msgid → 组 `InboundMessage{callbackData, callbackMessageId, chatId}` 交给 bridge-manager 的
   现成 `handlePermissionCallback` 路径；同时 adapter 调 `modifyInteractive` 把卡片更新为
   「已批准/已拒绝」状态（footer 展示授权利）

**出站**
- `send()`：解码 chatId → 取 appid + target → 全数字判定群/用户 → HTTP POST → `{ok, messageId=msgid}`
- `inlineButtons` 非空 → 发 `interactive` 卡片：body=文本（strip 掉 HTML 标签）、
  action 按钮照搬 `{text, value=callbackData}`，`name` 用 `perm_<permId>` 形式；记录 msgid → 权限链路
- 媒体出站：上传得 media_id → `msgtype: image|attachment`

**配置/生命周期**
- `validateConfig()`：无 appid/secret → 返回错误提示（对齐 Rust `validate_credentials`）
- `start()`：预检握手（失败打印明确错误）→ 起 WS 监听；同一 appid 幂等
- 断线重连参数对齐 Rust：退避 1s→30s、100 次上限、认证失败不重连

### 3.4 错误处理与安全
- secret/appid 从日志脱敏（复用 skill logger / 或 adapter 内 replace，对齐 Rust `redact_handshake_error`）
- 发送失败透传 `SendResult{ok:false, error}`；媒体下载失败按数量计入入站文本备注（对齐 weixin adapter）
- WS 解析失败只记 warn，不中断连接
- 群聊未 @提及消息不进入队列（不浪费 LLM 调用）

### 3.5 测试与验证
1. 单测（无网络）：WS 解析（移植 Rust 用例）、目标判定、ids 编解码、inlineButtons→卡片序列化、
   URL 构造（含自定义 API_BASE）
2. 构建：`npm install`（依赖：上游 Claude-to-IM 已克隆 + ws 包）→ `npm run typecheck` → `npm test`
3. 联调（真实凭据，本机）：
   - 单聊文本收发
   - 群聊 @提及收到、未提及忽略
   - 权限按钮：发卡片 → 点击允许 → 工具放行 → 卡片更新 + 卡片消息回执
   - 图片/文件：用户发图 Claude 能看、Claude 产出文件能下发
4. 生产部署（Linux Host）：克隆两个仓库 + npm install + supervisor/nohup 保活，
   CTI_HOME 指向持久化目录（对齐 skill 架构说明）

## 4. 里程碑（具体任务分解在 writing-plans 产出）
1. 依赖就位：确认 npm install 全绿（含 ws 包）
2. 协议层：types/ids/api/ws 四件套 + 单测
3. adapter 壳体 + 配置 + 注册 + 回调路径打通（含卡片审批）
4. 联调验证（真实推推凭据）
5. 文档 + 部署到 Linux Host

## 5. 风险与待联调确认项
- action 回调事件的实际字段名（action/message/fields 的 extra 结构）以联调报文为准（Rust 版按
  `body.extra` flatten 处理，双向适配）
- WS 事件投递语义：未 ACK 事件是否会重投（Rust 版未实现补偿，先对齐：ACK 失败即事件丢失，
  靠推推服务端重投保障——联调确认）
- 卡片 url/mobileurl 指向 intent-os.qihoo.net 是否影响点击体验（卡片按钮与 url 是独立点击区）