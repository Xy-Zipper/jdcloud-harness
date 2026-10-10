---
description: "构建并部署使用 Ontology 身份、权限与业务工具的 Harness Web 服务。"
---

# Ontology Harness Docker 部署

本部署默认只启用 `ontology-login` Bundle。容器启动时会从持久化 Web profile 移除 `jdcloud-login`，再安装镜像内的 Ontology Bundle，因此页面与 Agent 工具中不会同时保留 JDCloud 登录和低代码入口。阶段 9 保留显式 `HARNESS_IDENTITY_BUNDLE=jdcloud` 回滚开关；生产稳定并完成阶段 9 验收前不要删除旧包或旧数据。

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
HARNESS_IDENTITY_BUNDLE=ontology
ONTOLOGY_BASE_URL=https://ontology.example.com
ONTOLOGY_REQUEST_TIMEOUT_MS=15000
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

`./data` 挂载到容器的 `/var/lib/jdcloud-harness`。Compose 项目名、服务名、镜像名和卷名在阶段 9 保持不变，以原位复用已有 Session、Workspace、设置、凭证存储和工作目录卷。不要执行 `docker compose down -v`。

修改 `.env` 后使用以下命令重建容器：

```bash
docker compose up -d --no-build --pull never --force-recreate
```

## 5. 阶段 9 生产验收

只有以下检查全部取得真实服务器证据后，阶段 9 才能标记为完成：

1. 打开页面并确认只出现 Ontology 登录、账号与通用 Ontology 工具，不出现 JDCloud 登录或低代码功能选择器。
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

## 6. 更新与回滚

更新镜像：

```bash
docker image load -i jdcloud-harness.tar
docker compose up -d --no-build --pull never --force-recreate
```

若 Ontology 切换需要回滚，把服务器 `.env` 中的选择器改为：

```env
HARNESS_IDENTITY_BUNDLE=jdcloud
```

同时在 `.env` 中恢复 `JDCLOUD_DEFAULT_BASE_URL` 等 JDCloud 部署值，然后重建容器。入口脚本会移除 Ontology Bundle 并重新安装镜像内的 JDCloud Bundle。回滚验证完成后再决定是否恢复 `HARNESS_IDENTITY_BUNDLE=ontology`；不要在阶段 9 删除任一 Bundle、凭证记录或旧配置。
