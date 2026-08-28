# Brain Interface — the image Harness builds, stores and runs.
#
#     harness pipeline ──▶ this image ──▶ Harness registry ──▶ your machine
#
# Two stages, because the build needs npm and the result does not: the
# interface compiles to static files, and the gateway is plain Node ESM on
# built-in modules only. The runtime image therefore carries no node_modules
# at all — just Node, the built bundle and the server.

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /src

# The lockfile alone decides what is installed, so it is copied first and the
# layer is reused until a dependency actually changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# Vite bakes every VITE_* value into the bundle at build time, which is why
# they are build arguments here and not runtime environment.
ARG VITE_ZERO_WS_URL=/zero-ws
ARG VITE_ZERO_VOICE_PROVIDER=zero-realtime
ARG VITE_ZERO_FISH_VOICE_ID=
ARG VITE_ZERO_AGENT_ROOT=
ARG VITE_ZERO_SPEECH_LANGUAGE=de-DE
ENV VITE_ZERO_WS_URL=$VITE_ZERO_WS_URL \
    VITE_ZERO_VOICE_PROVIDER=$VITE_ZERO_VOICE_PROVIDER \
    VITE_ZERO_FISH_VOICE_ID=$VITE_ZERO_FISH_VOICE_ID \
    VITE_ZERO_AGENT_ROOT=$VITE_ZERO_AGENT_ROOT \
    VITE_ZERO_SPEECH_LANGUAGE=$VITE_ZERO_SPEECH_LANGUAGE
RUN npm run build && test -f dist/index.html

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# Chromium is ZERO's internet access: the browser bridge drives it over the
# DevTools Protocol. It is a real browser in the image, so the bridge works
# without a browser on the host. The path is deliberately not pinned — the
# bridge's own detection covers both Alpine spellings and PATH, and a pinned
# path that turns out to be wrong would report the browser as installed and
# then fail to launch it.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont tini

WORKDIR /app
COPY --from=build /src/dist ./dist
COPY --from=build /src/server ./server
COPY --from=build /src/mcp ./mcp
COPY --from=build /src/package.json ./package.json

# The gateway generates its pairing token on first run and must be able to
# write it. /data is the volume that keeps it across restarts.
RUN mkdir -p /data && addgroup -S zero && adduser -S -G zero zero \
    && chown -R zero:zero /app /data
USER zero

ENV NODE_ENV=production \
    ZERO_UI_PORT=3000 \
    ZERO_UI_DIST=/app/dist \
    ZERO_TOKEN_FILE=/data/gateway-token \
    ZERO_GATEWAY_URL=http://127.0.0.1:3000
VOLUME ["/data"]

# Harness Open Source itself listens on 3000. Publish this one elsewhere on
# the host (`-p 3001:3000`); the interface resolves /zero-ws against whatever
# origin served it, so a different port needs no rebuild.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/gateway/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps the browser processes the bridge starts.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/gateway.mjs"]
