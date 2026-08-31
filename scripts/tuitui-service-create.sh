#!/usr/bin/env bash
# tuitui-service-create.sh — 创建推推 systemd 服务（注册 + 开机自启 + 首次启动）
#
# 前提: 已用 install-tuitui.sh 完成一键部署（dist/daemon.mjs 与 config.env 就绪）
# 用法: bash scripts/tuitui-service-create.sh [服务名]    # 默认 claude-to-im-tuitui
# 卸载: systemctl disable --now <服务名> && rm /etc/systemd/system/<服务名>.service

set -euo pipefail
# shellcheck source=tuitui-service-common.sh
source "$(dirname "$0")/tuitui-service-common.sh"

# ── 1. 前置检查 ──
echo "==> 检查前置条件..."
command -v node >/dev/null 2>&1 || { echo "错误: 需要 Node.js >= 20"; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "错误: 未找到 claude CLI（Claude Code）"; exit 1; }
[ -f "$SKILL_DIR/dist/daemon.mjs" ] || { echo "错误: 未找到 $SKILL_DIR/dist/daemon.mjs，请先运行 install-tuitui.sh 完成构建"; exit 1; }
[ -f "$CONFIG_FILE" ] || { echo "错误: 未找到 $CONFIG_FILE，请先运行 install-tuitui.sh 生成配置"; exit 1; }
grep -q "^CTI_TUITUI_APPID=." "$CONFIG_FILE" || { echo "错误: config.env 缺少 CTI_TUITUI_APPID"; exit 1; }
grep -q "^CTI_TUITUI_SECRET=." "$CONFIG_FILE" || { echo "错误: config.env 缺少 CTI_TUITUI_SECRET"; exit 1; }
chmod 600 "$CONFIG_FILE"
echo "     Node $(node -v) / 配置 $CONFIG_FILE / 运行用户 $SERVICE_USER"

ensure_root

# ── 2. 停掉 daemon.sh 旧实例 ──
stop_daemon_sh_instance

# ── 3. 写 systemd 单元 ──
NODE_BIN="$(node_bin)"
# systemd 默认 PATH 不含 nvm 等自定义路径——把当前 shell 的 PATH 固化进 unit（node/claude 都能找到）
SERVICE_PATH="$PATH"
LOG_BASE_LINE=$(wc -l < "$BRIDGE_LOG" 2>/dev/null || echo 0)
echo "==> 写入 systemd 单元 $UNIT_FILE（node: $NODE_BIN）"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Claude-to-IM TuiTui bridge daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Environment=CTI_HOME=${CTI_HOME}
Environment=PATH=${SERVICE_PATH}
# 清空会话级模型覆盖（settings.json 注入的 ANTHROPIC_MODEL 会让 CLI -p 报 unrecognized_model 后退出）
Environment=ANTHROPIC_MODEL=
Environment=CLAUDE_CODE_SUBAGENT_MODEL=
WorkingDirectory=${SKILL_DIR}
ExecStart=${NODE_BIN} dist/daemon.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ── 4. 注册并启动 ──
echo "==> 注册并启动服务..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 && echo "     已设置开机自启（enable）"
systemctl restart "$SERVICE_NAME"

# ── 5. 校验 WS 连接（只看本次启动后的新日志） ──
echo "==> 校验推推 WS 连接..."
if wait_ws_connected "$LOG_BASE_LINE"; then
  echo "✅ 服务创建完成：$SERVICE_NAME（开机自启已启用）"
else
  exit 1
fi
print_management_hint