FROM ghcr.io/wardby/wardby/wardby-coding-worker-driver@sha256:ae7a503209a8a54dd8b4b4d825b2f875ff78ddcdc1c2ed461b0f686e3e189c4e AS runtime
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo \
    && test ! -e /usr/bin/gcc \
    && test ! -e /usr/bin/make
USER 10001:10001
ENV NODE_ENV=production HOME=/home/wardby
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/wardby/coding-worker/main.js"]
