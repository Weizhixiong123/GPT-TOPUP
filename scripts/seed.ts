// 初始化演示数据：Plus / Pro 5x / Pro 20x 三个套餐 + 若干测试卡密（其中一张以 BAD 开头，用于演示自动换卡）
import { get, run, now, migrate, closeDb } from '../src/db.ts';

await migrate();

if (((await get<{ c: number }>('SELECT COUNT(*) c FROM plans'))?.c ?? 0) > 0) {
  console.log('已有套餐数据，跳过');
} else {
  // 价格为占位，请在后台「套餐」页按实际售价修改
  const plans: [name: string, description: string, priceCents: number, cardPrefix: string][] = [
    ['ChatGPT Plus 1个月', '日常对话、写作与学习', 13900, 'PLUS'],
    ['ChatGPT Pro 5x 1个月', '适合高频使用', 69900, 'PRO5'],
    ['ChatGPT Pro 20x 1个月', '适合重度使用', 139900, 'PRO20'],
  ];

  for (const [i, [name, desc, price, prefix]] of plans.entries()) {
    const plan = await get<{ id: number }>(
      'INSERT INTO plans (name, description, price_cents, sort, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      name, desc, price, i + 1, now(),
    );
    if (!plan) throw new Error(`创建套餐失败: ${name}`);
    const codes = [...(i === 0 ? ['BAD-DEMO-0001'] : []), ...Array.from({ length: 5 }, (_, n) => `${prefix}-DEMO-${String(n + 1).padStart(4, '0')}`)];
    for (const code of codes) {
      await run('INSERT INTO card_keys (plan_id, code, created_at) VALUES ($1, $2, $3)', plan.id, code, now());
    }
  }
  console.log('演示数据已写入');
}

await closeDb();
