FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm i --no-save prisma@7.10.0
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated
# fonts for PDF invoices / packing slips (DejaVu Sans has the ₦ glyph)
COPY --from=build /app/src/assets ./src/assets
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN mkdir -p uploads && chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
