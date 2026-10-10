FROM node:24.10.0-bookworm-slim@sha256:b8d2197aff9129d16c801a3e3e1b2a873c4946480f5a310f38056df2268c38d9

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.161.0 \
    && npm cache clean --force

ENV HOME=/runtime \
    CODEX_HOME=/runtime/codex

WORKDIR /workspace
ENTRYPOINT ["codex", "app-server"]
