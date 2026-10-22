/** 带 HTTP 状态码的错误：消息会原样返回给页面，只放给买家看的文字 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
