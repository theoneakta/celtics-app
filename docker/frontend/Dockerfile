# Use the lightweight Nginx image
FROM nginx:alpine

# Remove the default Nginx static assets
RUN rm -rf /usr/share/nginx/html/*

# Copy your static files (index.html, etc.) to the Nginx server directory
COPY . /usr/share/nginx/html

# Expose port 841 for the web traffic
EXPOSE 80
EXPOSE 3000

# Nginx starts automatically, so no CMD is strictly required
