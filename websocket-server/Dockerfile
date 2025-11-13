# --- 빌드 스테이지 ---
FROM node:23 AS build
WORKDIR /app
COPY package*.json ./
# peer dependency 충돌 방지
RUN npm install --legacy-peer-deps
COPY tsconfig.json ./
COPY src ./src
# tsconfig.json 설정에 따라 src 폴더를 빌드하여 dist 폴더에 JavaScript로 컴파일
RUN npm run build

# --- 런타임 스테이지 ---
FROM node:23-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/index.js"] 

