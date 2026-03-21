FROM node:24-bookworm

WORKDIR /test

COPY repro.mjs /test/repro.mjs
COPY verify-fix.mjs /test/verify-fix.mjs
COPY verify-integration.mjs /test/verify-integration.mjs

CMD ["node", "/test/verify-integration.mjs"]
