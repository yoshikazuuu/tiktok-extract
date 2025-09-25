# Dockerfile for whisper-api (Python)
FROM python:3.11-slim
WORKDIR /app

# Install system dependencies for building whisper.cpp and running the app
RUN apt-get update && apt-get install -y \
    ffmpeg \
    build-essential \
    cmake \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --upgrade pip && pip install yt-dlp

# Clone and build whisper.cpp
RUN git clone https://github.com/ggerganov/whisper.cpp.git && \
    cd whisper.cpp && \
    mkdir -p build && \
    cd build && \
    cmake .. && \
    make -j$(nproc) && \
    ls -la bin/

# Download whisper model
RUN cd whisper.cpp && \
    mkdir -p models && \
    wget -O models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

# Copy project files
COPY . .

# Install Python dependencies
RUN pip install --no-cache-dir .

# Expose port for FastAPI
EXPOSE 8000

# Run FastAPI with uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
