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
COPY package.json server.js src-server/ public/ docs/ scripts/ ./
# 确保目录存在
RUN mkdir -p data public/uploads public/downloads

# 暴露 API 端口
EXPOSE 3210

# 健康检查（依赖 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3210/api/health || exit 1

# 容器的入口命令（AGENT_DATA_DIR 环境变量覆盖数据目录）
CMD ["node", "server.js"]
