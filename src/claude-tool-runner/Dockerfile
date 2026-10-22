FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS dependencies
WORKDIR /runner
COPY src/claude-tool-runner/package.json src/claude-tool-runner/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The tool runner every Claude Code run uses; the two targets below add only their toolchain.
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS base
# perl-base: the pinned base image ships an older build; take Debian's security fixes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade perl-base \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --omit=dev npm@12.0.2 \
    && npm cache clean --force \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin wardby
WORKDIR /opt/wardby/claude-tool-runner
COPY --from=dependencies /runner/node_modules ./node_modules
COPY src/claude-tool-runner/main.mjs ./main.mjs
COPY src/claude-tool-runner/command.mjs ./command.mjs
# The package-manager shim (src/coding-worker/npm-shim.mjs), linked as npm, pnpm and yarn: verifies
# a project's lockfile with the registry proxy before an install, then runs the real tool (pnpm, and
# a pinned yarn 2+, through corepack). Commands run under `sh -l`, whose /etc/profile resets PATH,
# so profile.d puts the shim back in front.
COPY src/coding-worker/npm-shim.mjs /opt/wardby/bin/npm-shim.mjs
RUN chmod 0755 /opt/wardby/bin/npm-shim.mjs \
    && ln -s npm-shim.mjs /opt/wardby/bin/npm \
    && ln -s npm-shim.mjs /opt/wardby/bin/pnpm \
    && ln -s npm-shim.mjs /opt/wardby/bin/yarn \
    && printf '%s\n' 'case ":$PATH:" in *:/opt/wardby/bin:*) ;; *) PATH="/opt/wardby/bin:$PATH" ;; esac' > /etc/profile.d/wardby-shims.sh \
    && PATH="/opt/wardby/bin:$PATH" npm --version \
    && test "$(sh -lc 'command -v npm')" = /opt/wardby/bin/npm
# The dependency cache (src/coding-worker/dependency-cache.mjs): on a dependency-cache run the worker
# asks this tool runner, before the agent starts, to restore the run's npm dependencies with the same
# npm and environment its commands use. main.mjs imports it as ../coding-worker/dependency-cache.mjs.
COPY src/coding-worker/dependency-cache.mjs /opt/wardby/coding-worker/dependency-cache.mjs
RUN node --input-type=module -e 'const m = await import("/opt/wardby/coding-worker/dependency-cache.mjs"); if (typeof m.prepareDependencies !== "function" || typeof m.sealUploadWindow !== "function") process.exit(1)'
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo \
    && test ! -e /usr/bin/gcc \
    && test ! -e /usr/bin/make \
    && test ! -e /usr/bin/git
USER 10001:10001
ENV NODE_ENV=production HOME=/home/wardby
ENTRYPOINT ["node", "/opt/wardby/claude-tool-runner/main.mjs"]

# node-python (build with --target node-python): the same tool runner plus Python, pytest and ruff,
# matching the Codex node-python worker image (src/coding-worker/Dockerfile.node-python) package for
# package. python3-venv stays: in registry mode the agent installs packages with
# `python -m venv --system-site-packages .venv && .venv/bin/python -m pip install ...`, and pip there
# reaches only the proxy's registry through the PIP_* settings in WARDBY_TOOL_SETUP. The system pip is
# removed (Debian refuses `pip install` outside a venv, and the root filesystem is read-only anyway).
#
# uv and poetry run a Python project's own checks. uv also picks the interpreter: a run cannot
# download one (it reaches only the registry proxy), so uv's managed CPython builds are installed
# here, at build time, into /opt/uv-python, and uv is told to look there and never download. Commands
# run under `sh -l`, where Dockerfile ENV does not apply, so profile.d carries those two settings.
# uv reaches the proxy through the UV_* settings in WARDBY_TOOL_SETUP (src/coding/registry/pypi.ts);
# poetry has no such setting, so it installs only from a project's own configuration.
FROM base AS node-python
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && python3 -m pip install --no-cache-dir --break-system-packages \
        pytest==8.3.4 ruff==0.16.7 uv==0.13.1 poetry==2.5.1 \
    && apt-get purge -y --auto-remove python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    # Most Python projects (and their own docs) say `python`, not `python3`.
    && ln -s /usr/bin/python3 /usr/bin/python \
    && UV_NO_CACHE=1 UV_PYTHON_INSTALL_DIR=/opt/uv-python uv python install --no-bin 3.12 3.13 3.14 \
    && printf '%s\n' \
        'export UV_PYTHON_INSTALL_DIR=/opt/uv-python' \
        'export UV_PYTHON_DOWNLOADS=never' \
        > /etc/profile.d/wardby-uv.sh
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo \
    && test ! -e /usr/bin/gcc \
    && test ! -e /usr/bin/make \
    && test ! -e /usr/bin/git \
    && test ! -e /usr/bin/pip \
    && test ! -e /usr/bin/pip3 \
    && python --version \
    && python -m pytest --version \
    && python -m ruff --version \
    # A registry-mode venv must be creatable offline, carry pip, and still see pytest/ruff.
    && python -m venv --system-site-packages /tmp/venv-check \
    && /tmp/venv-check/bin/python -m pip --version \
    && /tmp/venv-check/bin/python -m pytest --version \
    && rm -rf /tmp/venv-check \
    && test "$(sh -lc 'command -v python')" = /usr/bin/python \
    && uv --version \
    && poetry --version \
    # uv must pick each baked interpreter offline, from a login shell (as a run's commands are).
    && sh -lc 'uv venv --python 3.12 /tmp/uv-check && /tmp/uv-check/bin/python -c "import sys; assert sys.version_info[:2] == (3, 12)"' \
    && sh -lc 'uv venv --python 3.13 /tmp/uv-check13 && /tmp/uv-check13/bin/python --version' \
    && sh -lc 'uv venv --python 3.14 /tmp/uv-check14 && /tmp/uv-check14/bin/python --version' \
    && rm -rf /tmp/uv-check /tmp/uv-check13 /tmp/uv-check14
USER 10001:10001

# The plain Node tool runner: the default target, so `docker build` without --target builds it.
FROM base AS runtime
