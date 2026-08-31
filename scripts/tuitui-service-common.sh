#!/usr/bin/env bash
# tuitui-service-common.sh — 推推 systemd 服务脚本族的公共逻辑（被 create/start/stop 脚本 source）
# 配置:
#   服务名默认 claude-to-im-tuitui（第一参数），可用 CTI_SYSTEMD_SERVICE 覆盖
#   CTI_SKILL_DIR / CTI_CTI_HOME / CTI_SYSTEMD_USER 可覆盖默认路径与运行用户

SERVICE_NAME="${CTI_SYSTEMD_SERVICE:-${1:-claude-to-im-tuitui}}"
SKILL_DIR="${CTI_SKILL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CTI_HOME="${CTI_CTI_HOME:-$HOME/.claude-to-im}"
SERVICE_USER="${CTI_SYSTEMD_USER:-$USER}"
CONFIG_FILE="$CTI_HOME/config.env"
BRIDGE_LOG="$CTI_HOME/logs/bridge.log"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# 非 root 时用 sudo 重跑自己（保留参数、环境配置与 PATH——node 可能在 nvm 等非标准路径）
ensure_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "需要 root 权限，使用 sudo 重新运行..."
    exec sudo env PATH="$PATH" CTI_SKILL_DIR="$SKILL_DIR" CTI_CTI_HOME="$CTI_HOME" \
      CTI_SYSTEMD_USER="$SERVICE_USER" CTI_SYSTEMD_SERVICE="$SERVICE_NAME" \
      bash "$0" "$SERVICE_NAME"
  fi
}

# 停掉 daemon.sh 管理的旧实例（避免两个 WS 连接争抢事件）
stop_daemon_sh_instance() {
  if [ -f "$PID_FILE" ]; then
    local old_pid
    old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "==> 停止 daemon.sh 旧实例（PID $old_pid）..."
      kill "$old_pid" || true
      for _ in $(seq 1 10); do kill -0 "$old_pid" 2>/dev/null || break; sleep 1; done
      if kill -0 "$old_pid" 2>/dev/null; then kill -9 "$old_pid" || true; fi
    fi
    rm -f "$PID_FILE"
  fi
}

# 等待日志出现 WS 连接成功（最多 20 秒；base_line 为调用前日志行数，只查新增部分）
wait_ws_connected() {
  local base_line="${1:-0}" found=0
  for _ in $(seq 1 20); do
    if [ -f "$BRIDGE_LOG" ]; then
      if tail -n +$((base_line + 1)) "$BRIDGE_LOG" 2>/dev/null | grep -q "\[tuitui-ws\] 连接成功"; then found=1; break; fi
    fi
    sleep 1
  done
  if [ "$found" = "1" ]; then
    echo "✅ 推推 WS 已连接。"
    return 0
  fi
  echo "⚠️  20 秒内未在日志中看到推推 WS 连接成功。"
  echo "   查看: systemctl status $SERVICE_NAME"
  echo "   日志: journalctl -u $SERVICE_NAME -n 50"
  return 1
}

# node 绝对路径（systemd 环境 PATH 不含 nvm 等自定义路径，ExecStart 必须用绝对路径）
node_bin() {
  command -v node || { echo "错误: 未找到 node，请确认 Node >= 20 已安装"; exit 1; }
}

print_management_hint() {
  echo ""
  echo "┌─ 服务管理 ──────────────────────────────────────────────"
  echo "│ 状态:    systemctl status $SERVICE_NAME"
  echo "│ 停止:    systemctl stop $SERVICE_NAME       （或 bash $SKILL_DIR/scripts/tuitui-service-stop.sh）"
  echo "│ 启动:    systemctl start $SERVICE_NAME       （或 bash $SKILL_DIR/scripts/tuitui-service-start.sh）"
  echo "│ 重启:    systemctl restart $SERVICE_NAME"
  echo "│ 自启:    已启用（systemctl disable $SERVICE_NAME 可关闭）"
  echo "│ 日志:    journalctl -u $SERVICE_NAME -f"
  echo "│ 配置:    $CONFIG_FILE"
  echo "└──────────────────────────────────────────────────────────"
  echo "详细文档: $SKILL_DIR/references/tuitui-usage.md"
}