import config from '../config.ts';
import { HttpError, type PayChannel, type PaymentProvider } from '../types.ts';
import mock from './mock.ts';
import { createEpayProvider } from './epay.ts';

// 支付宝、微信都通过易支付收款（同一个易支付商户，下单时 type 不同）
const all: Record<PayChannel, PaymentProvider> = {
  mock,
  alipay: createEpayProvider('alipay', '支付宝', 'alipay'),
  wechat: createEpayProvider('wechat', '微信支付', 'wxpay'),
};

export const enabled: readonly PayChannel[] = config.payment.enabled;

export function isEnabled(name: string): name is PayChannel {
  return (enabled as readonly string[]).includes(name);
}

export function get(name: string): PaymentProvider {
  if (!isEnabled(name)) throw new HttpError(400, '不支持的支付方式');
  return all[name];
}

export const list = (): { name: PayChannel; label: string }[] => enabled.map((n) => ({ name: n, label: all[n].label }));
