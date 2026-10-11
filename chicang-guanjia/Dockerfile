# 微信云托管 · 持仓管家（Git 部署版：构建上下文为仓库根目录）
# 若用「上传代码包」方式部署，用项目里 chicang-cloudrun.zip 即可，其 Dockerfile 路径为扁平布局
FROM node:22-alpine
WORKDIR /app
COPY chicang-guanjia/package.json ./package.json
RUN npm install --omit=dev
COPY chicang-guanjia/functions/ ./functions/
COPY chicang-guanjia/dist/ ./dist/
COPY chicang-guanjia/server.mjs chicang-guanjia/mysql-supabase.mjs chicang-guanjia/memory-pool.mjs chicang-guanjia/schema.sql ./
ENV PORT=80 STATIC_DIR=/app/dist NODE_ENV=production
EXPOSE 80
CMD ["node", "server.mjs"]
