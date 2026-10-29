FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*
# Binário do curl-impersonate (cliente TLS da Stake) baixado no build: se não rodar nesta imagem,
# o build falha aqui em vez de a Stake ficar bloqueada em produção.
RUN node -e "import('cuimp').then(async (m) => { const b = await m.downloadBinary({ descriptor: { browser: 'chrome', version: 'latest' } }); console.log(b.binaryPath); require('child_process').execFileSync(b.binaryPath, ['--version'], { stdio: 'inherit' }); })"
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY public ./public
ENV PORT=3000
ENV DISPLAY=:99
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "Xvfb :99 -screen 0 1366x900x24 -nolisten tcp & for i in 1 2 3 4 5 6 7 8 9 10; do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.5; done; exec node dist/index.js"]
