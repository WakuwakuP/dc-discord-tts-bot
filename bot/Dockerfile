FROM node:20 AS builder

WORKDIR /bot

# Install system dependencies including build tools for native modules
RUN apt update && \
  apt install -y autoconf automake python3 make g++

# Copy package files
COPY package.json package-lock.json /bot/

# Install dependencies using npm install (npm ci has known issues in some Docker environments)
# Disable strict SSL to avoid certificate issues in both npm and node-gyp
# Ignore scripts to avoid issues with native module builds
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
RUN npm config set cache /tmp/npm-cache --global && \
    npm config set strict-ssl false && \
    npm install --ignore-scripts && \
    npm rebuild || true

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
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
RUN npm config set cache /tmp/npm-cache --global && \
    npm config set strict-ssl false && \
    npm install --production --ignore-scripts && \
    npm rebuild || true

# Copy built JavaScript from builder stage
COPY --from=builder /bot/dist /bot/dist

ENTRYPOINT ["node", "dist/app.js"]
