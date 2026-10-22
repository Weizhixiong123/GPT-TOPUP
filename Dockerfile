# Node.js 24 可以直接运行 .ts，不需要编译步骤
FROM node:24-alpine

# TZ：日志时间按北京时间显示
ENV NODE_ENV=production \
    TZ=Asia/Shanghai

WORKDIR /app

# 先只拷依赖清单：代码变了而依赖没变时，这一层可以复用缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# 不用 root 运行
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "src/server.ts"]
