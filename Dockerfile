FROM node:22-alpine

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy app source
COPY . .

# Exclude seed scripts (they're one-offs, not needed at runtime)
# The seed-startup.js is kept for initial data load
RUN rm -f parse-*.js seed.txt seed-tmp.txt && ls seed-*.js 2>/dev/null | grep -v 'seed-startup' | xargs rm -f 2>/dev/null; true

# Create data directory for persistent SQLite
RUN mkdir -p /data
ENV DB_PATH=/data/condo.db

EXPOSE 3456

CMD ["node", "server.js"]
