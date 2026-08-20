# syntax=docker/dockerfile:1

# Conquest ships as a single long-running Node process. The image is built in
# three stages so the compiler and the C++ toolchain that better-sqlite3 needs
# stay out of the runtime layer.

FROM node:lts-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# better-sqlite3 publishes prebuilt bindings for glibc only, so on musl it is
# compiled from source and node-gyp's prerequisites are required.
RUN apk add --no-cache python3 make g++ \
    && npm install --global pnpm@11
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Everything, including TypeScript and the code generators.
FROM base AS deps
RUN pnpm install --frozen-lockfile

# Runtime dependencies alone, with the native bindings built against this
# image's musl so they can be copied forward as-is.
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build
# The dataset regenerators are development tools that import devDependencies;
# only `deploy-commands` is meant to be run against the image.
RUN rm -f build/src/scripts/generate-*.js build/src/scripts/generate-*.js.map

FROM node:lts-alpine AS runtime
ENV NODE_ENV=production \
    CONQUEST_DB_PATH=/data/conquest.db
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./

# The game database lives outside the image; a fresh container onto the same
# volume picks the round back up, deadlines included.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

# Conquest installs its own SIGINT/SIGTERM handlers, so it can run as PID 1 and
# still shut down cleanly.
CMD ["node", "build/src/index.js"]
