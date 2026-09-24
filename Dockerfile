FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --chown=node:node package.json server.mjs archive.mjs api-scheduler.mjs api-circuit-breaker.mjs douyin-url.mjs parser-errors.mjs ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data/tasks && chown -R node:node /app/data

USER node
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
