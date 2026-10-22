# GPT 卡密兑换（aiaiyg 中转）

买家在外部平台（如 16688、闲鱼）买到 aiaiyg 卡密 → 在本站验证卡密 → 粘贴 ChatGPT 登录信息 → 确认提交 → 查看充值结果。

本站只做中转：每一步都直接转给 [aiaiyg.com](https://aiaiyg.com) 的接口，**不使用数据库、不保存任何数据**。上游的原始提示统一翻译成本站自己的中文文案，页面上不出现上游的地址和名称。

技术栈：**TypeScript** + Node.js ≥ 24（直接运行 .ts）+ Express，没有其他运行时依赖。

## 快速开始

```bash
npm install
cp .env.example .env      # 开发环境可不改
npm run dev
npm run typecheck        # 类型检查（改完代码后运行）
```

打开 http://localhost:3000 即是兑换页。

## 流程与接口

| 步骤 | 本站接口 | 转发到 aiaiyg |
|---|---|---|
| 1. 验证卡密 | `POST /api/redeem/check` `{ code }` | `POST /api/voucher/status` |
| 2. 粘贴登录信息 | 只在本地校验：必须是 chatgpt.com/api/auth/session 的整页 JSON（含 `sessionToken`） | — |
| 3. 确认提交 | `POST /api/redeem` `{ code, session }` → `{ rid, token }` | `POST /api/plus/redeem/submit` |
| 4. 充值结果 | `GET /api/redeem/status?rid=&token=`（页面每 4 秒查一次） | `GET /api/redeem/status` |

- 提交成功后，查询凭据写进页面网址（`/?rid=…&t=…`），刷新、收藏或关掉后再打开都能继续看进度。
- 充值失败且上游确认卡密已退回时，页面提供「重新提交登录信息」，同一张卡密可以再用；卡密没退回的转人工，引导联系客服。
- 链接里带卡密（`/?code=xxx`）时自动填入并验证，方便在发货消息里直接给链接。

代码：上游接口和文案翻译在 [src/aiaiyg.ts](src/aiaiyg.ts)，本站接口和输入校验在 [src/routes.ts](src/routes.ts)，页面在 [public/index.html](public/index.html)。

## 安全

| 问题 | 处理方式 |
|---|---|
| 穷举卡密 | 同一 IP 15 分钟内输错 20 次暂停验证；各接口按 IP 限流 |
| 登录信息泄露 | 只转发给上游、不落盘不记日志；全站 HTTPS + HSTS；严格的 CSP，页面不能向其他域名发请求 |
| 被当作通用代理 | 只转发三个固定接口；卡密、查询凭据先做格式校验，格式不对的不转发 |
| 慢速连接攻击 | 请求头 10 秒、请求体 20 秒内必须收完 |

## 部署（Docker）

代码推送到 `main` 后，GitHub Actions 自动做类型检查、构建镜像并推到 `ghcr.io/weizhixiong123/gpt-topup`（见 [.github/workflows/docker.yml](.github/workflows/docker.yml)）。服务器只拉镜像，不放源码。

**首次部署**

1. 服务器登录镜像仓库（镜像是私有的）。在 GitHub → Settings → Developer settings → Personal access tokens (classic) 创建一个只勾选 `read:packages` 的令牌：

   ```bash
   echo "<令牌>" | docker login ghcr.io -u weizhixiong123 --password-stdin
   ```

2. 把 [deploy/](deploy/) 目录下的三个文件放到服务器的 `/opt/gpt-topup`，并把 `env.production.example` 复制为 `.env` 填好。
3. 启动：`bash update.sh`。服务只监听本机 `127.0.0.1:3000`。
4. Nginx 反向代理到 `http://127.0.0.1:3000` 并配置 HTTPS。上游建单可能要几十秒，需要调大超时：

   ```nginx
   proxy_read_timeout 120s;
   ```

**更新**：本地 `git push`，等 Actions 构建完成（绿色勾），在服务器执行 `bash update.sh`。

**常用命令**（在 `/opt/gpt-topup` 下）

```bash
docker compose logs -f --tail 100          # 看日志
docker compose up -d --force-recreate      # 修改 .env 后用这个
```

**回退到旧版本**：把 `docker-compose.yml` 里的 `:latest` 换成某次提交的完整哈希，再执行 `docker compose up -d`。
