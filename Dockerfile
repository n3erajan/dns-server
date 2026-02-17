FROM node:22-alpine

WORKDIR /app
COPY package*.json .
RUN npm install
COPY . .

EXPOSE 53
EXPOSE 8053

CMD [ "npm","start" ]