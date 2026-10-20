# syntax=docker/dockerfile:1

FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    LOG_DIR=/logs

WORKDIR /app

# Dependencies first so the layer is cached between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The state and log directories are volume mounts on the host; creating them
# here keeps the image usable without one. Ownership is fixed at start-up by
# the entrypoint, because the mount happens after the image is built.
RUN mkdir -p /data /logs \
    && chown -R node:node /app /data /logs \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
