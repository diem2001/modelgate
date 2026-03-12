FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apk del python3 make g++
COPY --from=builder /app/dist/ dist/
COPY admin/ admin/

# Self-host fonts for GDPR compliance (downloaded fresh on every build)
COPY admin/fonts/download-fonts.sh admin/fonts/download-fonts.sh
RUN sh admin/fonts/download-fonts.sh && rm admin/fonts/download-fonts.sh

EXPOSE 4000
CMD ["node", "dist/index.js"]
