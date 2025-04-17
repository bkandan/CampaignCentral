#!/bin/bash

# simple-start.sh - A simplified startup script that explicitly loads .env variables
# This script starts the server in production mode with minimal complexity

echo "=== Starting CampaignHub with simplified startup ==="

# Load environment variables from .env file
if [ -f .env ]; then
  echo "Loading environment variables from .env file..."
  # Use a safer method that handles empty lines and special characters better
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and empty lines
    if [[ ! "$line" =~ ^# ]] && [[ -n "$line" ]]; then
      # Extract variable and value
      if [[ "$line" =~ ^([^=]+)=(.*)$ ]]; then
        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[2]}"
        export "$key=$value"
      fi
    fi
  done < .env
  echo "Environment variables loaded successfully"
else
  echo "Warning: .env file not found"
fi

# Check if we have a built version, otherwise build it
if [ ! -d "dist/client" ] || [ ! -f "dist/index.js" ]; then
  echo "Production build not found. Building application..."
  
  # Install necessary build dependencies if missing
  if ! command -v npx &> /dev/null; then
    echo "Installing build dependencies..."
    npm install --no-save typescript esbuild vite @vitejs/plugin-react
  fi
  
  echo "Building client..."
  NODE_ENV=production npx vite build
  
  echo "Building server..."
  NODE_ENV=production npx esbuild server/index.ts --platform=node --packages=external --bundle --format=esm --outdir=dist
fi

# Start the server
echo "Starting server..."
NODE_ENV=production node dist/index.js