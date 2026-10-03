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

本次本地验证（2026-10-04）：

- Maven：发现并执行 36 项测试，成功 36、失败 0、错误 0、跳过 0；包含原生 C++ 求解、库存写入失败回滚、过期方案拒绝、报工撤回、数据库事务与版本冲突。数据库故障测试使用 H2 MySQL 兼容模式。
- Node：发现并执行 20 项测试，成功 20、失败 0、跳过 0，覆盖工作台、材料筛选和画布交互规则。
- 真实 MySQL 8.4.11：在独立临时容器中验证空库建表、空库存页面、母卷与任务写入、方案与参数持久化、报工、应用重启恢复、重复报工、撤回和重复撤回。测试母卷从 10,000 mm 扣至 7,000 mm，撤回后恢复 10,000 mm，任务完成量归零且原报工记录保留。
- 浏览器：验证方案取消与恢复、报工保存与撤回、设置保存反馈；修复了恢复方案后的统计显示和空库初始化错误。
- 可执行 JAR 打包与 MySQL 模式启动通过；Compose 配置语法检查通过。Docker 应用镜像、Linux 原生求解器、目标服务器部署、数据库备份恢复及生产业务验收尚未执行。

验证均使用隔离库存或临时数据库，不写入现有演示库存文件。部署前需在目标环境完成原生求解器、备份恢复和业务验收。

## Docker Compose 服务器模板

1. 将 `.env.example` 复制为 `.env`，填写两个不同的强密码，以及服务器上 Linux 求解器目录。
2. 执行 `docker compose up -d --build`，数据库首次创建后，应用自动建表。应用从空库存开始。
3. 默认仅发布服务器本机 `127.0.0.1:8080`；通过 SSH 隧道可先进行部署验收。

数据库数据保存在 `mysql-data` 命名卷。正常升级使用 `docker compose up -d --build`；不要删除数据卷。定期使用数据库备份工具备份，并在独立库演练恢复。修改 `.env` 中数据库初始化密码不会更改已有数据库账号密码。[MySQL 容器初始化说明](https://dev.mysql.com/doc/refman/8.4/en/docker-mysql-more-topics.html)

应用目前没有用户账号和权限系统。对外开放前，必须在入口反向代理接入身份认证与 HTTPS，并限制网络访问；不要直接公开应用端口。默认已移除任意跨域开放。MySQL 远程连接按服务器证书配置 `sslMode=VERIFY_IDENTITY` 等 TLS 参数，容器内网连接配置与远程生产连接分开管理。

容器需要 Linux 版 `packingsolver_rectangleguillotine`，Windows `.exe` 不能直接用于 Linux。可执行文件及其动态库需要与容器系统兼容，并允许应用用户读取和执行。Compose 模板不替代原生求解器构建，也没有静默降级成另一种排料算法。仅横切工艺使用内置横切引擎。

## Windows 原生求解器

通过环境变量 `PACKINGSOLVER_PATH` 指定可执行文件。WinLibs 构建通常需要同编译器版本的三份 DLL，与 exe 放在同一目录：`libgcc_s_seh-1.dll`、`libstdc++-6.dll`、`libwinpthread-1.dll`。仓库提供复制脚本，保留源文件且拒绝覆盖内容不同的目标文件：

```powershell
& ./scripts/prepare-windows-solver.ps1 -SolverExecutable 'D:/path/packingsolver_rectangleguillotine.exe' -RuntimeDirectory 'C:/path/mingw64/bin'
./mvnw.cmd spring-boot:run
```

脚本设置当前 PowerShell 会话的 `PACKINGSOLVER_PATH`。服务管理器或服务器重启后仍需在相应服务环境中配置此变量。健康接口的 `packingsolverAvailable` 只表示文件可执行，实际运行库是否齐全以一次真实排料为准。求解预算为 1–60 秒，额外保留 5 秒退出时间；超过后终止子进程且不写库存。

## 撤回与设置口径

- “方案记录”保存未报工方案；可取消、重启后恢复。恢复会重新检查任务、库存和疵点，失效方案需要重新排料。
- “报工记录 → 撤回报工”退回库存和任务完成量，保留原记录、撤回时间和原因。母卷按报工倒序撤回；派生料头已加工、报废或修改时先处理后续操作。升级前缺少撤回快照的旧报工不能自动撤回。
- 撤回用于纠正误报，不能将已经裁开的布料物理还原。本版本没有任意档案编辑的通用撤销历史，料头报废也没有自动撤销入口。
- “清理排料”仅清除未报工预览，已报工库存和完成量保留。
- 工艺与显示设置保存在当前浏览器。回收尺寸和求解时限随每个新方案发送、持久保存，报工使用该方案原参数；默认避疵余量用于新添疵点，已有档案疵点保留原设置。
