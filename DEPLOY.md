# 部署说明

本文档对应当前新架构版本：NestJS API、Vue 管理端、Vue 用户端、MySQL、Prisma。生产部署以 `apps/*`、`packages/*`、`prisma/*` 为准，旧版 `server.js` 不作为生产入口。

## 1. 环境要求

- Linux 服务器，推荐 Debian 12、Ubuntu 22.04+、CentOS/Rocky 9+
- Node.js 20.19 或更新版本（推荐使用维护中的 LTS 版本）
- npm 10+
- MySQL 8.0+ 或兼容版本
- 可选：Nginx、systemd

生产服务器构建时不要使用 `npm ci --omit=dev`，前端和 TypeScript 构建需要 devDependencies。构建完成后可以再执行 `npm prune --omit=dev`。

## 2. 一键脚本部署

服务器上直接执行，默认安装到 `/opt/shiye`，服务名 `shiye-api`。下面命令默认在 `root` 用户下执行；如果当前不是 `root`，请先切换到 `root` 用户。脚本默认安装为 `IP:3388` 访问，安装完成后可通过 `shiye` 菜单第 6 项配置域名、Nginx 和 HTTPS。

一键脚本默认按“精简运行目录”部署：优先下载 Linux 预构建包，包不可用时回退源码构建。安装完成后会删除构建期才需要的文件，`/opt/shiye` 默认只保留运行必需项：

- `.env`
- `dist/admin-web`
- `dist/user-web`
- `node_modules`
- `package.json`
- `package-lock.json`
- `apps/api/package.json`
- `apps/api/dist`
- `packages/*/package.json`
- `packages/*/dist`
- `prisma/schema.prisma`
- `prisma/migrations`

README、部署文档、安装脚本、前端源码、后端源码、示例配置和 `.git` 默认不会保留在服务器运行目录。预构建发布包包含首次安装必需的 `.env.example`、数据库迁移和 `scripts/sync-admin.mjs`；安装程序使用幂等的管理员初始化，不会重置已存在的后台密码。

默认构建包地址：`https://github.com/wstimin/shiye-3xuigl-L3/releases/latest/download/shiye-3xuigl.zip`

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh)"
```

安装完成后会写入 `/usr/local/bin/shiye`，后续常用运维可以直接打开管理菜单：

```bash
shiye
```

菜单标题只显示“管理面板”，实际入口如下：

```text
管理面板

1. 安装/更新项目
2. 查看当前配置
3. 查看服务状态
4. 重启服务
5. 查看运行日志
6. 配置域名/Nginx/HTTPS
7. 取消域名，仅使用 IP + 端口
8. 更新/重装运行文件
9. 执行数据库迁移
10. 备份数据库和 .env
11. 卸载项目
12. 卸载项目并删除数据库
0. 退出
```

也可以提前带入域名和 HTTPS 参数，直接部署：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh | env DOMAIN=panel.example.com ENABLE_NGINX=yes ENABLE_HTTPS=yes CERTBOT_EMAIL=admin@example.com bash
```

把仓库上传到服务器后，在项目根目录执行：

```bash
bash install.sh
```

脚本会执行以下动作：

- 安装基础工具和 Node.js 20
- 本机没有提供 `DATABASE_URL` 时，安装并初始化本机 MySQL
- 生成 `.env`，包含随机密钥和随机后台初始密码
- 执行 `npm ci`
- 执行 `npm run install:prod`。预构建包会完成数据库迁移、seed 和部署检查；源码部署会额外执行类型检查和构建
- 执行 `npm prune --omit=dev`
- 注册并启动 systemd 服务
- 可在安装后通过管理菜单配置 Nginx 和 HTTPS

常用参数示例：

```bash
DOMAIN=panel.example.com ENABLE_NGINX=yes ENABLE_HTTPS=yes bash install.sh
```

使用外部数据库：

```bash
DATABASE_URL='mysql://shiye:strong-password@127.0.0.1:3306/shiye_management' bash install.sh
```

脚本默认安装目录是 `/opt/shiye`，服务名是 `shiye-api`。可以通过 `APP_DIR`、`APP_NAME` 修改。

## 3. 宝塔 / 1Panel 网页向导与手动部署

### 宝塔 / 1Panel

1. 创建 MySQL 数据库与专用账号，保存数据库地址、端口、名称、用户名及密码。
2. 下载最新发布包并解压到项目目录；`package.json` 应直接位于该目录下，不要多套一层文件夹。
3. 在面板创建 Node.js 项目，选择 **Node.js 20.19+**，工作目录设为上述目录，启动命令设为 **`npm start`**，端口默认 **3388**。面板如要求先安装依赖，执行 `npm ci --include=dev`。不需要自己选择前端目录或单独构建两个网站。
4. 将整个网站反向代理到 Node.js 项目端口，然后打开网站。首次启动会显示同一个「宝塔 / 1Panel」安装向导：填写数据库、管理员账号密码、管理路径，可选填写公开网站地址。
5. 宝塔同机数据库通常填写 `127.0.0.1`；1Panel 的 Node.js 如果在容器中，请填写容器可达的数据库内网地址或容器名，不能直接照搬宿主机 `127.0.0.1`。网站端口须与运行环境一致。
6. 点击「开始安装」，等待日志显示完成，再在面板中重启 Node.js 项目。`npm start` 会进入正式网站；用户端为 `/`，管理端使用安装时填写的路径，默认 `/admin/`。

向导支持亮暗主题，与管理端和用户账号的偏好分别保存。密码不写入浏览器草稿，已保存后留空可沿用。发布包会自动跳过源码构建；上传完整源码时则会安装构建依赖并执行构建。

面板部署更新时，先备份数据库与 `.env`，暂停项目，上传新版发布包并保留 `.env`，在项目目录依次执行 `npm ci --include=dev`、`npm run install:prod`、`npm prune --omit=dev`，再从面板重启项目。安装命令会执行迁移并保留已有管理员密码，不能仅覆盖前端文件或直接使用 `git pull` 更新精简发布包。

**维护能力的部署区别：** 一键 Linux/systemd 部署会配置独立维护服务，支持后台网页更新与网站迁移。普通宝塔 Node.js 项目或 1Panel 容器不会自动获得该服务，后台会显示尚未配置；请使用面板管理程序更新，并同时备份数据库和 `.env` 迁移，不要在容器内执行会接管宿主机服务的一键脚本。

### 手动部署

创建数据库：

```sql
CREATE DATABASE shiye_management CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'shiye'@'127.0.0.1' IDENTIFIED BY 'replace-with-strong-password';
GRANT ALL PRIVILEGES ON shiye_management.* TO 'shiye'@'127.0.0.1';
FLUSH PRIVILEGES;
```

安装依赖并创建环境变量：

```bash
npm ci --include=dev
cp .env.example .env
```

必须修改 `.env` 中的这些字段：

```env
NODE_ENV=production
PORT=3388
PUBLIC_WEB_URL=https://panel.example.com
DATABASE_URL=mysql://shiye:replace-with-strong-password@127.0.0.1:3306/shiye_management
SESSION_SECRET=replace-with-long-random-secret
ENCRYPTION_KEY=replace-with-32-byte-base64-key
CARD_HASH_SECRET=replace-with-long-random-secret
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=replace-with-strong-admin-password
```

生成 32 字节密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

初始化和构建：

```bash
npm run install:prod
npm prune --omit=dev
```

临时启动 API：

```bash
npm start
```

## 4. systemd

仓库提供示例文件：`infra/systemd/shiye-api.service`。

如果项目部署在 `/opt/shiye`，可以直接使用：

```bash
cp infra/systemd/shiye-api.service /etc/systemd/system/shiye-api.service
systemctl daemon-reload
systemctl enable --now shiye-api
```

查看日志：

```bash
journalctl -u shiye-api -f
```

## 5. Nginx

仓库提供示例文件：`infra/nginx/shiye.conf`。

当前版本由 Node.js 一个端口同时提供用户端、管理端和 API。Nginx 只需要把整个网站反向代理到 `http://127.0.0.1:3388`，不需要单独配置 `/api/`，也不需要直接托管 `dist/user-web` 或 `dist/admin-web`。

修改示例文件里的 `server_name` 后可复制使用：

```bash
cp infra/nginx/shiye.conf /etc/nginx/conf.d/shiye.conf
nginx -t
systemctl reload nginx
```

访问入口：

- 用户端：`https://panel.example.com/`
- 管理端：`https://panel.example.com/admin/`
- API：`https://panel.example.com/api/`

生产环境建议只开放 `80/443`，API 的 `3388` 端口只允许本机或内网访问。

## 6. 支付回调地址

本项目只有“用户充值余额”业务，用户可输入任意充值金额，支付成功后只增加用户余额，不直接续费套餐。

当前后台可配置并可发起下单的在线支付通道：易支付、BEpusdt、支付宝官方接口、微信支付 V2 Native 扫码。支付宝官方接口支持当面付扫码、PC 网站支付、手机网站支付，均只用于充值余额。支付平台回调地址格式：

```text
https://panel.example.com/api/payments/epay/notify
https://panel.example.com/api/payments/bepusdt/notify
https://panel.example.com/api/payments/alipay/notify
https://panel.example.com/api/payments/wechat/notify
```

结果页地址：

```text
https://panel.example.com/payment/result?trade_no=订单号
```

实际启用哪个通道，以后台“财务管理 - 支付设置”配置为准。
支付宝官方通道需要配置 AppID、应用私钥、支付宝公钥，并在后台选择接口类型 `precreate`、`page` 或 `wap`；微信官方通道需要配置 AppID、商户号、V2 API 密钥。支付宝/微信官方通道必须使用公网可访问的完整回调地址，建议部署 HTTPS 域名并设置 `PUBLIC_WEB_URL`。

## 7. 更新版本

默认精简部署时，`/opt/shiye` 不是 Git 仓库，不能直接 `git pull`。推荐重新执行一键脚本，脚本会保留现有 `.env`，优先获取最新预构建包、迁移数据库、校验并重启服务；如果预构建包不可用，会回退源码构建：

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh)"
```

重复执行一键脚本的行为是“更新部署”，不是清库重装：

- 保留：`/opt/shiye/.env`、现有 MySQL 数据库、已有业务数据、已有管理员密码。
- 覆盖：除 `.env` 外的程序运行文件、前端构建产物、后端构建产物、依赖和 systemd 服务文件。
- 自动执行：数据库迁移、seed 幂等初始化、运行文件检查、服务重启和健康检查；源码回退时会额外构建。
- 不会执行：删除数据库、清空用户、清空订单、清空卡密、清空节点配置。

一键脚本默认不会在安装开头询问 Nginx。需要域名/HTTPS 时，安装完成后运行 `shiye`，选择第 6 项配置；也可以更新时显式带同样域名参数，避免 `PUBLIC_WEB_URL` 被改回 IP + 端口：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh | env DOMAIN=panel.example.com ENABLE_NGINX=yes ENABLE_HTTPS=yes CERTBOT_EMAIL=admin@example.com bash
```

如果你是手动上传完整源码部署，可以使用源码更新方式：

```bash
git pull
npm ci
npm run install:prod
npm prune --omit=dev
systemctl restart shiye-api
```

## 8. 备份和恢复

必须备份：

- MySQL 数据库
- `.env`
- 自定义 Nginx/systemd 配置

备份数据库：

```bash
mysqldump -u shiye -p shiye_management > shiye_management.sql
```

恢复数据库：

```bash
mysql -u shiye -p shiye_management < shiye_management.sql
```

如果丢失 `.env` 里的 `ENCRYPTION_KEY`，已保存的 3x-ui Token、密码和支付密钥将无法解密。

## 9. 安装后检查

```bash
curl http://127.0.0.1:3388/api/health
curl http://127.0.0.1:3388/api/setup/status
npm run deploy:check
```

后台登录后建议依次完成：

- 修改管理员默认密码
- 新增 3x-ui 服务器并测试连接
- 新增服务节点，确认 inbound ID
- 创建测试用户并绑定一个或多个服务节点，分别设置到期时间和流量
- 点击同步到 3x-ui，验证节点同步链路
- 在管理端概览页手动执行“停用过期节点”，确认已到期节点会同步停用到远端 3x-ui，且本地绑定状态变为停用
- 给停用后的节点续费，确认余额扣费成功、本地状态恢复启用、远端 3x-ui 客户端重新启用
- 登录用户端，验证每个节点可单独续费、复制节点并生成二维码

## 10. 卸载入口

默认卸载程序、服务和 Nginx 配置，保留数据库：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | bash
```

彻底卸载并删除默认数据库：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | env DELETE_DATABASE=yes bash
```

删除数据库对应的原始 MySQL 命令见 `UNINSTALL.md`。
