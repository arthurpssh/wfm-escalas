FROM 315120000506.dkr.ecr.us-east-1.amazonaws.com/hotmart/alpine/node/24:alpine-3.22

ENV APP_NAME=wfm-escalas
ENV CONTAINER_PORT=3001
ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

# O app não tem dependências de runtime; o package.json precisa ir junto (define "type": "module").
COPY package.json package-lock.json ./

USER root
RUN npm ci --omit=dev
USER app

COPY --chown=app:app server/ ./server/
COPY --chown=app:app shared/ ./shared/
COPY --chown=app:app public/ ./public/

CMD ["node", "server/index.js"]
