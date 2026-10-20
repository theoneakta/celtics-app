# Use the official Node.js Long Term Support image
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package.json ./

RUN npm install
RUN npm install axios
# Bundle app source
COPY . .

# The port your server.js is listening on
EXPOSE 3000

# Start the application
CMD [ "node", "server.js" ]