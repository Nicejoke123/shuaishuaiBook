# 微信云托管 · 持仓管家
# 构建上下文 = Dockerfile 所在目录（chicang-guanjia/），与本目录文件平铺对应
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY functions/ ./functions/
COPY dist/ ./dist/
COPY server.mjs mysql-supabase.mjs memory-pool.mjs schema.sql ./
ENV PORT=80 STATIC_DIR=/app/dist NODE_ENV=production
EXPOSE 80
CMD ["node", "server.mjs"]
