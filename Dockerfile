# =========================================================
# Multi-stage secure Dockerfile for Google Codmod Web Wrapper
# =========================================================

# Step 1: Base image with Node.js and system dependencies
FROM node:20-slim AS base

# Install system dependencies (git for cloning, curl and ca-certificates for downloading codmod)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Download and install the latest Linux AMD64 'codmod' binary from Google's official GCS bucket
RUN version=$(curl -s https://codmod-release.storage.googleapis.com/latest) \
    && echo "Latest codmod version detected: ${version}" \
    && curl -L -o /usr/local/bin/codmod "https://codmod-release.storage.googleapis.com/${version}/linux/amd64/codmod" \
    && chmod +x /usr/local/bin/codmod \
    && codmod --help > /dev/null # Basic smoke test to verify it executes

# Step 2: Build and package Node.js application
WORKDIR /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Copy package descriptors first to leverage Docker layer caching
COPY package*.json ./

# Install only production dependencies (excluding devDependencies)
RUN npm ci --omit=dev

# Copy the application source code (respects .dockerignore)
COPY . .

# Ensure /tmp/codmod-jobs and config directories exist and are writable
RUN mkdir -p /tmp/codmod-jobs /home/node/.config/codmod /home/node/.config/gcloud /tmp/.config \
    && chmod -R 777 /tmp/codmod-jobs /home/node/.config /tmp/.config

# Change ownership of /app, /tmp, and /home/node/.config to the node user for security
RUN chown -R node:node /app /tmp/codmod-jobs /home/node/.config /tmp/.config

# Set default XDG_CONFIG_HOME so CLI tools write config to writable /tmp/.config
ENV XDG_CONFIG_HOME=/tmp/.config

# Run as non-root user for container hardening
USER node

# Expose the port Express is listening on
EXPOSE 8080

# Start the application
CMD ["npm", "start"]
