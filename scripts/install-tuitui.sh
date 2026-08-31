#!/usr/bin/env bash
# install-tuitui.sh — 推推渠道一键部署脚本
#
# 流程: 环境检查 → 上游依赖准备 → 配置生成 → 构建 → 启动 → 校验 WS 连接
# 关闭/状态/日志: 复用 scripts/daemon.sh stop|status|logs
#
# 用法:
#   bash scripts/install-tuitui.sh [--interactive] [--auto-approve] [--workdir DIR] [--cti-home DIR]
#
# 凭据来源优先级: 环境变量 > 已有 config.env > 交互式输入(--interactive)
#   环境变量: CTI_TUITUI_APPID / CTI_TUITUI_SECRET / CTI_TUITUI_BOT_NAME
#   CTI_HOME 默认 ~/.claude-to-im；可用 --cti-home 或 CTI_HOME 环境变量覆盖
#
# 示例:
#   CTI_TUITUI_APPID=3433149389 CTI_TUITUI_SECRET=xxx CTI_TUITUI_BOT_NAME=Claude助手 \
#     bash scripts/install-tuitui.sh --auto-approve --workdir /data/agent-workspace

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export CTI_HOME="${CTI_HOME:-$HOME/.claude-to-im}"
CONFIG_FILE="$CTI_HOME/config.env"
BRIDGE_LOG="$CTI_HOME/logs/bridge.log"

INTERACTIVE=0
AUTO_APPROVE=0
WORKDIR=""

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

[ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] && usage

# ── 参数解析 ──
while [ $# -gt 0 ]; do
  case "$1" in
    --interactive) INTERACTIVE=1 ;;
    --auto-approve) AUTO_APPROVE=1 ;;
    --workdir) WORKDIR="${2:-}"; shift ;;
    --cti-home) CTI_HOME="${2:-}"; shift ;;
    *) echo "未知参数: $1"; usage 1 ;;
  esac
  shift
done

CONFIG_FILE="$CTI_HOME/config.env"
BRIDGE_LOG="$CTI_HOME/logs/bridge.log"

# ── 1. 环境检查 ──
echo "==> 检查环境..."
command -v node >/dev/null 2>&1 || { echo "错误: 需要 Node.js >= 20"; exit 1; }
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 20 ] || { echo "错误: Node.js 版本过低 ($(node -v))，需要 >= 20"; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "错误: 未找到 claude CLI（Claude Code），请先安装并完成认证"; exit 1; }
echo "     Node $(node -v) / Claude $(claude --version 2>/dev/null | head -1 || echo "已安装")"

# ── 2. 上游依赖准备 ──
echo "==> 检查依赖..."
UPSTREAM_DIR="$SKILL_DIR/../Claude-to-IM"
if [ -d "$SKILL_DIR/node_modules/claude-to-im" ]; then
  echo "     依赖已就绪（node_modules/claude-to-im 存在）"
elif [ -d "$UPSTREAM_DIR" ]; then
  echo "     上游仓库 $UPSTREAM_DIR 存在，执行 npm install..."
  (cd "$SKILL_DIR" && npm install)
else
  echo "     克隆上游 claude-to-im 依赖 $UPSTREAM_DIR ..."
  git clone --depth 1 https://github.com/op7418/Claude-to-IM "$UPSTREAM_DIR"
  (cd "$SKILL_DIR" && npm install)
fi

# ── 3. 配置生成 ──
echo "==> 配置 ($CTI_HOME/config.env)"
mkdir -p "$CTI_HOME"
touch "$CONFIG_FILE"

# 已存在的键不覆盖，缺失的补默认
append_if_missing() { grep -q "^$1=" "$CONFIG_FILE" || echo "$1=$2" >> "$CONFIG_FILE"; }
append_if_missing CTI_RUNTIME claude
append_if_missing CTI_ENABLED_CHANNELS tuitui
append_if_missing CTI_DEFAULT_WORKDIR "${WORKDIR:-$HOME/agent-workspace}"
if [ "$AUTO_APPROVE" = "1" ]; then append_if_missing CTI_AUTO_APPROVE true; fi
append_if_missing CTI_TUITUI_API_BASE https://alarm.im.qihoo.net
append_if_missing CTI_TUITUI_CARD_URL https://intent-os.qihoo.net
append_if_missing CTI_TUITUI_MEDIA_ENABLED true

# 凭据: 已有配置 > 环境变量 > 交互式
ask_cred() {
  local key="$1" prompt="$2" value="${3:-}"
  grep -q "^$key=" "$CONFIG_FILE" && return 0
  if [ -z "$value" ]; then
    if [ "$INTERACTIVE" = "1" ]; then
      read -r -p "$prompt: " value
    else
      echo "缺少凭据: $key（可用 $key 环境变量传入，或加 --interactive 交互式输入）"
      exit 1
    fi
  fi
  echo "$key=$value" >> "$CONFIG_FILE"
}
ask_cred CTI_TUITUI_APPID "推推 App ID" "${CTI_TUITUI_APPID:-}"
ask_cred CTI_TUITUI_SECRET "推推 Secret" "${CTI_TUITUI_SECRET:-}"
ask_cred CTI_TUITUI_BOT_NAME "机器人名" "${CTI_TUITUI_BOT_NAME:-}"
chmod 600 "$CONFIG_FILE"

grep -q "^CTI_TUITUI_APPID=." "$CONFIG_FILE" || { echo "错误: config.env 缺少 CTI_TUITUI_APPID"; exit 1; }
grep -q "^CTI_TUITUI_SECRET=." "$CONFIG_FILE" || { echo "错误: config.env 缺少 CTI_TUITUI_SECRET"; exit 1; }

# ── 4. 构建 ──
echo "==> 构建 daemon bundle..."
(cd "$SKILL_DIR" && npm run build)

# ── 5. 启动（复用 daemon.sh；已在运行则跳过） ──
echo "==> 启动 bridge..."
# 注意: 不用 grep -q 管道判断（grep -q 提前退出会让上游进程 SIGPIPE，pipefail 下误判失败）
STATUS_OUT="$(bash "$SKILL_DIR/scripts/daemon.sh" status 2>/dev/null || true)"
if printf '%s' "$STATUS_OUT" | grep -q "Bridge process is running"; then
  echo "     bridge 已在运行，跳过启动"
else
  if ! bash "$SKILL_DIR/scripts/daemon.sh" start; then
    echo "启动失败。诊断: bash \"$SKILL_DIR/scripts/doctor.sh\""
    exit 1
  fi
fi

# ── 6. 校验 WS 连接（最多 20 秒） ──
echo "==> 校验推推 WS 连接..."
FOUND=0
for _ in $(seq 1 20); do
  if grep -q "\[tuitui-ws\] 连接成功" "$BRIDGE_LOG" 2>/dev/null; then FOUND=1; break; fi
  sleep 1
done
if [ "$FOUND" = "1" ]; then
  echo ""
  echo "✅ 部署成功！推推 WS 已连接。"
else
  echo ""
  echo "⚠️  20 秒内未在日志中看到推推 WS 连接成功。"
  echo "   检查: bash \"$SKILL_DIR/scripts/daemon.sh\" logs 50"
  echo "   诊断: bash \"$SKILL_DIR/scripts/doctor.sh\""
  exit 1
fi

echo ""
echo "┌─ 使用说明 ─────────────────────────────────────────────"
echo "│ 启动:    bash $SKILL_DIR/scripts/daemon.sh start"
echo "│ 停止:    bash $SKILL_DIR/scripts/daemon.sh stop"
echo "│ 状态:    bash $SKILL_DIR/scripts/daemon.sh status"
echo "│ 日志:    bash $SKILL_DIR/scripts/daemon.sh logs 100"
echo "│ 配置:    $CONFIG_FILE"
echo "│ 工作目录: $(grep '^CTI_DEFAULT_WORKDIR=' "$CONFIG_FILE" | head -1 | cut -d= -f2-)"
echo "│ 权限:    $(grep -q '^CTI_AUTO_APPROVE=true' "$CONFIG_FILE" && echo '自动审批（CTI_AUTO_APPROVE=true）' || echo '卡片审批（点允许/拒绝）')"
echo "└─────────────────────────────────────────────────────────"
echo "详细文档: $SKILL_DIR/references/tuitui-usage.md"