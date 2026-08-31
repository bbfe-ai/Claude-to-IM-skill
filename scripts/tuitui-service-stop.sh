#!/usr/bin/env bash
# tuitui-service-stop.sh — 关闭推推 systemd 服务
# 用法: bash scripts/tuitui-service-stop.sh [服务名]    # 默认 claude-to-im-tuitui

set -euo pipefail
# shellcheck source=tuitui-service-common.sh
source "$(dirname "$0")/tuitui-service-common.sh"

ensure_root

if ! systemctl is-enabled "$SERVICE_NAME" >/dev/null 2>&1; then
  echo "服务 $SERVICE_NAME 未注册（无需停止）。"
  exit 0
fi

echo "==> 停止服务 $SERVICE_NAME ..."
systemctl stop "$SERVICE_NAME" || true

if systemctl is-active "$SERVICE_NAME" >/dev/null 2>&1; then
  echo "❌ 服务仍在运行，请检查: systemctl status $SERVICE_NAME"
  exit 1
fi
echo "✅ 服务已停止：$SERVICE_NAME（开机自启仍保留，可再启动）"