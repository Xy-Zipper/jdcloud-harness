---
description: "在本地构建 JDCloud Harness 镜像，导出到 Linux 服务器并离线启动。"
---

$Env:DSH_CLIENT_COMMIT_HASH = (git rev-parse HEAD).Trim()

Remove-Item Env:DOCKER_BUILDKIT -ErrorAction SilentlyContinue

$Env:http_proxy = "http://127.0.0.1:35347"
$Env:https_proxy = "http://127.0.0.1:35347"

docker build `
  --build-arg "DSH_CLIENT_COMMIT_HASH=$Env:DSH_CLIENT_COMMIT_HASH" `
  --tag jdcloud-harness:local `
  .


# caddy:2-alpine
# docker image save -o .\jdcloud-harness.tar jdcloud-harness:local caddy:2-alpine

docker image save -o .\jdcloud-harness.tar jdcloud-harness:local
docker pull caddy:2-alpine
















# Docker 部署

本地构建镜像，导出为 tar 上传到服务器。服务器加载镜像后使用 Compose 启动；模型配置、登录信息、会话和附件保存在部署目录的 `data/`，更新镜像不会覆盖它们。

## 本地构建并导出

在项目根目录的 PowerShell 中执行。Docker Desktop 必须能访问构建所需的镜像仓库。

```powershell
cd D:\WebstormProjects\jdcloud-harness

$Env:DSH_CLIENT_COMMIT_HASH = (git rev-parse HEAD).Trim()
$Env:http_proxy = "http://127.0.0.1:27085"
$Env:https_proxy = "http://127.0.0.1:27085"

docker compose build jdcloud-harness
docker pull caddy:2-alpine
docker image save -o .\jdcloud-harness.tar jdcloud-harness:local caddy:2-alpine
```

如 Docker Desktop 无法拉取镜像，在 Docker Desktop 的代理设置中填写 `http://host.docker.internal:27085` 后重启 Docker Desktop。

## 上传并启动

上传 `jdcloud-harness.tar` 和 `compose.yaml` 到服务器部署目录，例如 `/opt/jdcloud-harness`。

```powershell
scp .\jdcloud-harness.tar .\compose.yaml user@<服务器地址>:/opt/jdcloud-harness/
```

服务器需要同为 Linux `amd64` 架构。在服务器创建 `.env`：

```env
GPT_API_KEY=实际模型密钥
JDCLOUD_HARNESS_TRUSTED_HOST=实际域名或服务器IP
JDCLOUD_HARNESS_PORT=3080
JDCLOUD_DEFAULT_BASE_URL=http://内部服务地址
JDCLOUD_IFRAME_PARENT_ORIGIN=http://实际外链页面地址
TZ=Asia/Hong_Kong
```

`JDCLOUD_IFRAME_PARENT_ORIGIN` 填写包含 iframe 的父页面 origin，只能包含协议、主机和端口，不能包含路径；设置为 `*` 会允许全部网站嵌入并接受点击劫持风险。Docker overlay 使用 Bearer 浏览器会话：token 只保存在当前标签页的 `sessionStorage`，同源 Fetch 与 RPC 通过 Authorization header 携带 token，WebSocket 使用短期单次 ticket。因此跨站 iframe 不再依赖第三方 cookie，也不要求 HTTPS。

Bearer 只能解决浏览器拒绝跨站 cookie 的问题，不会加密 HTTP 流量。使用明文 HTTP 时，网络观察者或中间节点仍可窃取会话 token；能部署受信任 HTTPS 时仍应优先使用 HTTPS。修改 `.env` 或 `compose.yaml` 后必须重建容器；修改本仓库代码后还必须重新构建并加载镜像。

加载镜像并启动。`--no-build --pull never` 确保服务器不会尝试在线构建或拉取业务镜像。

```bash
cd /opt/jdcloud-harness
mkdir -p data
chown -R 1000:1000 data
docker image load -i jdcloud-harness.tar
docker compose up -d --no-build --pull never
docker compose ps
```

JDCloud Bearer 部署的根页面直接返回 `2xx`；健康检查仍将本地 `3080` 端口的 `2xx` 或 `3xx` 响应视为服务已就绪。修改 `compose.yaml` 后不需要重新构建镜像，但需要重建容器。

## 修改模型配置

`./data` 挂载到容器的 `/var/lib/jdcloud-harness`。因此编辑服务器上的 `data/settings.yaml` 就是在编辑容器正在使用的 settings 文件，合法 YAML 会实时生效，无需重新打包。

```text
/opt/jdcloud-harness/data/settings.yaml
```

修改默认模型后请新建会话或重新选择模型；旧会话可能保存了之前的模型 ID。`.env` 修改后需要重建容器：

```bash
docker compose up -d --no-build --force-recreate
```

## 更新镜像

本地重新构建并上传新的 tar 后，在服务器重新加载并重建服务：

```bash
docker image load -i jdcloud-harness.tar
docker compose up -d --no-build --pull never --force-recreate
```

不要执行 `docker compose down -v`，否则会删除名为 `jdcloud_harness_workspace` 的工作目录卷。
