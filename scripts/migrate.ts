// 执行数据库迁移（服务启动时也会自动执行，这里用于单独建表/升级）
import { migrate, closeDb } from '../src/db.ts';
import config from '../src/config.ts';

const applied = await migrate();
console.log(applied.length ? `已执行迁移: ${applied.join(', ')}` : '数据库已是最新');
console.log(`schema: ${config.dbSchema}`);
await closeDb();
