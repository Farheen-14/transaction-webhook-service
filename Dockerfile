# Optional container image for the API (the EC2 deployment runs Node + pm2 directly).
# Multi-stage build: compile in a full image, ship only what is needed to run.

# ---- Stage 1: build ----------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package*.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src ./src
# Compile TypeScript, then drop devDependencies (TypeScript, Nest CLI) from node_modules.
RUN npm run build && npm prune --omit=dev

# ---- Stage 2: runtime --------------------------------------------------------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Run as the unprivileged "node" user instead of root.
USER node
EXPOSE 3000
# Lets Docker/orchestrators restart the container if GET / stops answering.
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/ || exit 1
CMD ["node", "dist/main.js"]
