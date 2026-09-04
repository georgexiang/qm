ARG CORE_BASE
FROM ${CORE_BASE}

ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
COPY src/config.ts /app/src/config.ts