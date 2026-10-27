# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim
# Optional combined CA bundle supports verified builds in managed proxy environments.
RUN --mount=type=secret,id=ca_bundle \
    if [ -f /run/secrets/ca_bundle ]; then \
      apt-get -o Acquire::https::CaInfo=/run/secrets/ca_bundle update && \
      apt-get -o Acquire::https::CaInfo=/run/secrets/ca_bundle install -y --no-install-recommends ffmpeg ca-certificates; \
    else \
      apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates; \
    fi && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir /app/.data && chown node:node /app/.data
USER node
ENV NODE_ENV=production PORT=10000 HOST=0.0.0.0 DATA_DIR=/app/.data
EXPOSE 10000
CMD ["npm", "start"]
