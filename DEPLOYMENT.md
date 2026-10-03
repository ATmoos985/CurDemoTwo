# 数据存储与部署

默认继续使用 `data/cutdemo-state.json`，适合本机单进程演示。文件模式不支持多个进程共用同一文件。服务器使用 MySQL；两种模式共享报工校验和事务边界。

## 初始化 MySQL

先由数据库管理员创建一个专用空库和应用账号。示例建库语句：

```sql
CREATE DATABASE cutdemo CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
```

应用账号需要此库的 SELECT、INSERT、UPDATE、DELETE、CREATE、ALTER、INDEX 权限，以运行版本化建表迁移。不要配置生产业务库或 root 账号。运行环境要求 MySQL 使用 InnoDB 事务引擎。

配置以下环境变量后启动：

```text
SPRING_PROFILES_ACTIVE=mysql
CUTDEMO_DB_URL=jdbc:mysql://mysql-host:3306/cutdemo?characterEncoding=UTF-8&connectionTimeZone=Asia/Taipei
CUTDEMO_DB_USER=cutdemo
CUTDEMO_DB_PASSWORD=<由部署环境提供>
```

```bash
java -jar target/CutDemoTwo-0.0.1-SNAPSHOT.jar
```

首次启动自动执行 `db/migration` 中的 Flyway 迁移；重复启动只应用尚未执行的版本，不会清空库。MySQL 空库默认不创建演示库存，请从母卷档案登记材料。修改连接配置后重启即可连接另一个库；切换连接不会自动复制旧库数据。

母卷、料头、任务、方案和报工回执分别存表，保留可检索业务列和完整 JSON 载荷。一次命令的所有表变更在同一事务内提交；版本冲突返回 HTTP 409，客户端需刷新后重试。当前实现按库存整体版本协调写入，适合演示和小规模使用，尚未做大规模并发容量验收。

## 导入已有文件库存

停止原文件模式实例，备份 JSON 文件，确认目标是专用空库。仅首次启动 MySQL 实例时增加：

```text
--cutdemo.import-file=/absolute/path/cutdemo-state.json
```

导入不修改源文件，目标已有数据时拒绝覆盖。成功后移除此参数再正常启动。导入是一次性复制，文件模式与 MySQL 不会双向同步。历史版本仅存在内存中的未报工方案无法找回；升级后的方案会持久保存。

## 验证范围

数据库事务、版本冲突、迁移重复执行、一次性导入和多实例幂等报工有自动测试覆盖（H2 MySQL 兼容模式）。这不等于真实 MySQL、目标服务器或生产业务验收。部署前应对专用测试库验证连接、备份恢复和本机求解器运行环境。
