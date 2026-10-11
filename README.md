# GPT 代充平台

用户选套餐 → 微信/支付宝扫码付款 → 填写 Token → 后台自动锁定卡密并调用上游兑换 → 定时查询结果 → 页面展示成功/失败。

技术栈：**TypeScript** + Node.js ≥ 24（直接运行 .ts）+ Express + **PostgreSQL**（生产使用 Supabase 新加坡区，业务表位于独立的 `topup` schema）。

## 快速开始

```bash
npm install
cp .env.example .env      # 必填 DATABASE_URL；其余开发环境可不改（默认 mock 支付 + mock 上游）
npm run migrate           # 建表（服务启动时也会自动执行）
npm run seed              # 写入演示套餐和卡密
npm run dev
npm run typecheck        # 类型检查（改完代码后运行）
```

- 前台：http://localhost:3000
- 后台：http://localhost:3000/admin.html （开发默认 admin / admin）

Mock 上游约定：Token 含 `bad` 表示 Token 无效，含 `failtask` 表示兑换失败，卡密含 `BAD` 表示卡密无效（系统会自动换卡），其余情况约 15 秒后成功。

## 订单状态机

```
PENDING_PAYMENT ──支付回调/主动查询──▶ PAID ──用户提交 Token──▶ QUEUED ──锁定卡密 + 提交上游──▶ REDEEMING ──定时查询──▶ SUCCESS
      │                                                              │                                    │
      ▼ 超时                                                          ├─ 缺货：保持 QUEUED，补货后自动继续      ├─ 失败且卡密未消耗 → FAILED（卡密退回库存，用户可重新提交 Token）
   EXPIRED（之后仍到账则自动转为 PAID）                                ├─ 卡密无效 → 作废该卡，自动换卡重试       ├─ 卡密无效 → 换卡重新排队
                                                                      └─ 结果不确定 → MANUAL_REVIEW            └─ 超过查询次数 → MANUAL_REVIEW
```

卡密状态：`AVAILABLE` → `LOCKED`（绑定订单）→ `USED`，或者 `INVALID`，或者退回 `AVAILABLE`。

卡密在**付款成功后立即锁定**并向上游核对状态（上游驱动实现了 `checkCard` 时），坏卡当场作废换下一张；用户提交 Token 时再核对一次才提交兑换。付款时缺货的订单会在补货后自动分配。

## 关键设计

| 问题 | 处理方式 |
|---|---|
| 超卖 | 下单时在事务内校验「可用卡密 − 已占用需求」 |
| 卡密并发分配 | 事务内 `FOR UPDATE SKIP LOCKED` 取一张 `AVAILABLE` 的卡，一张卡只能锁给一个订单 |
| 重复提交上游 | Worker 用乐观租约（`next_run_at`）抢占订单，多实例部署也安全 |
| 后台操作与 Worker 冲突 | Worker 的每次写入都校验租约；处理期间订单被后台改动时放弃本次结果，并记录 `WORKER_CONFLICT` 日志 |
| 支付回调丢失 | 用户轮询和 Worker 每 30 秒都会主动查询支付状态 |
| 回调伪造或重放 | 支付宝 RSA2 验签 + 校验 app_id；微信 v3 验签 + 时间戳校验 + AES-GCM 解密 + 校验商户号；两者都校验金额；状态更新幂等 |
| 结果不确定（超时、网络错误） | **绝不换卡**，用同一张卡重试，超过次数转人工；重试后上游返回「卡密已使用」时也转人工（可能正是本单已用掉的） |
| Token 安全 | AES-256-GCM 加密存储，页面只显示掩码，订单到终态后立即删除 |
| 订单越权查看 | 订单号 + 随机 `access_key` 双重校验 |

## 接入真实环境

1. **支付**：在 `.env` 中设置 `PAYMENT_PROVIDERS=alipay,wechat` 并填入商户参数。回调地址为 `{BASE_URL}/api/notify/alipay` 和 `{BASE_URL}/api/notify/wechat`，必须是公网 HTTPS。
   - 支付宝：开通「当面付」，使用 RSA2 密钥（应用私钥 + 支付宝公钥）。
   - 微信：开通 Native 支付，配置 APIv3 密钥、商户 API 证书私钥和序列号，以及微信支付公钥（或平台证书公钥）。
2. **上游**：
   - 已对接 aiaiyg.com：设置 `UPSTREAM_DRIVER=aiaiyg` 即可，实现见 [src/upstream/aiaiyg.ts](src/upstream/aiaiyg.ts)。这个上游需要用户的完整登录信息（session JSON，含 `sessionToken`），所以订单页会要求用户粘贴整页内容。
   - 其他上游：设置 `UPSTREAM_DRIVER=http`，然后按上游文档修改 [src/upstream/http.ts](src/upstream/http.ts)。只需把上游的响应映射成 [src/types.ts](src/types.ts) 中 `UpstreamDriver` 定义的标准结果，其中最重要的是正确区分 `cardStatus`（`UNUSED` / `INVALID` / `UNKNOWN`）。
3. **生产配置**：`NODE_ENV=production`，并且必须配置 `TOKEN_SECRET` 和 `ADMIN_PASSWORD`。建议在前面加一层 Nginx 做 HTTPS，并限制 `/admin.html` 和 `/api/admin` 的访问来源。数据库备份由 Supabase 负责（付费版支持时间点恢复）。

## 目录

```
src/
  server.ts            入口
  types.ts             核心类型：订单/卡密状态、支付渠道接口、上游兑换结果
  config.ts            配置（读取 .env）
  db.ts                PostgreSQL 连接池、事务、迁移执行器
migrations/            数据库迁移（按文件名顺序执行一次）
  worker.ts            后台任务：支付补偿查询 / 过期 / 分配卡密 / 提交上游 / 轮询结果
  ratelimit.ts         限流
  services/orders.ts   下单、支付确认、提交 Token
  payments/            alipay.ts / wechat.ts / mock.ts
  upstream/            http.ts（按上游文档修改）/ mock.ts
  routes/              public.ts（前台 + 支付回调）/ admin.ts
public/                index.html / orders.html / order.html / admin.html
scripts/seed.ts        演示数据
```

## 数据库（Supabase）

- **连接方式**：`DATABASE_URL` 使用 Supabase 的 **Session pooler** 连接串（Connect → Direct → Session pooler）。不要用 Direct connection（免费版仅支持 IPv6）。密码中含特殊字符时程序会自动转义，但方括号 `[ ]` 不要保留。
- **安全**：业务表放在 `topup` schema，不在 Data API 默认暴露的 `public` 中；所有表开启 RLS；迁移中撤销了 `anon` / `authenticated` 的全部权限。服务端以表所有者身份直连，不受 RLS 影响。
- **修改表结构**：新增 `migrations/00N_xxx.sql`，启动服务或运行 `npm run migrate` 时自动执行，已执行过的不会重复执行。
- **延迟**：服务器请部署在香港（到新加坡约 30–40ms）。代码已尽量合并查询以减少往返。
- **免费版注意**：一周无访问会被暂停，正式上线前请升级付费版。
