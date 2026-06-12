FROM node:20-alpine

WORKDIR /app

# Install dependencies (with dev deps for build + prisma)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and prisma schema
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Build TypeScript
RUN npm run build

EXPOSE 3000

CMD ["node", "dist/server.js"]
