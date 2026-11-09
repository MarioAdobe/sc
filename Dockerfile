FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
USER pwuser
CMD ["node", "server.js"]
