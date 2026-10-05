# Build stage
FROM rust:1.96-slim AS builder

WORKDIR /build

# Install dependencies for cargo build
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy only what's needed for build
COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/

# Build release binary
RUN cargo build --release --manifest-path Cargo.toml --target x86_64-unknown-linux-gnu

# Production stage
FROM debian:bookworm-slim

# Install minimal runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the built binary
COPY --from=builder /build/target/x86_64-unknown-linux-gnu/release/nearcade-router /usr/local/bin/nearcade-router

# Create non-root user
RUN useradd --no-create-home --shell /usr/sbin/nologin nearcade && \
    chmod +x /usr/local/bin/nearcade-router

# Create config directory
RUN mkdir -p /etc/nearcade && \
    chown -R nearcade:nearcade /etc/nearcade

USER nearcade

# Environment variables (can be overridden at runtime)
ENV PORT=9000
ENV MASTER_KEY=""
ENV LOG_LEVEL="info"

# Expose router port
EXPOSE 9000

# Health check - check if process is running (no HTTP endpoint available)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD pgrep -x nearcade-router > /dev/null || exit 1

CMD ["--port", "9000"]
