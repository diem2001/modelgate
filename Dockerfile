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
COPY admin/fonts/download-fonts.sh admin/fonts/download-fonts.sh
RUN sh admin/fonts/download-fonts.sh && rm admin/fonts/download-fonts.sh

EXPOSE 4000
CMD ["node", "dist/index.js"]
