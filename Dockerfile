FROM denoland/deno:latest

WORKDIR /app

# Copy source files
COPY deno.json .
COPY logger.ts .
COPY types.ts .
COPY config.ts .
COPY translate.ts .
COPY stream.ts .
COPY main.ts .
COPY relay-config.example.json .

# Expose port
EXPOSE 7150

# Run with necessary permissions
CMD ["run", "--allow-net", "--allow-read", "--allow-env", "main.ts"]