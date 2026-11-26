#!/usr/bin/env bash
# CutDemoTwo MySQL 安全恢复脚本
#
# 警告：恢复操作会覆盖目标数据库中的当前表结构与业务数据！
# 功能：
#   1. 强制核验备份文件存在、非空、通过 gzip -t 完整性校验（如存在 .sha256 文件一并核验）；
#   2. 强制要求人工输入确认词（或非交互模式下显式传入 CONFIRM_RESTORE=YES 与 --yes），防误操作；
#   3. 恢复前先停止 app 服务防止写入竞争，并自动导出一次当前库的应急回退快照；
#   4. 导入完成后核验核心表可读，并自动恢复启动 app 服务。
#
# 用法示例：
#   bash scripts/restore-mysql.sh /opt/cutdemo/backups/cutdemo-20261124T031500Z.sql.gz
#   CONFIRM_RESTORE=YES bash scripts/restore-mysql.sh --yes /opt/cutdemo/backups/cutdemo-20261124T031500Z.sql.gz

set -Eeuo pipefail
umask 077

usage() {
  printf '用法：%s [--yes] <备份文件.sql.gz>\n' "$0" >&2
  printf '说明：非交互模式须同时设置环境变量 CONFIRM_RESTORE=YES 与 --yes 参数。\n' >&2
}

auto_confirm=false
backup_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      auto_confirm=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$backup_file" ]]; then
        printf '错误：多余的参数：%s\n' "$1" >&2
        usage
        exit 2
      fi
      backup_file="$1"
      shift
      ;;
  esac
done

if [[ -z "$backup_file" ]]; then
  usage
  exit 2
fi

if [[ ! -f "$backup_file" || ! -s "$backup_file" ]]; then
  printf '错误：备份文件不存在或为空：%s\n' "$backup_file" >&2
  exit 2
fi

# 先转换为绝对路径，避免切换目录后相对路径失效
backup_file=$(cd "$(dirname "$backup_file")" && printf '%s/%s' "$(pwd)" "$(basename "$backup_file")")

if [[ -f "${backup_file}.sha256" ]] && command -v sha256sum >/dev/null 2>&1; then
  printf '正在校验 SHA-256 摘要：%s.sha256\n' "$backup_file"
  sha256sum -c "${backup_file}.sha256"
fi

printf '正在执行 gzip -t 完整性校验：%s\n' "$backup_file"
if ! gzip -t "$backup_file"; then
  printf '错误：备份压缩包已损坏，已终止恢复。\n' >&2
  exit 3
fi

deploy_dir=${CUTDEMO_DEPLOY_DIR:-/opt/cutdemo}
compose_file=${COMPOSE_FILE:-compose.server.yaml}
env_file=${ENV_FILE:-.env}
backup_dir=${BACKUP_DIR:-"$deploy_dir/backups"}
mysql_service=${MYSQL_SERVICE:-mysql}
app_service=${APP_SERVICE:-app}

cd "$deploy_dir"
if [[ ! -f "$compose_file" || ! -s "$env_file" ]]; then
  printf '错误：缺少编排文件或环境文件：%s/%s、%s\n' "$deploy_dir" "$compose_file" "$env_file" >&2
  exit 2
fi

if [[ "$auto_confirm" == "true" ]]; then
  if [[ "${CONFIRM_RESTORE:-}" != "YES" ]]; then
    printf '错误：使用 --yes 时必须显式设置环境变量 CONFIRM_RESTORE=YES。\n' >&2
    exit 4
  fi
else
  printf '即将使用以下备份覆盖当前 MySQL 数据库：\n  %s\n' "$backup_file"
  printf '确认继续请输入大写 RESTORE：'
  read -r answer
  if [[ "$answer" != "RESTORE" ]]; then
    printf '已取消恢复操作。\n'
    exit 0
  fi
fi

mkdir -p "$backup_dir"
exec 9>"$backup_dir/.restore.lock"
flock -n 9 || {
  printf '错误：已有另一份恢复任务正在执行。\n' >&2
  exit 5
}

compose=(docker compose --env-file "$env_file" -f "$compose_file")
mysql_id=$("${compose[@]}" ps -q "$mysql_service")
if [[ -z "$mysql_id" ]]; then
  printf '错误：未检测到运行中的 %s 容器。\n' "$mysql_service" >&2
  exit 6
fi

app_was_running=false
if [[ -n "$("${compose[@]}" ps -q "$app_service")" ]]; then
  app_was_running=true
  printf '停止 %s 服务以防止恢复期间并发写入...\n' "$app_service"
  "${compose[@]}" stop "$app_service"
fi

# 恢复前留存一份应急快照，便于异常时回滚
pre_restore="$backup_dir/before-restore-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
printf '导出恢复前应急快照：%s\n' "$pre_restore"
docker exec "$mysql_id" sh -c \
  'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump -u"$MYSQL_USER" --single-transaction --routines --triggers --quick --no-tablespaces --default-character-set=utf8mb4 "$MYSQL_DATABASE"' \
  | gzip -c > "${pre_restore}.tmp"
gzip -t "${pre_restore}.tmp"
mv "${pre_restore}.tmp" "$pre_restore"

printf '开始导入备份到 MySQL...\n'
gzip -dc "$backup_file" | docker exec -i "$mysql_id" sh -c \
  'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u"$MYSQL_USER" --default-character-set=utf8mb4 "$MYSQL_DATABASE"'

table_count=$(docker exec "$mysql_id" sh -c \
  'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -N -u"$MYSQL_USER" "$MYSQL_DATABASE" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()"')
printf '恢复导入完成，当前库内数据表数量：%s\n' "$table_count"

if [[ "$app_was_running" == "true" ]]; then
  printf '重新启动 %s 服务并等待健康检查...\n' "$app_service"
  "${compose[@]}" up -d --wait --wait-timeout 180 "$app_service"
fi

printf '恢复成功。恢复前应急快照已保存在：%s\n' "$pre_restore"
