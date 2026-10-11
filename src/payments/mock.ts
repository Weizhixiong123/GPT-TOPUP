// 本地开发用的模拟支付：二维码指向 /mock-pay/:orderNo，点击按钮即视为付款成功
import config from '../config.ts';
import type { PaymentProvider } from '../types.ts';

const paid = new Map<string, number>(); // orderNo -> amountCents

const mock: PaymentProvider & { markPaid(orderNo: string, amountCents: number): void } = {
  name: 'mock',
  label: '模拟支付（开发）',

  async createQr({ orderNo }) {
    return { qr: `${config.baseUrl}/mock-pay/${orderNo}` };
  },

  async query(orderNo) {
    const amount = paid.get(orderNo);
    return amount === undefined ? { paid: false } : { paid: true, tradeNo: `MOCK-${orderNo}`, amountCents: amount };
  },

  markPaid(orderNo, amountCents) {
    paid.set(orderNo, amountCents);
  },
};

export default mock;
