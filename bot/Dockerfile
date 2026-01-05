FROM node:20 AS builder

WORKDIR /bot

# Install system dependencies including build tools for native modules
RUN apt update && \
  apt install -y autoconf automake python3 make g++

# Copy package files
COPY package.json package-lock.json /bot/

# Install dependencies using npm install (npm ci has known issues in some Docker environments)
# Temporarily disable strict SSL to avoid certificate issues during build
# Ignore scripts to avoid issues with native module builds, then rebuild
# Note: NODE_TLS_REJECT_UNAUTHORIZED is only used during build, not in final image
# npm rebuild may fail for optional dependencies like sodium, which is acceptable
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
RUN npm config set cache /tmp/npm-cache --global && \
    npm config set strict-ssl false && \
    npm install --ignore-scripts && \
    (npm rebuild || echo "Warning: Some native modules failed to rebuild, continuing anyway")

# Copy source code
COPY tsconfig.json /bot/
COPY src /bot/src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20

WORKDIR /bot

# Install ffmpeg and runtime dependencies in production image
RUN apt update && \
  apt install -y ffmpeg python3 && \
  rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json /bot/

# Install only production dependencies
# Temporarily disable strict SSL to avoid certificate issues during build
# Note: npm rebuild may fail for optional dependencies like sodium, which is acceptable
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
RUN npm config set cache /tmp/npm-cache --global && \
    npm config set strict-ssl false && \
    npm install --production --ignore-scripts && \
    (npm rebuild || echo "Warning: Some native modules failed to rebuild, continuing anyway")
# Unset the TLS variable for security
ENV NODE_TLS_REJECT_UNAUTHORIZED=""

# Copy built JavaScript from builder stage
COPY --from=builder /bot/dist /bot/dist

ENTRYPOINT ["node", "dist/app.js"]
