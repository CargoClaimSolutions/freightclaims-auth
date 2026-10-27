FROM ghcr.io/zitadel/zitadel-login:v4.16.2
USER root
COPY deploy/zitadel-login/recover-dead-sessions.mjs /tmp/recover-dead-sessions.mjs
RUN node /tmp/recover-dead-sessions.mjs /app/apps/login/.next/server && rm /tmp/recover-dead-sessions.mjs
USER nextjs
