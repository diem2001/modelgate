FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
COPY admin/ admin/

# Self-host fonts for GDPR compliance (downloaded fresh on every build)
RUN mkdir -p admin/fonts && \
    wget -q -O admin/fonts/jetbrains-mono.woff2 "https://fonts.gstatic.com/s/jetbrainsmono/v21/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKxjPVmUsaaDhw.woff2" && \
    wget -q -O admin/fonts/plus-jakarta-sans.woff2 "https://fonts.gstatic.com/s/plusjakartasans/v8/LDIbaomQNQcsA88c7O9yZ4KMCoOg4IA6-91aHEjcWuA_qU79TR_V.woff2"

EXPOSE 4000
CMD ["node", "dist/index.js"]
