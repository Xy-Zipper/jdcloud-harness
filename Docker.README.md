---
description: "在 Windows 本地构建 JDCloud Harness Linux Docker 镜像，将镜像保存为 tar 并上传到服务器离线部署、验证、升级或回滚。"
---

# Docker 镜像打包与服务器部署

## Summary

本教程说明如何在本地通过根目录的 [Dockerfile](Dockerfile) 构建 Linux 镜像，使用 `docker save` 生成可上传的 tar 文件，再由服务器通过 `docker load` 和 [compose.yaml](compose.yaml) 启动服务。本地镜像同时保留版本标签和 `local` 标签，因此服务器不需要修改 Compose 中的镜像名称。模型配置、凭据、会话和附件保存在部署目录的 `data/` 中，工作目录保存在 Docker named volume 中，更新镜像不会删除这些数据。

## Table of Contents

- [前置条件](#前置条件)
- [本地构建镜像](#本地构建镜像)
- [保存镜像 tar](#保存镜像-tar)
- [上传部署文件](#上传部署文件)
- [服务器加载镜像](#服务器加载镜像)
- [配置服务器环境变量](#配置服务器环境变量)
- [启动服务](#启动服务)
- [验证部署](#验证部署)
- [Docker 网络](#docker-网络)
- [升级与回滚](#升级与回滚)
- [常见问题](#常见问题)

## 前置条件

本地需要 Docker Desktop，并且 Docker Desktop 的 Linux Engine 必须处于运行状态。服务器需要 Docker Engine 和 Docker Compose V2，并且 CPU 架构必须与构建参数一致。

在服务器执行以下命令确认架构：

```bash
uname -m
```

使用以下对应关系：

| `uname -m` 输出 | 本地构建平台 |
|---|---|
| `x86_64` | `linux/amd64` |
| `aarch64` | `linux/arm64` |

本教程后续命令以 Windows PowerShell、本地项目目录 `D:\WebstormProjects\jdcloud-harness` 和 Linux x86_64 服务器为例。

## 本地构建镜像

打开 PowerShell，进入项目根目录并从 `package.json` 读取当前版本：

```powershell
cd D:\WebstormProjects\jdcloud-harness

$Version = (Get-Content .\package.json -Raw | ConvertFrom-Json).version
$Platform = "linux/amd64"
$Commit = (git rev-parse HEAD).Trim()
```

构建镜像并传入当前提交哈希，同时创建版本标签和 Compose 使用的 `local` 标签：

```powershell
docker buildx build `
  --platform $Platform `
  --build-arg "DSH_CLIENT_COMMIT_HASH=$Commit" `
  --load `
  --tag "jdcloud-harness:$Version" `
  --tag "jdcloud-harness:local" `
  .
```

`--load` 将 Buildx 产物加载到本地 Docker Engine。缺少该参数时，后续 `docker save` 可能找不到镜像。容器启动时会把镜像内的 JDCloud bundle 注册到持久化 Web profile，再启动 Web 服务。

验证构建结果：

```powershell
docker image inspect "jdcloud-harness:$Version"
docker image inspect "jdcloud-harness:local"
docker image ls jdcloud-harness
```

两个标签应指向相同的 image ID。

## 保存镜像 tar

创建本地部署产物目录：

```powershell
New-Item -ItemType Directory -Force .\dist\docker | Out-Null
```

将两个业务镜像标签保存到同一个 tar 文件：

```powershell
$ImageTar = ".\dist\docker\jdcloud-harness-$Version-linux-amd64.tar"

docker save `
  --output $ImageTar `
  "jdcloud-harness:$Version" `
  "jdcloud-harness:local"
```

如果服务器不能访问 Docker Hub，还需要保存 Compose 使用的 Caddy 镜像：

```powershell
docker pull --platform linux/amd64 caddy:2-alpine
docker save --output .\dist\docker\caddy-2-alpine.tar caddy:2-alpine
```

复制 Compose 文件并生成业务镜像 tar 的 SHA-256：

```powershell
Copy-Item .\compose.yaml .\dist\docker\compose.yaml -Force
Get-FileHash $ImageTar -Algorithm SHA256
```

保存哈希值，服务器收到文件后应使用它检查上传是否完整。

## 上传部署文件

先在服务器创建部署目录：

```bash
mkdir -p /root/docker/images/jdcloud-harness
```

从本地 PowerShell 上传业务镜像和 Compose 文件：

```powershell
scp `
  $ImageTar `
  .\dist\docker\compose.yaml `
  root@<服务器地址>:/root/docker/images/jdcloud-harness/
```

服务器不能访问 Docker Hub 时，同时上传 Caddy：

```powershell
scp `
  .\dist\docker\caddy-2-alpine.tar `
  root@<服务器地址>:/root/docker/images/jdcloud-harness/
```

## 服务器加载镜像

登录服务器并进入部署目录：

```bash
cd /root/docker/images/jdcloud-harness
```

检查上传文件的 SHA-256，并与本地 PowerShell 输出比较：

```bash
sha256sum jdcloud-harness-<版本>-linux-amd64.tar
```

加载业务镜像：

```bash
docker load --input jdcloud-harness-<版本>-linux-amd64.tar
```

服务器离线时加载 Caddy 镜像：

```bash
docker load --input caddy-2-alpine.tar
```

验证镜像标签：

```bash
docker image inspect jdcloud-harness:<版本>
docker image inspect jdcloud-harness:local
docker image ls jdcloud-harness
```

`compose.yaml` 使用 `jdcloud-harness:local`，所以服务器必须存在这个标签。按照本教程保存两个标签后，`docker load` 会同时恢复它们。

## 配置服务器环境变量

在 `compose.yaml` 所在目录创建 `.env`：

```bash
cat > .env <<'EOF'
GPT_API_KEY=替换为实际模型密钥
JDCLOUD_HARNESS_TRUSTED_HOST=替换为实际域名或服务器IP
JDCLOUD_HARNESS_PORT=3080
TZ=Asia/Hong_Kong
EOF

chmod 600 .env
```

`JDCLOUD_HARNESS_TRUSTED_HOST` 只能是 `host` 或 `host:port`，不能包含 `http://`、`https://` 或路径。例如：

```env
JDCLOUD_HARNESS_TRUSTED_HOST=agent.example.com
```

Compose 会把 `GPT_API_KEY` 同时注入为 `DEEPSEEK_API_KEY`，因此使用默认 `deepseek-official` 路由时无需再通过浏览器配置密钥。默认模型为镜像内置的 `deepseek-flash`；只有使用自定义模型 ID 或模型服务地址时，才需要在 `$DSH_HOME/settings.yaml` 中统一配置：

```yaml
llm-deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY
  baseURL: https://模型服务地址

agent-default-model:
  provider: deepseek-official
  model: 模型ID
```

模型配置、凭据记录、会话和附件保存在宿主机部署目录的 `data/` 中，管理员可以直接编辑 `data/settings.yaml`。不要将实际密钥写入 Dockerfile、镜像或 `settings.yaml`。

首次部署需要创建宿主机目录，并将其所有权设为镜像中的 `node` 用户：

```bash
mkdir -p data
docker run --rm --entrypoint sh jdcloud-harness:local -lc 'id -u node; id -g node'
chown -R 1000:1000 data
chmod 700 data
```

上面的镜像默认输出 UID 和 GID `1000`。如果输出不同，应将 `chown` 中的两个数字改为实际值。

从旧版 `jdcloud_harness_data` named volume 切换时，先停止服务，再完整迁移数据。不要先运行使用新 Compose 的容器：

```bash
docker volume inspect jdcloud-harness_jdcloud_harness_data >/dev/null
docker compose down
mkdir -p data
docker run --rm --user 0:0 \
  -v jdcloud-harness_jdcloud_harness_data:/source:ro \
  -v "$PWD/data:/target" \
  --entrypoint sh jdcloud-harness:local \
  -lc 'cp -a /source/. /target/'
chown -R 1000:1000 data
chmod 700 data
```

迁移完成后，宿主机上的模型配置文件是：

```text
/root/docker/images/jdcloud-harness/data/settings.yaml
```

## 启动服务

使用已经加载的本地镜像启动，禁止 Compose 在线构建或拉取替代镜像：

```bash
docker compose up -d --no-build --pull never
```

查看服务状态和最近日志：

```bash
docker compose ps
docker compose logs --tail=100 jdcloud-harness
docker compose logs --tail=100 proxy
```

持续查看业务服务日志：

```bash
docker compose logs -f --tail=100 jdcloud-harness
```

## 验证部署

检查容器健康状态：

```bash
docker compose ps
```

检查服务器公开端口：

```bash
curl -i http://127.0.0.1:3080/
```

返回 `200 OK` 表示 Web 服务和 Caddy 代理正常。当前 Compose 通过 `docker.no-browser-auth.patch.yml` 关闭 Harness 浏览器 Token/Cookie 认证，因此直接使用实际域名或服务器地址访问。JDCloud Login 不会保护登录前可调用的全部 Harness API；部署方必须通过防火墙、内网或上游网关限制 3080 端口的访问者。

登录 JDCloud 后还应验证新建对话、模型调用、流式响应、文件上传以及容器重启后的会话和附件读取。

## Docker 网络

当前 Compose 不需要手工创建外部网络。Compose 会管理默认网络，`proxy` 通过 `network_mode: service:jdcloud-harness` 与业务容器共享网络空间。

只有服务必须通过容器名访问另一个 Compose 项目时，才需要创建并声明外部网络。例如接入已有 `docker_ragflow`：

```bash
docker network inspect docker_ragflow >/dev/null 2>&1 || docker network create docker_ragflow
```

外部网络还必须在 `compose.yaml` 中显式挂载到 `jdcloud-harness` 服务；仅创建网络不会让容器自动加入。

## 升级与回滚

升级时在本地使用新版本重新执行构建、保存和上传步骤。服务器加载新 tar 后，将新版本重新标记为 Compose 使用的 `local`：

```bash
docker tag jdcloud-harness:<新版本> jdcloud-harness:local
docker compose up -d --no-build --pull never --force-recreate
docker compose logs -f --tail=100 jdcloud-harness
```

回滚时将保留的旧版本重新标记为 `local`：

```bash
docker tag jdcloud-harness:<旧版本> jdcloud-harness:local
docker compose up -d --no-build --pull never --force-recreate
```

升级前应备份部署目录中的 `data/`。会话和存储格式不保证旧版本能够读取新版本已经写入的数据，因此程序镜像回滚可能还需要恢复与旧版本对应的数据备份。

不要执行以下命令，除非确定要删除全部持久化数据：

```bash
docker compose down -v
```

## 常见问题

| 现象 | 原因和处理 |
|---|---|
| 本地无法连接 Docker Engine | 启动 Docker Desktop，并确认使用 Linux containers |
| `git rev-parse HEAD` 失败或提示缺少 `DSH_CLIENT_COMMIT_HASH` | 从 Git 工作区构建，并按示例把 `git rev-parse HEAD` 的结果通过 `--build-arg DSH_CLIENT_COMMIT_HASH=...` 传入 |
| `docker save` 提示镜像不存在 | 构建时加入 `--load`，然后检查镜像标签 |
| 服务器提示 `no matching manifest` 或程序无法启动 | 本地 `--platform` 与服务器 CPU 架构不一致 |
| Compose 尝试构建镜像 | 启动时加入 `--no-build`，并确认 `jdcloud-harness:local` 已加载 |
| Compose 尝试访问镜像仓库 | 启动时加入 `--pull never`；离线服务器还需要导入 Caddy 镜像 |
| `JDCLOUD_HARNESS_TRUSTED_HOST` 配置报错 | 只填写域名、IP 或 `host:port`，不要填写 URL |
| 首页返回 401 | 确认镜像包含 `browserAuthentication` 配置，并确认 Compose 加载 `/app/docker.no-browser-auth.patch.yml` |
| 日志提示找不到 JDCloud 插件包 | 确认使用包含 `docker-entrypoint.sh` 的最新镜像，并确认 Compose 未通过 `--patch` 直接加载 `jdcloud-login/cordis.patch.yml` |
| 模型提示缺少凭据 | 确认 `.env` 中存在 `GPT_API_KEY`，再用 `docker compose exec jdcloud-harness sh -lc 'test -n "$DEEPSEEK_API_KEY"'` 验证 Compose 已注入默认路由读取的别名 |
| 远程浏览器的 Models 页面显示只读 | 这是服务器集中配置模式；页面只展示当前活动提供方，模型地址、模型 ID 与密钥由服务器 `.env` 和 `$DSH_HOME/settings.yaml` 管理 |
| 文件或会话重启后丢失 | 确认 `./data` 已挂载到 `/var/lib/jdcloud-harness`，并检查目录所有权是否与容器中的 `node` 用户一致 |
| `proxy` 无法启动 | 检查业务容器健康状态，并确认服务器已有 `caddy:2-alpine` 镜像或可以拉取它 |
