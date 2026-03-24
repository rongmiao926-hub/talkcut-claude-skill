#!/bin/bash
#
# 兼容入口：统一转调到 Node.js 版本，避免 shell 旧逻辑和主实现分叉。
#
# 用法: ./cut_video.sh <input.mp4> <delete_segments.json> [output.mp4]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec node "$SCRIPT_DIR/cut_video.js" "$@"
