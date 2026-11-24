#!/usr/bin/env bash
# CutDemoTwo MySQL 定时备份脚本
#
# 功能：
#   1. 通过正在运行的 docker compose mysql 服务执行一致性逻辑导出（--single-transaction）；
#   2. 导出为 gzip 压缩包并使用 gzip -t 执行完整性校验，校验通过后原子落盘并生成 .sha256 摘要；
#   3. 自动清理超过 RETENTION_DAYS 天的历史定时备份文件。
#
# 用法示例：
#   bash scripts/backup-mysql.sh
#   RETENTION_DAYS=30 CUTDEMO_DEPLOY_DIR=/opt/cutdemo bash scripts/backup-mysql.sh
#
# Crontab 定时备份示例（每天凌晨 03:15 执行）：
#   15 3 * * * CUTDEMO_DEPLOY_DIR=/opt/cutdemo RETENTION_DAYS=14 /usr/bin/env bash /opt/cutdemo/scripts/backup-mysql.sh >> /opt/cutdemo/backups/backup.log 2>&1

set -Eeuo pipefail
umask 077

deploy_dir=${CUTDEMO_DEPLOY_DIR:-/opt/cutdemo}
compose_file=${COMPOSE_FILE:-compose.server.yaml}
env_file=${ENV_FILE:-.env}
backup_dir=${BACKUP_DIR:-"$deploy_dir/backups"}
retention_days=${RETENTION_DAYS:-14}
mysql_service=${MYSQL_SERVICE:-mysql}

if [[ ! "$retention_days" =~ ^[1-9][0-9]*$ ]]; then
  printf '错误：RETENTION_DAYS 必须为正整数，当前值：%s\n' "$retention_days" >&2
  exit 2
fi

cd "$deploy_dir"
if [[ ! -f "$compose_file" ]]; then
  printf '错误：未找到编排文件：%s/%s\n' "$deploy_dir" "$compose_file" >&2
  exit 2
fi
if [[ ! -s "$env_file" ]]; then
  printf '错误：环境文件不存在或为空：%s/%s\n' "$deploy_dir" "$env_file" >&2
  exit 2
fi

mkdir -p "$backup_dir"
exec 9>"$backup_dir/.backup.lock"
flock -n 9 || {
  printf '错误：已有另一份备份任务正在执行，本次退出。\n' >&2
  exit 3
}

compose=(docker compose --env-file "$env_file" -f "$compose_file")
mysql_id=$("${compose[@]}" ps -q "$mysql_service")
if [[ -z "$mysql_id" ]]; then
  printf '错误：未检测到运行中的 %s 容器。\n' "$mysql_service" >&2
  exit 4
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
final_file="$backup_dir/cutdemo-${timestamp}.sql.gz"
tmp_file="${final_file}.tmp"
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

printf '[%s] 开始备份 MySQL（容器 %s）...\n' "$timestamp" "$mysql_id"
docker exec "$mysql_id" sh -c \
  'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump -u"$MYSQL_USER" --single-transaction --routines --triggers --quick --no-tablespaces --default-character-set=utf8mb4 "$MYSQL_DATABASE"' \
  | gzip -c > "$tmp_file"

if [[ ! -s "$tmp_file" ]]; then
  printf '错误：导出的备份文件为空：%s\n' "$tmp_file" >&2
  exit 5
fi

if ! gzip -t "$tmp_file"; then
  printf '错误：gzip -t 完整性校验失败，已丢弃损坏临时文件。\n' >&2
  exit 6
fi

mv "$tmp_file" "$final_file"
trap - EXIT

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$final_file" > "${final_file}.sha256"
fi

removed_count=0
while IFS= read -r old_file; do
  rm -f "$old_file" "${old_file}.sha256"
  removed_count=$((removed_count + 1))
done < <(find "$backup_dir" -maxdepth 1 -type f -name 'cutdemo-*.sql.gz' -mtime +"$retention_days")

size_bytes=$(wc -c < "$final_file" | tr -d ' ')
printf '[%s] 备份完成：%s（%s 字节，gzip -t 校验通过；已清理超 %s 天旧备份 %s 份）\n' \
  "$(date -u +%Y%m%dT%H%M%SZ)" "$final_file" "$size_bytes" "$retention_days" "$removed_count"
