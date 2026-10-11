#!/bin/bash
# 一键更新：拉取最新镜像并重启。首次部署也用它启动。
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "错误：当前目录没有 .env，请先按 env.production.example 创建"
  exit 1
fi
# 容器里的程序以 uid 1000 运行，需要能读到 .env；同时不让其他用户读
chown 1000:1000 .env
chmod 600 .env

echo "==> 拉取最新镜像"
docker compose pull

echo "==> 启动 / 重启服务"
docker compose up -d

echo "==> 清理不再使用的旧镜像"
docker image prune -f

echo "==> 等待服务就绪"
for i in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' gpt-topup 2>/dev/null || echo "unknown")
  if [ "$status" = "healthy" ]; then
    echo "服务已就绪"
    docker compose ps
    exit 0
  fi
  sleep 2
done

echo "服务在 60 秒内没有就绪，最近的日志："
docker compose logs --tail 40
exit 1
