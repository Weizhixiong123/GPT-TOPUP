// 上游兑换接口适配层。接口约定见 types.ts 的 UpstreamDriver / SubmitResult / QueryResult。
// aiaiyg.ts 是已对接好的上游；http.ts 是通用示例，接入其他上游时照着改。
import config from '../config.ts';
import type { UpstreamDriver } from '../types.ts';
import mock from './mock.ts';
import http from './http.ts';
import aiaiyg from './aiaiyg.ts';

const drivers: Record<typeof config.upstream.driver, UpstreamDriver> = { mock, http, aiaiyg };

const upstream: UpstreamDriver = drivers[config.upstream.driver];

export default upstream;
