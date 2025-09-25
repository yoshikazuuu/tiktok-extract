# TikTok Extract

This repository contains a TikTok video transcription service that extracts audio from TikTok videos and generates captions using Whisper AI.

## Overview

The project is structured as a microservices application and includes the following components:

- **`/api`**: A Bun.js API service built with Hono framework that handles TikTok video extraction using tikwm.com API, caching, and coordinates transcription requests.
- **`/whisper-api`**: A Python FastAPI service that runs Whisper.cpp for audio transcription and speech-to-text processing.

## Features

- Extract TikTok videos from various URL formats
- Download video or audio-only content for faster processing
- Generate accurate transcriptions using Whisper AI
- Intelligent caching system for improved performance
- Debug information and performance metrics
- RESTful API with comprehensive error handling

## Getting Started

The entire application stack can be run using Docker.

1. Ensure you have Docker and Docker Compose installed.
2. From the root of the repository, run the following command:

```bash
docker-compose up --build
```

This will build the images for each service and start the containers.

## API Endpoints

- **POST /caption** - Get transcription of a TikTok video
- **POST /download** - Download TikTok video directly
- **GET /** - View API documentation and examples

## Usage Example

```bash
curl -X POST "http://localhost:3000/caption?audio_only=true" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.tiktok.com/@username/video/1234567890123456789"}'
```