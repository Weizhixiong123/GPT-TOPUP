import config from '../config.ts';
import { HttpError, type PayChannel, type PaymentProvider } from '../types.ts';
import mock from './mock.ts';
import alipay from './alipay.ts';
import wechat from './wechat.ts';

const all: Record<PayChannel, PaymentProvider> = { mock, alipay, wechat };

export const enabled: readonly PayChannel[] = config.payment.enabled;

export function isEnabled(name: string): name is PayChannel {
  return (enabled as readonly string[]).includes(name);
}

export function get(name: string): PaymentProvider {
  if (!isEnabled(name)) throw new HttpError(400, '不支持的支付方式');
  return all[name];
}

export const list = (): { name: PayChannel; label: string }[] => enabled.map((n) => ({ name: n, label: all[n].label }));
