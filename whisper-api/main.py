import os
import subprocess
import uuid
import hashlib
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# --- Configuration ---
# Adjust these paths based on your file structure
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WHISPER_CPP_PATH = os.path.join(BASE_DIR, "whisper.cpp")
WHISPER_MODEL_PATH = os.path.join(WHISPER_CPP_PATH, "models", "ggml-base.en.bin")
WHISPER_EXECUTABLE = os.path.join(WHISPER_CPP_PATH, "build", "bin", "whisper-cli")
TEMP_DIR = os.path.join(BASE_DIR, "temp")
CACHE_DIR = os.path.join(BASE_DIR, "cache")

def get_file_hash(file_content: bytes) -> str:
    """Generate a hash from file content for caching"""
    return hashlib.sha256(file_content).hexdigest()

# --- FastAPI App ---
app = FastAPI(title="Whisper.cpp Transcription API", version="1.0.0")

# Add CORS middleware to allow requests from the Hono server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify your Hono server URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create temp and cache directories if they don't exist
os.makedirs(TEMP_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

@app.post("/transcribe")
async def transcribe_video(file: UploadFile = File(...)):
    # Validate file
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    
    # Read file content for hashing and processing
    file_content = await file.read()
    file_hash = get_file_hash(file_content)
    
    # Log the incoming request
    print(f"Received file: {file.filename}, Content-Type: {file.content_type}, Size: {len(file_content)}, Hash: {file_hash}")
    
    # Check if we have cached transcription
    cached_transcription_path = os.path.join(CACHE_DIR, f"{file_hash}.txt")
    if os.path.exists(cached_transcription_path):
        print(f"Found cached transcription for hash: {file_hash}")
        with open(cached_transcription_path, 'r', encoding='utf-8') as f:
            cached_caption = f.read().strip()
        return {"caption": cached_caption, "cached": True}
    
    if not os.path.exists(WHISPER_EXECUTABLE):
        raise HTTPException(status_code=500, detail=f"Whisper executable not found at: {WHISPER_EXECUTABLE}")
    if not os.path.exists(WHISPER_MODEL_PATH):
        raise HTTPException(status_code=500, detail=f"Whisper model not found at: {WHISPER_MODEL_PATH}")

    # Generate unique filenames to avoid conflicts
    unique_id = str(uuid.uuid4())
    temp_input_path = os.path.join(TEMP_DIR, f"{unique_id}_{file.filename}")
    # Whisper requires a 16kHz WAV file
    temp_audio_path = os.path.join(TEMP_DIR, f"{unique_id}.wav")
    # Cached audio file path
    cached_audio_path = os.path.join(CACHE_DIR, f"{file_hash}.wav")

    try:
        # Check if we have cached audio file
        if os.path.exists(cached_audio_path):
            print(f"Found cached audio file for hash: {file_hash}")
            temp_audio_path = cached_audio_path
        else:
            # 1. Save the uploaded file temporarily (could be video or audio)
            print(f"Saving uploaded file to: {temp_input_path}")
            with open(temp_input_path, "wb") as buffer:
                buffer.write(file_content)

            # 2. Use FFmpeg to extract/convert audio to 16kHz mono WAV
            # This handles both video files (extracts audio) and audio files (converts format)
            print(f"Converting audio to WAV format: {cached_audio_path}")
            ffmpeg_result = subprocess.run([
                'ffmpeg', '-y', '-i', temp_input_path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', cached_audio_path
            ], capture_output=True, text=True)
            
            if ffmpeg_result.returncode != 0:
                print(f"FFmpeg error: {ffmpeg_result.stderr}")
                raise HTTPException(status_code=500, detail=f"Audio conversion failed: {ffmpeg_result.stderr}")
            
            temp_audio_path = cached_audio_path

        # 3. Run the Whisper.cpp command
        print(f"Running whisper-cli on: {temp_audio_path}")
        whisper_result = subprocess.run([
            WHISPER_EXECUTABLE, '-m', WHISPER_MODEL_PATH, '-f', temp_audio_path, '--output-txt', '--no-prints'
        ], capture_output=True, text=True, cwd=TEMP_DIR)
        
        if whisper_result.returncode != 0:
            print(f"Whisper error: {whisper_result.stderr}")
            raise HTTPException(status_code=500, detail=f"Transcription failed: {whisper_result.stderr}")

        # 4. Read the transcription from the generated text file
        transcription_path = f"{temp_audio_path}.txt"
        print(f"Reading transcription from: {transcription_path}")
        
        if not os.path.exists(transcription_path):
            raise HTTPException(status_code=500, detail="Transcription file was not generated")
            
        with open(transcription_path, 'r', encoding='utf-8') as f:
            caption = f.read().strip()

        if not caption:
            caption = "[No speech detected]"
        
        # 5. Save transcription to cache
        try:
            with open(cached_transcription_path, 'w', encoding='utf-8') as f:
                f.write(caption)
            print(f"Saved transcription to cache: {cached_transcription_path}")
        except Exception as e:
            print(f"Failed to save transcription to cache: {e}")
            
        print(f"Transcription completed successfully: {len(caption)} characters")
        return {"caption": caption, "cached": False}

    except subprocess.CalledProcessError as e:
        error_msg = f"Subprocess failed: {e.stderr.decode() if e.stderr else str(e)}"
        print(f"Error: {error_msg}")
        raise HTTPException(status_code=500, detail=error_msg)
    except FileNotFoundError as e:
        error_msg = f"Required tool not found: {str(e)}"
        print(f"Error: {error_msg}")
        raise HTTPException(status_code=500, detail=error_msg)
    except Exception as e:
        error_msg = f"Unexpected error: {str(e)}"
        print(f"Error: {error_msg}")
        raise HTTPException(status_code=500, detail=error_msg)
    finally:
        # 6. Clean up only temporary files (keep cache files)
        cleanup_files = [temp_input_path]
        # Only clean up temp audio if it's not the cached version
        if temp_audio_path != cached_audio_path and temp_audio_path.startswith(TEMP_DIR):
            cleanup_files.extend([temp_audio_path, f"{temp_audio_path}.txt"])
        
        for file_path in cleanup_files:
            if os.path.exists(file_path):
                try:
                    os.remove(file_path)
                    print(f"Cleaned up temp file: {file_path}")
                except Exception as e:
                    print(f"Failed to clean up {file_path}: {e}")

@app.get("/")
def read_root():
    return {
        "service": "Whisper.cpp Transcription API", 
        "status": "running",
        "version": "1.0.0",
        "endpoints": {
            "POST /transcribe": "Upload audio/video file for transcription",
            "GET /health": "Health check endpoint"
        },
        "supported_formats": ["mp4", "mp3", "wav", "flac", "ogg"],
        "whisper_model": os.path.basename(WHISPER_MODEL_PATH)
    }

@app.get("/health")
def health_check():
    """Health check endpoint for monitoring"""
    checks = {
        "whisper_executable": os.path.exists(WHISPER_EXECUTABLE),
        "whisper_model": os.path.exists(WHISPER_MODEL_PATH),
        "temp_directory": os.path.exists(TEMP_DIR),
        "cache_directory": os.path.exists(CACHE_DIR)
    }
    
    all_healthy = all(checks.values())
    status_code = 200 if all_healthy else 503
    
    return {
        "status": "healthy" if all_healthy else "unhealthy",
        "checks": checks,
        "whisper_executable_path": WHISPER_EXECUTABLE,
        "whisper_model_path": WHISPER_MODEL_PATH,
        "cache_directory": CACHE_DIR
    }