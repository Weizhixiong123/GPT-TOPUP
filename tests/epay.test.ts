import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

test('手机页面跳转支付及桌面下单', async (t) => {
  // 使用临时密钥和本地虚拟配置，不访问支付平台或数据库。
  process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
  process.env.PAYMENT_PROVIDERS = 'mock';
  process.env.NODE_ENV = 'development';
  process.env.BASE_URL = 'http://localhost:3000';
  const { default: config } = await import('../src/config.ts');
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(config.payment.epay, {
    apiUrl: 'https://pay.example.test',
    pid: '1001',
    merchantPrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    platformPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  const { createEpayProvider, sign } = await import('../src/payments/epay.ts');
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  globalThis.fetch = async () => { throw new Error('手机下单不应请求平台'); };
  const input = {
    orderNo: 'T20261014201808000001', amountCents: 14000,
    subject: '测试套餐 & Plus', expireAt: clock + 900_000,
    mobile: true, clientIp: '192.0.2.1',
  };
  try {
    for (const [channel, type] of [['alipay', 'alipay'], ['wechat', 'wxpay']] as const) {
      await t.test(`${channel}手机使用签名的submit链接`, async () => {
        const provider = createEpayProvider(channel, channel, type);
        const { qr } = await provider.createQr(input);
        const url = new URL(qr);
        assert.equal(url.pathname, '/api/pay/submit');
        assert.equal(url.searchParams.get('type'), type);
        assert.equal(url.searchParams.get('money'), '140.00');
        assert.equal(url.searchParams.get('out_trade_no'), input.orderNo);
        assert.equal(url.searchParams.get('name'), input.subject);
        assert.equal(url.searchParams.get('notify_url'), `${config.baseUrl}/api/notify/epay`);
        assert.equal(url.searchParams.has('method'), false);
        assert.equal(url.searchParams.has('clientip'), false);
        const params = Object.fromEntries(url.searchParams);
        const content = Object.keys(params).filter((k) => !['sign', 'sign_type'].includes(k)).sort()
          .map((k) => `${k}=${params[k]}`).join('&');
        assert.ok(crypto.verify('RSA-SHA256', Buffer.from(content), keys.publicKey, Buffer.from(params.sign, 'base64')));
        clock += 600_000;
        const refreshed = new URL(provider.refreshLink!(qr));
        assert.equal(refreshed.searchParams.get('timestamp'), String(clock / 1000));
        assert.equal(refreshed.searchParams.get('out_trade_no'), input.orderNo);
        assert.equal(provider.refreshLink!('https://other.test/pay'), 'https://other.test/pay');
      });
    }
    await t.test('桌面继续使用web和pc参数', async () => {
      let calls = 0;
      globalThis.fetch = async (_url, init) => {
        calls++;
        const params = new URLSearchParams(String(init?.body));
        assert.equal(params.get('method'), 'web');
        assert.equal(params.get('device'), 'pc');
        const result = { code: 0, pay_type: 'qrcode', pay_info: 'weixin://test' };
        return new Response(JSON.stringify({ ...result, sign: sign(result) }));
      };
      const result = await createEpayProvider('wechat', '微信', 'wxpay').createQr({ ...input, mobile: false });
      assert.equal(result.qr, 'weixin://test');
      assert.equal(calls, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});
