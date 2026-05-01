FROM denoland/deno:latest

WORKDIR /app

# Copy source files
COPY deno.json .
COPY logger.ts .
COPY types.ts .
COPY config.ts .
COPY auth.ts .
COPY persist.ts .
COPY usage.ts .
COPY translate.ts .
COPY stream.ts .
COPY main.ts .
COPY relay-config.example.json .

# Create data directory for logs and usage tracking
RUN mkdir -p /app/data

# Expose port
EXPOSE 7150

# Run with necessary permissions (added --allow-write for data directory)
CMD ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "main.ts"]