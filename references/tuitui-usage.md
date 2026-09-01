# 推推（TuiTui）渠道使用说明

将 Claude Code 接入公司内网 IM 推推（`alarm.im.qihoo.net`）：单聊、群聊（@机器人）、interactive 卡片权限审批、入站图片/文件。

## 一、一键部署

```bash
# 1. 准备好 skill 仓库（克隆后可任意目录）
git clone https://github.com/bbfe-ai/Claude-to-IM-skill.git
cd Claude-to-IM-skill

# 2. 一键部署（凭据从环境变量传入，非交互）
CTI_TUITUI_APPID=<App ID> CTI_TUITUI_SECRET=<Secret> CTI_TUITUI_BOT_NAME=<机器人名> \
  bash scripts/install-tuitui.sh --auto-approve --workdir /data/agent-workspace

# 交互式引导（凭据逐个输入）
bash scripts/install-tuitui.sh --interactive
```

脚本自动完成：环境检查（Node>=20、claude CLI）→ 上游依赖准备（`../Claude-to-IM` 自动克隆/`npm install`）→
生成 `config.env`（`CTI_HOME` 默认 `~/.claude-to-im`）→ 构建 bundle → 复用 `daemon.sh start` 启动 →
校验日志出现 `[tuitui-ws] 连接成功`。

常用参数：

| 参数 | 说明 |
|---|---|
| `--interactive` | 凭据交互式输入（否则需环境变量） |
| `--auto-approve` | 工具权限自动审批，不弹卡片 |
| `--workdir DIR` | Claude 工作目录（默认 `~/agent-workspace`） |
| `--cti-home DIR` | 配置目录（默认 `~/.claude-to-im`，可用 `CTI_HOME` 环境变量等效） |

## 二、日常管理（复用 daemon.sh）

```bash
bash scripts/daemon.sh start      # 启动
bash scripts/daemon.sh stop       # 停止
bash scripts/daemon.sh status     # 状态
bash scripts/daemon.sh logs 100   # 最近 100 行日志
bash scripts/doctor.sh            # 诊断
```

### systemd 服务（推荐生产形态，创建/启动/关闭三脚本）

```bash
bash scripts/tuitui-service-create.sh              # 创建服务: 注册 + 开机自启 + 首次启动（默认服务名 claude-to-im-tuitui）
bash scripts/tuitui-service-start.sh               # 启动服务
bash scripts/tuitui-service-stop.sh                # 关闭服务
bash scripts/tuitui-service-create.sh my-tuitui    # 自定义服务名（三个脚本同一参数）
systemctl status claude-to-im-tuitui               # 状态
journalctl -u claude-to-im-tuitui -f               # 实时日志
systemctl disable claude-to-im-tuitui              # 关闭开机自启（服务仍可用 start 拉起）
```

创建脚本会自动：检查前置（需先跑过 `install-tuitui.sh`）→ 停掉 daemon.sh 管理的旧实例（避免双连接）→
写 `/etc/systemd/system/<服务名>.service`（以当前用户运行，`Restart=on-failure` 崩溃自动拉起）→ enable+start → 校验 WS 连接。
非 root 执行时自动 sudo 重跑。

**说明：daemon 监听 0 个端口**——纯出站连接（WSS/HTTP 到推推），无任何入站监听，系统里不会多出端口。

## 三、配置项（config.env）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `CTI_ENABLED_CHANNELS` | 是 | — | 含 `tuitui` 即启用推推渠道 |
| `CTI_TUITUI_APPID` | 是 | — | 推推应用 App ID |
| `CTI_TUITUI_SECRET` | 是 | — | 推推应用 Secret（chmod 600，日志自动脱敏） |
| `CTI_TUITUI_BOT_NAME` | 否 | — | 机器人名，群聊 @提及检测 |
| `CTI_TUITUI_API_BASE` | 否 | `https://alarm.im.qihoo.net` | 发送 API 基础地址 |
| `CTI_TUITUI_MEDIA_ENABLED` | 否 | `false` | 入站图片/文件下载（=true 时落盘 `工作目录/.codepilot-uploads/`；`install-tuitui.sh` 一键部署会写入 `true`） |
| `CTI_TUITUI_CARD_URL` | 否 | `https://intent-os.qihoo.net` | 权限卡片跳转地址 |
| `CTI_AUTO_APPROVE` | 否 | `false` | `true` = 工具权限自动审批，不弹卡片 |
| `CTI_DEFAULT_WORKDIR` | 否 | `cwd` | Claude 工作目录 |
| `CTI_DEFAULT_MODEL` | 否 | CLI 默认 | 模型覆盖 |

## 四、权限模式

- **卡片审批（默认）**：Claude 要调用工具时，推推里弹出中文 interactive 卡片（允许 / 允许本次会话 / 拒绝）。
  点按钮后卡片更新为「已批准/已拒绝」。5 分钟未响应自动拒绝。
- **自动审批**：`CTI_AUTO_APPROVE=true`，全部工具放行，适合个人可控环境。

## 五、CLAUDE.md 与 Skill 集成

桥接会话就是标准 Claude Code CLI 会话：

- **CLAUDE.md**：放在 `CTI_DEFAULT_WORKDIR` 下（及上级目录链），或用户级 `~/.claude/CLAUDE.md` 都会被加载
- **Skills**：工作目录 `.claude/skills/` 与用户级 `~/.claude/skills/` 下的 skill 可被发现在 IM 里使用
- 即：把工作目录指到带 `CLAUDE.md` 的项目目录，桥接的 Claude 就按该项目约定干活

## 六、故障排查

| 现象 | 处理 |
|---|---|
| 日志无 `[tuitui-ws] 连接成功` | `daemon.sh logs 50` 看预检错误；401/403 = App ID/Secret 错误；超时 = 网络不通 `alarm.im.qihoo.net` |
| 群聊不响应 | 必须 @机器人；检查 `CTI_TUITUI_BOT_NAME` 与推推里的机器人名一致 |
| 权限卡片点了没反应 | 设置 `CTI_TUITUI_DEBUG=true` 后回看日志 `callback frame`；msgid 必须与卡片发送响应一致（联调已验证） |
| 图片没到 Claude | 确认 `CTI_TUITUI_MEDIA_ENABLED=true`；设 `CTI_TUITUI_DEBUG=true` 后日志 `media chat frame` 看帧类型；纯图片消息应走 `msgtype:"image"`；下载失败会收到「Failed to download N attachment(s)」回复并可查 `下载失败` 日志 |
| 启动后 WS 连不上 | 由客户端指数退避重连（2s→30s，最多 100 次）；401/403 = App ID/Secret 错误会熔断并停止重连 |

## 七、Windows 使用（PowerShell）

前置：安装 **Node.js >= 20**、**Claude Code CLI**、**Git**（Git Bash 可选）。

```powershell
# 一键安装（环境检查 → 依赖准备 → 配置生成 → 构建 → 启动 → 校验 WS 连接）
powershell -ExecutionPolicy Bypass -File scripts\install-tuitui-win.ps1
# 凭据来自(优先级): 已有 config.env > 环境变量 > -Interactive 交互式输入
# 常用参数: -AutoApprove（自动审批）, -Workdir DIR, -Interactive, -CtiHome DIR

# cmd 统一入口（bat，推荐日常使用）
scripts\tuitui.bat install [-AutoApprove] [-Workdir DIR] [-Interactive]
scripts\tuitui.bat start | stop | status | logs 100
scripts\tuitui.bat install-service | uninstall-service

# 或直接用 PowerShell 版管理脚本
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 start|stop|status|logs 100
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 install-service   # 开机自启（WinSW/NSSM）
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 uninstall-service
```

说明：
- 配置默认在 `%USERPROFILE%\.claude-to-im\config.env`（与 Linux 同一套 `CTI_*` 变量）
- 依赖仓库默认克隆 `https://github.com/bbfe-ai/Claude-to-IM`，可用环境变量 `CTI_UPSTREAM_REPO` 覆盖
- 推推支持在 Git Bash 下用 `install-tuitui.sh` 安装 + `daemon.sh` 管理（脚本检测 Windows 自动委托 PowerShell）

## 八、生产部署（Linux Host 示例）

```bash
# 1. 克隆与一键部署
git clone https://github.com/bbfe-ai/Claude-to-IM-skill.git /opt/claude-to-im-skill
CTI_TUITUI_APPID=... CTI_TUITUI_SECRET=... CTI_TUITUI_BOT_NAME=... CTI_HOME=/var/lib/claude-to-im \
  bash /opt/claude-to-im-skill/scripts/install-tuitui.sh --auto-approve --workdir /data/agent-workspace

# 2. 开机自启（supervisor 或 systemd；daemon.sh 的 start 已内含 supervisor-linux.sh 逻辑）
# 3. 日常: bash /opt/claude-to-im-skill/scripts/daemon.sh {start|stop|status|logs}
```

**注意**：daemon 机器需能访问 `wss://alarm.im.qihoo.net` 与 `https://im.live.360.cn`（媒体下载域名，内网）。

## 九、已知限制

- 出站媒体（Claude 主动发图片/文件给用户）暂不支持——框架消息模型为文本
- 权限卡片回调依赖 msgid 一致性（已按联调实测校准）
- 多推推应用并行（单账号模式）