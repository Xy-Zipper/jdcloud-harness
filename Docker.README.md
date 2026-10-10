---
description: "构建并部署使用 Ontology 身份、权限与业务工具的 Harness Web 服务。"
---

# Ontology Harness Docker 部署

本部署只启用 `ontology-login` Bundle。Ontology Runtime 是应用身份、权限与业务数据的唯一权威；每个浏览器持有独立登录状态，同一 Ontology 用户在不同浏览器中共享稳定的 Session 与 Workspace 归属。

## 1. 部署前提

- Ontology Runtime 已通过 HTTPS 对 Harness 服务器开放，生产环境不能使用明文 HTTP。
- Runtime 防火墙、安全组或反向代理只允许 Harness 服务器等受信任来源访问 `/api/runtime/`。
- Harness 容器信任 Runtime 的 TLS 证书链；私有 CA 必须以只读文件挂载到容器并通过 Node 信任配置加载。
- 服务器是 Linux `amd64`，已安装 Docker Engine 与 Compose v2。
- 部署目录中的 `data/` 会挂载为 `DSH_HOME`，必须持久化且只能由容器运行用户读取。

## 2. 本地构建并导出

在项目根目录的 PowerShell 中执行：

```powershell
cd D:\WebstormProjects\jdcloud-harness

$Env:DSH_CLIENT_COMMIT_HASH = (git rev-parse HEAD).Trim()
docker compose build jdcloud-harness
docker pull caddy:2-alpine
docker image save -o .\jdcloud-harness.tar jdcloud-harness:local caddy:2-alpine
```

镜像包含当前仓库的 Ontology controller、工具、登录 UI 与 Bundle。不要把 `.env`、`data/` 或其他凭证文件复制进镜像。

根目录的 `jdcloud-harness.tar` 不会进入 Docker 构建上下文，可以在导出旧镜像后直接重建新镜像。Builder 与 Runtime 均固定使用 pnpm 11.7.0，且运行用户 `node` 可以读取共享 Corepack 安装；容器启动时不会临时下载其他 pnpm 版本。

## 3. 创建服务器环境配置

上传镜像、Compose 文件与环境变量模板：

```powershell
scp .\jdcloud-harness.tar .\compose.yaml .\.env.example user@<服务器地址>:/opt/jdcloud-harness/
```

在服务器复制模板并填写真实值：

```bash
cd /opt/jdcloud-harness
cp .env.example .env
chmod 600 .env
```

必须核对这些值：

```env
GPT_API_KEY=实际模型密钥
ONTOLOGY_HARNESS_TRUSTED_HOST=agent.example.com
ONTOLOGY_HARNESS_PORT=3080
ONTOLOGY_PRODUCT_NAME=Ontology Agent
ONTOLOGY_BASE_URL=https://ontology.example.com
ONTOLOGY_REQUEST_TIMEOUT_MS=15000
ONTOLOGY_USER_WORKSPACE_DIR=/workspace/ontology-users
TZ=Asia/Hong_Kong
```

`ONTOLOGY_HARNESS_TRUSTED_HOST` 必须是浏览器实际访问的域名或 IP；使用非默认端口时一并填写端口。`ONTOLOGY_BASE_URL` 只填写 Runtime origin，不附加 `/api/runtime`。Access Token、Refresh Token、用户密码和数据源凭证都不能放入 Compose 参数、命令行或日志配置。

## 4. 启动与持久化

```bash
cd /opt/jdcloud-harness
mkdir -p data
chown -R 1000:1000 data
docker image load -i jdcloud-harness.tar
docker compose up -d --no-build --pull never
docker compose ps
```

`./data` 挂载到容器的 `/var/lib/jdcloud-harness`，用于持久化 Session、设置与凭证存储；命名卷保存 Workspace 文件。`ONTOLOGY_USER_WORKSPACE_DIR` 必须位于已持久化的 `/workspace` 下。不要执行 `docker compose down -v`。

修改 `.env` 后使用以下命令重建容器：

```bash
docker compose up -d --no-build --pull never --force-recreate
```

`proxy` 使用 `network_mode: service:jdcloud-harness` 共享 Harness 的网络命名空间。不要只执行 `docker restart jdcloud-harness`；需要重启时使用上面的 Compose 命令同时重建两个服务，否则代理仍会连接旧网络命名空间。

## 5. 部署验收

上线前应在真实服务器完成以下检查：

1. 打开页面并确认出现 Ontology 登录、账号与通用 Ontology 工具。
2. 使用两个浏览器或两台电脑分别登录不同用户，确认 Project 与 Action 不串权；退出其中一个浏览器不影响另一个。
3. 重启容器后重复多浏览器检查，确认 `DSH_HOME` 中的 Session 与凭证归属仍按浏览器隔离。
4. 准备一个需要确认的 Action，分别验证拒绝不执行、确认只写入一次、确认期间撤权会显示 Ontology 拒绝结果。
5. 检查 Runtime 网络策略，确认非受信任来源无法访问 `/api/runtime/`。
6. 检查 Harness 与代理日志，确认没有密码、Access Token、Refresh Token、MongoDB URI 或其他数据源凭证。

可用以下命令收集不含敏感值的运行证据：

```bash
docker compose ps
docker compose logs --no-color jdcloud-harness proxy > deployment.log
grep -Ei 'password|accessToken|refreshToken|mongodb://' deployment.log
```

最后一条命令预期没有输出。`deployment.log` 仍应先人工检查并脱敏，再作为验收附件保存。

## 6. 更新

更新镜像：

```bash
docker image load -i jdcloud-harness.tar
docker compose up -d --no-build --pull never --force-recreate
```

更新后重新执行上一节的部署验收。应用身份层只支持 Ontology；如需回退整个版本，应加载已保存的旧镜像与其配套 Compose 文件，而不是在当前镜像中切换身份 Bundle。
