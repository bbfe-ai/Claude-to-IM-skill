#!/usr/bin/env bash
# enable-systemd-tuitui.sh — 推推渠道 systemd 服务注册（开机自启）
#
# 前提: 已用 install-tuitui.sh 完成一键部署（dist/daemon.mjs 与 config.env 就绪）
# 用法:
#   bash scripts/enable-systemd-tuitui.sh [服务名]      # 默认服务名 claude-to-im-tuitui
# 环境:
#   CTI_SKILL_DIR    skill 仓库绝对路径（默认本脚本上级目录）
#   CTI_CTI_HOME     配置目录（默认 $HOME/.claude-to-im）
#   CTI_SYSTEMD_USER systemd 服务运行用户（默认当前系统用户）
#
# 流程: 前置检查 → 停掉 daemon.sh 管理的旧实例 → 写 systemd unit → enable+start → 校验 WS 连接
# 卸载: systemctl disable --now <服务名> && rm /etc/systemd/system/<服务名>.service

set -euo pipefail

SERVICE_NAME="${1:-claude-to-im-tuitui}"
SKILL_DIR="${CTI_SKILL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
CTI_HOME="${CTI_CTI_HOME:-$HOME/.claude-to-im}"
SERVICE_USER="${CTI_SYSTEMD_USER:-$USER}"
CONFIG_FILE="$CTI_HOME/config.env"
BRIDGE_LOG="$CTI_HOME/logs/bridge.log"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# 若无 root，自动用 sudo 重跑自己（保留环境参数）
if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root 权限写入 systemd 单元，使用 sudo 重新运行..."
  exec sudo env CTI_SKILL_DIR="$SKILL_DIR" CTI_CTI_HOME="$CTI_HOME" CTI_SYSTEMD_USER="$SERVICE_USER" \
    bash "$0" "$SERVICE_NAME"
fi

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

# ── 2. 停掉 daemon.sh 管理的旧实例（避免两个 WS 连接争抢事件） ──
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "==> 停止 daemon.sh 旧实例（PID $OLD_PID）..."
    kill "$OLD_PID" || true
    for _ in $(seq 1 10); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 1; done
    kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" || true
  fi
  rm -f "$PID_FILE"
fi

# ── 3. 写 systemd 单元 ──
echo "==> 写入 systemd 单元 $UNIT_FILE"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Claude-to-IM TuiTui bridge daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Environment=CTI_HOME=${CTI_HOME}
WorkingDirectory=${SKILL_DIR}
ExecStart=/usr/bin/env node dist/daemon.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ── 4. 启用并启动 ──
echo "==> 注册并启动服务..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 && echo "     已设置开机自启（enable）"
systemctl restart "$SERVICE_NAME"

# ── 5. 校验 WS 连接（最多 20 秒） ──
echo "==> 校验推推 WS 连接..."
FOUND=0
for _ in $(seq 1 20); do
  if grep -q "\[tuitui-ws\] 连接成功" "$BRIDGE_LOG" 2>/dev/null; then FOUND=1; break; fi
  sleep 1
done
if [ "$FOUND" = "1" ]; then
  echo ""
  echo "✅ systemd 服务已就绪，推推 WS 已连接，开机自启已启用。"
else
  echo ""
  echo "⚠️  20 秒内未在日志中看到推推 WS 连接成功。"
  echo "   查看: systemctl status $SERVICE_NAME"
  echo "   日志: journalctl -u $SERVICE_NAME -n 50"
  exit 1
fi

echo ""
echo "┌─ 服务管理 ──────────────────────────────────────────────"
echo "│ 状态:    systemctl status $SERVICE_NAME"
echo "│ 停止:    systemctl stop $SERVICE_NAME"
echo "│ 启动:    systemctl start $SERVICE_NAME"
echo "│ 重启:    systemctl restart $SERVICE_NAME"
echo "│ 自启:    已启用（systemctl disable $SERVICE_NAME 可关闭）"
echo "│ 日志:    journalctl -u $SERVICE_NAME -f"
echo "│ 配置:    $CONFIG_FILE"
echo "└──────────────────────────────────────────────────────────"
echo "详细文档: $SKILL_DIR/references/tuitui-usage.md"
