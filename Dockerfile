# MetaForge · 多阶段构建（快速+最小镜像）
# 使用方式：
#   # 构建 + 启动全栈
#   docker compose up -d
#
#   # 单构建
#   docker build -t metaforge .
#   docker run -d -p 3210:3210 -v ./data:/app/data metaforge

# ---- 阶段 1：构建依赖 ----
FROM node:18-slim AS builder
LABEL stage=builder
WORKDIR /app

# 安装编译工具
RUN apt-get update -qq && apt-get install -y -qq \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# 先拷贝 package.json 和 lockfile（利用 Docker 层缓存加速重构建）
COPY package*.json ./
RUN npm install --no-audit --no-fund 2>&1 | tail -3

# ---- 阶段 2：运行时 ----
FROM node:18-slim AS runtime
WORKDIR /app

# 运行时依赖（SQLite、curl 健康检查、vim/vi 等调优工具）
RUN apt-get update -qq && apt-get install -y -qq \
    curl \
    sqlite3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 从 builder 复制 node_modules（含编译好的原生模块）
COPY --from=builder /app/node_modules ./node_modules

# 拷贝项目文件
# XC-4（2026-11-25）：两处历史遗留修复——
# ① 移除 docs/：.dockerignore 既定排除「文档不入生产镜像」，而运行时对 docs/ 零依赖
#   （源码内 docs 引用均为注释）；原 COPY docs/ 与 .dockerignore 自相矛盾，任何平台构建
#   在 checksum 阶段必炸（"/docs": not found）。
# ② 目录独立 COPY 到显式目标：Docker 的 COPY 目录语义是「只拷内容到目标」——原写法
#   `COPY ... src-server/ public/ scripts/ ./` 会把子目录内容摊平进 /app（src-server/db.js
#   落到 /app/db.js），server.js require('./src-server/...') 必挂。此 Dockerfile 写于项目
#   早期（db.js 在根目录）的布局，src-server/ 化重构后从未同步（也从未成功构建过）。
COPY package.json server.js ./
COPY src-server ./src-server
COPY public ./public
COPY scripts ./scripts
# 确保目录存在
RUN mkdir -p data public/uploads public/downloads

# 暴露 API 端口
EXPOSE 3210

# 健康检查（依赖 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3210/api/health || exit 1

# 容器的入口命令（AGENT_DATA_DIR 环境变量覆盖数据目录）
CMD ["node", "server.js"]
