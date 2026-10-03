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
- 可执行 JAR 打包与 MySQL 模式启动通过；Compose 配置语法检查通过。
- Linux Docker 镜像：已从 Git 源码归档构建原生求解器；容器内 Java 测试发现并执行 36 项、成功 36，Node 测试发现并执行 20 项、成功 20，均无失败或跳过。镜像构建及原生程序动态库解析通过。
- 两个 GitHub Actions 工作流通过 actionlint 校验；部署脚本通过 Bash 语法检查；服务器 Caddy 合并配置通过 validate，并已取得对应公网 IP 的受信任证书。目标服务器应用验收、数据库备份恢复及 GitHub 实际工作流运行另行记录，生产业务验收仍待用户执行。

验证均使用隔离库存或临时数据库，不写入现有演示库存文件。部署前需在目标环境完成原生求解器、备份恢复和业务验收。

## Docker Compose 本机验证

1. 将 `.env.example` 复制为 `.env`，填写两个不同的强密码。
2. 执行 `docker compose up -d --build`，数据库首次创建后，应用自动建表。应用从空库存开始。
3. 默认仅发布服务器本机 `127.0.0.1:8080`；通过 SSH 隧道可先进行部署验收。

数据库数据保存在 `mysql-data` 命名卷。正常升级使用 `docker compose up -d --build`；不要删除数据卷。定期使用数据库备份工具备份，并在独立库演练恢复。修改 `.env` 中数据库初始化密码不会更改已有数据库账号密码。[MySQL 容器初始化说明](https://dev.mysql.com/doc/refman/8.4/en/docker-mysql-more-topics.html)

应用目前没有用户账号和权限系统。对外开放前，必须在入口反向代理接入身份认证与 HTTPS，并限制网络访问；不要直接公开应用端口。默认已移除任意跨域开放。MySQL 远程连接按服务器证书配置 `sslMode=VERIFY_IDENTITY` 等 TLS 参数，容器内网连接配置与远程生产连接分开管理。

Dockerfile 从固定的 PackingSolver 提交 `3f4faae1a4bc42e2276c5729878933010d37ca14` 构建 Linux 原生程序，并在同一系统版本下执行 Java 和 JavaScript 测试后打包。运行镜像已包含求解器与依赖许可证，不需要挂载 Windows `.exe` 或另行编译。仅横切工艺使用内置横切引擎。

## 阿里云 Linux 服务器

该服务器已有 Caddy 和其他业务，使用独立的 `/opt/cutdemo` 目录、Compose 项目和 MySQL 数据卷。`compose.server.yaml` 使用现有代理网络 `cpa_cpa-net`，应用别名为 `cutdemo-app`。MySQL 仅连接独立内部网络，没有宿主机端口；应用仅监听宿主机 `127.0.0.1:18080`。数据库限制 512 MiB，应用及原生求解子进程合计限制 768 MiB；2 GiB 主机上的复杂任务并发容量仍需业务验收。

首次部署步骤：

1. 在 `/opt/cutdemo` 保存 `compose.server.yaml` 和 `scripts/deploy-server.sh`（服务器上命名为 `deploy-server.sh`）。
2. 复制 `.env.server.example` 为该目录的 `.env`，生成独立数据库密码，权限设为 `600`。
3. 使用经过验证的镜像执行 `bash deploy-server.sh 'ghcr.io/owner/repo@sha256:完整摘要'`。首次离线传输镜像可使用 `cutdemo:git-完整提交号`。新库自动建表，不导入本机演示数据。
4. 备份现有 Caddyfile，再参考 `deploy/Caddyfile.ip.example` 合并配置并校验、平滑 reload。保留原有 HTTP 管理页面；裁切系统通过 `https://47.77.181.58` 访问。入口对整个站点及 API 使用 Basic Auth，密码哈希用 `caddy hash-password` 从标准输入生成，明文密码不放进仓库。

防火墙入站仅需 TCP 80、443 对网页客户端放行；22 保留 SSH 管理规则。不要公开 3306 或 18080。IP 证书使用 Let's Encrypt `shortlived` profile，由 Caddy 自动续期；80、443 需持续可达。[IP 证书说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)、[Caddy ACME 配置](https://caddyserver.com/docs/caddyfile/directives/tls)

每次后续部署在更新应用前备份数据库到 `backups/*-before-deploy.sql.gz`，备份失败即停止。服务器串行部署，容器健康检查通过后才记录 `.current-image` 和 `.previous-image`。同机备份还需要由运维定期复制到独立存储并限制访问。

回滚应用时先确认旧应用兼容当前数据库迁移，再将 `.previous-image` 的内容作为部署脚本参数。脚本不会自动倒退数据库结构或覆盖库存；需要数据恢复时，先恢复到独立数据库并校验，再安排切换，避免覆盖部署后新写入的业务数据。不要执行 `docker compose down -v`。

## GitHub Actions

`.github/workflows/image.yml` 在 `master` 推送、PR 和手动触发时构建 Linux 镜像，并执行镜像中的 Java、JavaScript 测试。非 PR 构建成功后发布到本仓库的 GHCR 包，以提交号标记并输出不可变摘要。推送 `v*` 标签时，构建通过后自动调用部署；普通 `master` 推送只发布镜像。也可手动运行 `Deploy` 工作流，指定本仓库镜像摘要。

启用前，在 GitHub 仓库创建 `production` Environment，并配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variables | `DEPLOY_HOST` | `47.77.181.58` |
| Variables | `DEPLOY_USER` | 具备该部署目录及 Docker 权限的专用部署账号 |
| Variables | `DEPLOY_PORT` | `22` |
| Secrets | `DEPLOY_SSH_KEY` | 专用部署私钥，对应公钥已配置在服务器 |
| Secrets | `DEPLOY_KNOWN_HOSTS` | 经过服务器控制台指纹核验的 known_hosts 条目 |

根据发布要求配置 Environment 审批及分支/标签限制。应用数据库密码只保存在服务器 `.env`，不由 CI 输出。私有 GHCR 镜像还需在服务器提前用仅读取包权限的令牌完成 `docker login ghcr.io`；构建工作流的 `GITHUB_TOKEN` 不会传给服务器。SSH 防火墙规则需允许选定 Actions runner 的出口地址。

部署工作流调用服务器已安装的部署脚本；修改 Compose 或部署脚本后，需先同步并核验这些文件，再发布新版本。本地工作流文件存在不代表 GitHub 已启用；只有推送代码、配置权限与 Secrets，并完成一次真实运行后，才能认定自动部署可用。

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
