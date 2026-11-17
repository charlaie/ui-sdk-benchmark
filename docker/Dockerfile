# Image the coding agents run in. The agent CLIs themselves are bind-mounted read-only from the host
# (see runner/lib/isolation.mjs) so the benchmark uses exactly the host's pinned CLI versions.
FROM node:26.13.1-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl procps python3 less \
 && rm -rf /var/lib/apt/lists/*
ENV HOME=/home/agent \
    IS_SANDBOX=1 \
    DISABLE_AUTOUPDATER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
RUN mkdir -p /home/agent /work
WORKDIR /work
