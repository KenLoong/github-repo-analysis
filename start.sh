#!/usr/bin/env bash
# 用法: ./start.sh [端口]   默认 8000
cd "$(dirname "$0")" || exit 1
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "已生成 config.json,请填入 github_token 和 deepseek_api_key 后重新运行。"
  exit 1
fi
exec python3 server.py "${1:-8000}"
