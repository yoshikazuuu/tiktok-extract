#!/bin/bash

echo "Installing yt-dlp..."

# Check if Python is available
if ! command -v python3 &> /dev/null; then
    echo "Python3 is required but not installed. Please install Python3 first."
    exit 1
fi

# Check if pip is available
if ! command -v pip3 &> /dev/null; then
    echo "pip3 is required but not installed. Please install pip3 first."
    exit 1
fi

# Install yt-dlp
echo "Installing yt-dlp via pip3..."
pip3 install -U yt-dlp

# Verify installation
if command -v yt-dlp &> /dev/null; then
    echo "✅ yt-dlp installed successfully!"
    echo "Version: $(yt-dlp --version)"
else
    echo "❌ yt-dlp installation failed. Please install manually."
    echo "Try: pip3 install -U yt-dlp"
    exit 1
fi

echo ""
echo "🎉 Setup complete! You can now run your TikTok transcription service."
echo "Make sure to start your Whisper service on http://localhost:8000/transcribe"