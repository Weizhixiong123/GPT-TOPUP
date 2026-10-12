-- 新增订单状态 CANCELLED：用户在支付前主动取消。
-- 和 EXPIRED（超时未支付）分开，后台能区分是用户不想买了还是没来得及付。
-- 取消后如果钱还是到了（极少数情况下取消和付款同时发生），订单会像过期订单一样恢复为 PAID。
-- 编号从 004 开始：有的库里已经有 002、003 两条来自其他版本代码的迁移记录，避开同名。

ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'PENDING_PAYMENT', 'PAID', 'QUEUED', 'REDEEMING', 'SUCCESS',
  'FAILED', 'EXPIRED', 'CANCELLED', 'MANUAL_REVIEW', 'REFUNDED'));
