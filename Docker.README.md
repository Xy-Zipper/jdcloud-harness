---
description: "在 macOS 或 Windows 构建 jdcloud-harness 镜像，推送到阿里云或导出到 Linux 服务器离线部署。"
---

# Docker 部署

在本机为 `linux/amd64` 服务器构建镜像，可以推送到阿里云镜像仓库，也可以导出为 tar 离线部署。模型配置、登录信息、会话和附件保存在服务器部署目录的 `data/`，更新镜像不会覆盖它们。

默认 Web 产品名称为 `LSY-Agent`。通过 Compose 构建时，可在构建机的 `.env` 中用 `JDCLOUD_PRODUCT_NAME` 覆盖浏览器标题和侧栏名称。用 `docker build` 时，传入 `--build-arg DSH_CLIENT_TITLE=自定义名称`。服务器 `.env` 中的 `JDCLOUD_PRODUCT_NAME` 控制运行时的智能体上下文，修改后重建容器即可。

## 发布到阿里云镜像仓库

安装 Git 并启动 Docker Desktop。在仓库根目录运行对应的发版脚本。示例中的 `7890` 是本机 HTTP 代理端口，按实际配置替换。直接联网或已在 Docker Desktop 配置代理时，可以省略这个参数。

在 macOS 的终端运行。 [macOS 发版脚本](scripts/release-docker.sh)

```sh
./scripts/release-docker.sh --version 0.2.2-rc.3-v2 --proxy-port 7890
```

在 Windows PowerShell 中运行。 [Windows 发版脚本](scripts/release-docker.ps1)

```powershell
.\scripts\release-docker.ps1 -Version 0.2.2-rc.3-v2 -ProxyPort 7890
```

脚本从 Git 读取 `HEAD` 作为客户端提交标识，并打包当前工作区中的构建文件，包括未提交的改动。构建成功后，脚本以 `萧影科技` 登录阿里云镜像仓库，按指定版本打标签并推送。请在 Docker 的提示中输入密码。

代理端口参数通过 `host.docker.internal` 提供给构建容器，用于下载 pnpm 和 npm 依赖。Docker Desktop 负责解析和拉取 `FROM` 中的基础镜像，也负责推送镜像。若 `load metadata` 报错指向 Docker Hub 加速器，可使用下文的 `NODE_IMAGE` 覆盖。 [Docker Desktop 代理设置](https://docs.docker.com/desktop/settings-and-maintenance/settings/#proxies)

如果 Apple Silicon 上的构建长时间停在 `Host bundle`，在 Docker Desktop 的 **Settings → General** 中关闭 **Use Rosetta for x86_64/amd64 emulation on Apple Silicon**，应用设置后重试。 [Docker Desktop 通用设置](https://docs.docker.com/desktop/settings-and-maintenance/settings/#general)

## 本地构建并导出

使用 `--build-only` 或 `-BuildOnly` 生成本地 `jdcloud-harness:local` 镜像。此模式无需登录镜像仓库。

```sh
./scripts/release-docker.sh --build-only --proxy-port 7890
```

```powershell
.\scripts\release-docker.ps1 -BuildOnly -ProxyPort 7890
```

离线部署时，同时导出服务器需要的 Caddy 镜像。在 macOS 和 Windows 上均可运行以下命令。

```text
docker pull --platform linux/amd64 caddy:2-alpine
docker image save -o jdcloud-harness.tar jdcloud-harness:local caddy:2-alpine
```

如果 Docker Hub 的镜像加速器无法拉取 Node 基础镜像，可通过 `NODE_IMAGE` 环境变量指定可用的 Node 官方镜像地址。在 macOS 上可用以下命令验证构建。

```sh
NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm ./scripts/release-docker.sh --build-only --proxy-port 7890
```

镜像在构建阶段和运行阶段均按根目录 `package.json` 的 `packageManager` 安装 pnpm。若手动构建时出现 npm registry 网络错误，可在 Docker 构建命令中增加 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com`。构建仍使用 `--frozen-lockfile` 和锁文件完整性校验。

Docker 构建依次执行编译和类型检查，降低 Docker Desktop 虚拟机的峰值内存占用。

## 上传并启动

上传 `jdcloud-harness.tar` 和 `compose.yaml` 到服务器部署目录，例如 `/opt/jdcloud-harness`。

```text
scp jdcloud-harness.tar compose.yaml user@server.example:/opt/jdcloud-harness/
```

将 `user@server.example` 换成服务器的 SSH 用户和地址。服务器需要使用 Linux `amd64` 架构。在服务器创建 `.env`：

```env
GPT_API_KEY=实际模型密钥
GPT_IMAGE_API_KEY=实际图片密钥
ARK_API_KEY=实际方舟密钥
JDCLOUD_HARNESS_TRUSTED_HOST=实际域名或服务器IP
JDCLOUD_HARNESS_STUDIO_TRUSTED_HOST=
JDCLOUD_HARNESS_PORT=3080
JDCLOUD_DEFAULT_BASE_URL=http://内部服务地址
JDCLOUD_IFRAME_PARENT_ORIGIN=http://实际外链页面地址
TZ=Asia/Hong_Kong
```

如果造物片场和 Harness UI 使用两个域名，`JDCLOUD_HARNESS_TRUSTED_HOST` 填 Harness UI 域名，`JDCLOUD_HARNESS_STUDIO_TRUSTED_HOST` 填造物片场页面的域名。两者都要包含非默认端口。留空时只需配置原有的 Harness 域名。网关转发规则见[外部集成 API 部署说明](EXTERNAL_API.zh.md#security-and-deployment)。

造物片场媒体插件随 JDCloud bundle 构建并装入镜像，无需到前端项目打包或单独安装媒体插件。两类媒体密钥可留空；配置后重建容器即可使用。任务回执和上传进度保存在 `data/creation-studio-media`，替换容器时保留该目录。Skill ZIP 继续通过 Skill 管理单独安装，详见[媒体包说明](packages/jdcloud/creation-studio-media/README.zh.md)。

在私有媒体账号池启用马栏山的 Seedance 2.5 视频账号，并允许 Harness 出站访问 `maas.mlsvcloud.com:8559`。账号池保存后可刷新片场查看对应供应商的报价。[马栏山账号配置](packages/jdcloud/creation-studio-media/README.zh.md#seedance-25-provider)

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

## 启用造物片场一键复刻

一键复刻需要新版 Harness、造物片场前端以及独立的 rea-video 拆解服务。在部署时同时使用 `compose.yaml` 与 `compose.video-remake.yaml`。在线构建时，在服务端仓库目录执行 `docker compose -f compose.yaml -f compose.video-remake.yaml build video-remake-worker` 构建拆解镜像。离线部署时，在打包机为 Linux amd64 构建并导出 `jdcloud-harness-video-remake:local`，随新版 Harness 镜像及两份 Compose 文件上传。

Docker Hub 加速器无法读取 Python 基础镜像时，可在构建机设置 `CREATION_STUDIO_VIDEO_REMAKE_PYTHON_IMAGE=public.ecr.aws/docker/library/python:3.11-slim-bookworm`。

两项费率都在部署环境中设置，以百分之一积分为单位。以下为试运营示例，每秒 0.02 积分，每 MiB 0.01 积分。部署前按实际定价调整。

```env
CREATION_STUDIO_VIDEO_REMAKE_SECOND_CENTS=2
CREATION_STUDIO_VIDEO_REMAKE_MIB_CENTS=1
```

镜像已加载后，在服务器执行以下命令。部署仍使用原有 `.env`、数据目录、可信域名和低代码账号。让反向代理允许至少 30 MiB 的请求体，并保留现有媒体接口读取超时。

```sh
docker compose -f compose.yaml -f compose.video-remake.yaml up -d --no-build --pull never
```

Worker 启动时根据容器实际可用的 CPU 与内存选择拆解并发。运行 `docker compose -f compose.yaml -f compose.video-remake.yaml logs --tail=20 video-remake-worker` 查看 `slots`。可用 `CREATION_STUDIO_VIDEO_REMAKE_WORKER_CPUS` 和 `CREATION_STUDIO_VIDEO_REMAKE_WORKER_MEM_LIMIT` 限制 Worker 的资源，内存上限默认为 8 GiB。改动配额后重建容器，让 Worker 重新计算并发。

拆解费通过低代码用量表和扣积分助手结算。Harness 可核对积分流水，造物片场默认配置也支持核对直接更新余额的数据助手执行记录。先在测试空间核对一条 `rea-video` 用量记录的扣款，再查询同一任务并核对余额。保持单个 Harness Host 和持久化 `data/creation-studio-media` 目录。参见[视频拆解插件](packages/jdcloud/creation-studio-video-remake/README.zh.md)。

同步部署造物片场前端和 Harness。新任务的画面、对白、配乐和字幕由 Seedance 生成，Harness 直接入库模型返回的 MP4。原片主体替换使用已启用视频参考的方舟账号，并按整段原片参考计价。`CREATION_STUDIO_VIDEO_REMAKE_WORKER_URL` 继续用于原片拆解及兼容转存，也供仍带本地合成计划的旧任务恢复入库。

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

Docker 认证 overlay 从 `webStartup.trustedHosts` 读取 `--trusted-host` 参数，并沿用 Web profile 的 `webStartup` 注入。若启动日志出现 `cannot get property "webRuntime" without inject`，镜像中的 `/app/docker.no-browser-auth.patch.yml` 仍引用旧服务名；需要将其改为 `ctx.webStartup.trustedHosts` 并按本节更新镜像。只重启原镜像不会更新该文件。

本地重新构建并上传新的 tar 后，在服务器重新加载并重建服务：

```bash
docker image load -i jdcloud-harness.tar
docker compose up -d --no-build --pull never --force-recreate
```

不要执行 `docker compose down -v`，否则会删除名为 `jdcloud_harness_workspace` 的工作目录卷。

## 启动时提示 package.json.lock 超时

`atomic-write: timed out waiting for the writer lock at /var/lib/jdcloud-harness/profiles/web/package.json.lock` 表示插件注册未能取得配置写锁。容器异常退出可能留下记录旧 PID 的锁；重建容器后，该 PID 可能被新进程复用，因此不能仅凭 PID 判断它已失效。

镜像入口使用 `$DSH_HOME/.docker-runtime.lock` 的内核锁，在整个应用进程存活期间独占数据目录。取得独占权后，入口只清理 Web profile 遗留的 `package.json.lock` 和对应的 takeover 文件，再注册插件并启动应用。同一个 `data/` 不能同时供两个容器运行；第二个实例会报告 `DSH_HOME is already in use`。不要手工删除 `.docker-runtime.lock` 文件：进程退出会自动释放内核锁，文件保留用于后续启动。

旧镜像可在确认没有其他实例使用同一数据目录后，先停止服务，再通过覆盖入口清理安装锁。以下命令在包含 `compose.yaml` 和 `.env` 的部署目录执行，PowerShell 与 Linux shell 均可使用；它们保留配置文件、会话、附件与工作目录卷。

```text
docker compose stop
docker compose run --rm --no-deps --pull never --entrypoint sh jdcloud-harness -c 'rm -f -- /var/lib/jdcloud-harness/profiles/web/package.json.lock /var/lib/jdcloud-harness/profiles/web/package.json.lock.takeover-*'
docker compose up -d --no-build --pull never --force-recreate
```

重新构建并加载包含入口修复的镜像后，单实例启动会自动清理这些遗留安装锁。构建上下文排除本机 `data/`，用户数据只通过运行时挂载提供。
