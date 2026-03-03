FROM node:24 AS builder

WORKDIR /bot

# Install system dependencies including build tools for native modules
# libtool is required for sodium-native compilation
RUN apt-get update && \
  apt-get install -y autoconf automake libtool python3 make g++ ca-certificates && \
  rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json /bot/

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy source code
COPY tsconfig.json /bot/
COPY src /bot/src

# Build TypeScript
RUN npm run build

# Remove devDependencies from node_modules for a leaner production image
RUN npm prune --production

# Production stage
FROM node:24

WORKDIR /bot

# Install runtime dependencies only
# ffmpeg is required for audio playback
RUN apt-get update && \
  apt-get install -y ffmpeg ca-certificates && \
  rm -rf /var/lib/apt/lists/*

# Copy package.json for metadata
COPY package.json /bot/

# Copy pre-built native node_modules from builder stage
# This avoids needing build tools (python3, make, g++, etc.) in the production image
COPY --from=builder /bot/node_modules /bot/node_modules

# Copy built JavaScript from builder stage
COPY --from=builder /bot/dist /bot/dist

ENTRYPOINT ["node", "dist/app.js"]
