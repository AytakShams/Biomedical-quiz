# Single-stage, no npm install: server.js has zero dependencies and node:sqlite is
# built into Node itself. Builds in seconds and there is no lockfile to rot.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/quiz.db
    QUESTION_MS=2500

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

# The SQLite file MUST live on a persistent volume mounted at /data, or every
# redeploy wipes the class results. Mount the DIRECTORY, not the file: WAL mode
# writes quiz.db-wal and quiz.db-shm alongside it.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
