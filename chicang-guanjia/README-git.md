# 持仓管家 · 部署说明

本目录是独立于仓库原项目（shuaishuaiBook）的第二个应用：基金/黄金/股票持仓建议工具，自带前端（dist/）、后端（server.mjs + functions/）和建表脚本（schema.sql），数据库使用 MySQL。

两种部署方式（细节见 README.md）：

1. 上传代码包（推荐，最省事）：用 chicang-cloudrun.zip 在微信云托管新建服务，端口 80。
2. Git 部署：关联本仓库，Dockerfile 路径指定为 `chicang-guanjia/Dockerfile`（该文件内路径已按仓库根上下文编写）。需要本仓库保持私有时请设为私有仓库。

无论哪种方式，都请先在 MySQL 中执行 `chicang-guanjia/schema.sql` 建表，并在服务环境变量中填写 DB_HOST / DB_USER / DB_PASSWORD / DB_NAME（云托管自带 MySQL 时自动注入 WX_MYSQL_* 也可以）。数据库密码只填在控制台，不要写进代码或聊天记录。
