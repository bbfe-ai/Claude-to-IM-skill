#!/usr/bin/env bash
# tuitui-service-start.sh — 启动推推 systemd 服务
# 用法: bash scripts/tuitui-service-start.sh [服务名]    # 默认 claude-to-im-tuitui

set -euo pipefail
# shellcheck source=tuitui-service-common.sh
source "$(dirname "$0")/tuitui-service-common.sh"

ensure_root

if ! systemctl is-enabled "$SERVICE_NAME" >/dev/null 2>&1; then
  echo "服务 $SERVICE_NAME 未注册，请先运行: bash $SKILL_DIR/scripts/tuitui-service-create.sh"
  exit 1
fi

echo "==> 启动服务 $SERVICE_NAME ..."
systemctl start "$SERVICE_NAME"

echo "==> 校验推推 WS 连接..."
wait_ws_connected
echo "✅ 服务已启动：$SERVICE_NAME"
print_management_hint