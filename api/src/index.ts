import { Hono } from 'hono';
import { writeFile, unlink, readFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const app = new Hono();

const TIKTOK_URL_PATTERN = /^https?:\/\/(www\.)?(tiktok\.com|vm\.tiktok\.com)/;
// The URL of the Whisper worker service you just created.
const WHISPER_API_URL = process.env.WHISPER_API_URL || 'http://localhost:8000/transcribe';

// Cache directory for downloaded videos
const CACHE_DIR = join(process.cwd(), 'cache');

// Initialize cache directory
async function initCacheDir() {
  try {
    await access(CACHE_DIR);
  } catch {
    await mkdir(CACHE_DIR, { recursive: true });
    console.log('Created cache directory:', CACHE_DIR);
  }
}

// Generate cache key from URL
function getCacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

// tikwm API response types
interface TikwmVideoInfo {
  id: string;
  title: string;
  author: {
    unique_id: string;
    nickname: string;
  };
  duration: number;
  play: string;
  music: string;
  cover: string;
  origin_cover: string;
  size: number;
  wm_size: number;
  hd_size: number;
  wmplay: string;
  hdplay: string;
}

interface TikwmResponse {
  code: number;
  msg: string;
  processed_time: number;
  data: TikwmVideoInfo;
}

// Helper function to get video info from tikwm API
async function getVideoInfo(videoUrl: string): Promise<TikwmVideoInfo> {
  try {
    const tikwmApiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}&hd=1`;
    const response = await fetch(tikwmApiUrl);

    if (!response.ok) {
      throw new Error(`tikwm API request failed: ${response.status} ${response.statusText}`);
    }

    const tikwmData = await response.json() as TikwmResponse;

    if (tikwmData.code !== 0) {
      throw new Error(`tikwm API error: ${tikwmData.msg}`);
    }

    return tikwmData.data;
  } catch (error) {
    throw new Error(`Failed to get video info from tikwm: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Helper function to download media from tikwm API
async function downloadMedia(videoUrl: string, audioOnly: boolean = false): Promise<{ buffer: Buffer; filename: string; contentType: string; cached: boolean }> {
  await initCacheDir();

  const cacheKey = getCacheKey(videoUrl);
  const extension = audioOnly ? 'mp3' : 'mp4';
  const cachedFile = join(CACHE_DIR, `${cacheKey}.${extension}`);

  // Check if file already exists in cache
  try {
    await access(cachedFile);
    console.log('Found cached file for:', videoUrl);
    const buffer = await readFile(cachedFile);
    return {
      buffer,
      filename: `tiktok_${cacheKey}.${extension}`,
      contentType: audioOnly ? 'audio/mp3' : 'video/mp4',
      cached: true
    };
  } catch {
    // File doesn't exist in cache, proceed with download
  }

  try {
    // Get video info first
    const videoInfo = await getVideoInfo(videoUrl);

    // Choose download URL based on audioOnly preference
    let downloadUrl: string;
    if (audioOnly) {
      downloadUrl = videoInfo.music; // Audio URL
    } else {
      // Choose the best video quality available
      downloadUrl = videoInfo.hdplay || videoInfo.play || videoInfo.wmplay;
    }

    if (!downloadUrl) {
      throw new Error('No suitable download URL found');
    }

    // Download the media file
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Save to cache
    try {
      await writeFile(cachedFile, buffer);
      console.log('Saved to cache:', cachedFile);
    } catch (error) {
      console.warn('Failed to save to cache:', error);
    }

    return {
      buffer,
      filename: `tiktok_${cacheKey}.${extension}`,
      contentType: audioOnly ? 'audio/mp3' : 'video/mp4',
      cached: false
    };
  } catch (error) {
    throw new Error(`Failed to download media: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// The download endpoint using tikwm API
app.post('/download', async (c) => {
  const { url } = await c.req.json();
  const hq = c.req.query('hq') === 'true';

  if (!url || !TIKTOK_URL_PATTERN.test(url)) {
    return c.json({ error: 'Invalid or missing TikTok URL.' }, 400);
  }

  try {
    // Get video info first to get direct URL
    const info = await getVideoInfo(url);

    // For download, redirect to the best available video URL
    let downloadUrl = info.hdplay || info.play || info.wmplay;

    if (hq && info.hdplay) {
      downloadUrl = info.hdplay;
    }

    if (!downloadUrl) {
      throw new Error('No download URL available');
    }

    return c.redirect(downloadUrl);

  } catch (error) {
    console.error('Download error:', error);
    return c.json({ error: 'Failed to get download URL', details: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});


// New endpoint to get the caption using yt-dlp.
app.post('/caption', async (c) => {
  const { url } = await c.req.json();
  const audioOnly = c.req.query('audio_only') === 'true'; // New parameter for audio-only processing
  const debug = c.req.query('debug') === 'true'; // New parameter for debug timing info

  if (!url || !TIKTOK_URL_PATTERN.test(url)) {
    return c.json({ error: 'Invalid or missing TikTok URL.' }, 400);
  }

  // Initialize timing tracking
  const timing = {
    start: Date.now(),
    metadataStart: 0,
    metadataEnd: 0,
    downloadStart: 0,
    downloadEnd: 0,
    transcribeStart: 0,
    transcribeEnd: 0,
    total: 0
  };

  try {
    // 1. First, get video metadata using yt-dlp
    timing.metadataStart = Date.now();
    const metadata = await getVideoInfo(url);
    timing.metadataEnd = Date.now();

    console.log(`Got metadata for ${url}: ${metadata.title} by ${metadata.author.nickname}`);

    // 2. Download media using yt-dlp (audio or video)
    timing.downloadStart = Date.now();
    const { buffer, filename, contentType, cached } = await downloadMedia(url, audioOnly);
    timing.downloadEnd = Date.now();

    console.log(`${cached ? 'Retrieved from cache' : 'Downloaded'} ${audioOnly ? 'audio' : 'video'} for ${url}, size: ${buffer.length} bytes`);

    // 3. Prepare the data for Whisper service
    const file = new File([buffer], filename, { type: contentType });
    const formData = new FormData();
    formData.append('file', file);

    // 4. Call the Whisper worker service
    timing.transcribeStart = Date.now();
    const whisperResponse = await fetch(WHISPER_API_URL, {
      method: 'POST',
      body: formData,
      // Add timeout for transcription service - transcription can take longer
      signal: AbortSignal.timeout(120000), // 2 minutes for transcription
    });

    if (!whisperResponse.ok) {
      const errorBody = await whisperResponse.text();
      console.error("Whisper API Error:", errorBody);
      return c.json({ error: 'Transcription service failed.', details: errorBody }, 500);
    }

    const result = (await whisperResponse.json()) as { caption: string };
    timing.transcribeEnd = Date.now();

    // Calculate timing metrics
    timing.total = timing.transcribeEnd - timing.start;
    const metadataTime = timing.metadataEnd - timing.metadataStart;
    const downloadTime = timing.downloadEnd - timing.downloadStart;
    const transcribeTime = timing.transcribeEnd - timing.transcribeStart;

    // 5. Return the result to the user with enhanced metadata and timing
    const response: any = {
      url: url,
      caption: result.caption,
      metadata: {
        title: metadata.title,
        author: metadata.author.nickname,
        authorId: metadata.author.unique_id,
        duration: metadata.duration,
        processingType: audioOnly ? 'audio-only' : 'video',
        fileSize: buffer.length,
        thumbnail: metadata.cover,
        originCover: metadata.origin_cover,
        cached: cached,
      },
      downloadUrl: `/download`,
    };

    // Add debug timing information if requested
    if (debug) {
      response.debug = {
        timing: {
          total: `${timing.total}ms`,
          metadata: `${metadataTime}ms`,
          download: `${downloadTime}ms`,
          transcription: `${transcribeTime}ms`,
        },
        performance: {
          downloadSpeed: `${(buffer.length / (downloadTime / 1000) / 1024 / 1024).toFixed(2)} MB/s`,
          transcriptionSpeed: `${(metadata.duration / (transcribeTime / 1000)).toFixed(2)}x realtime`,
          efficiency: audioOnly ? 'audio-only (optimized)' : 'full-video',
        },
        breakdown: {
          metadataFetch: `${((metadataTime / timing.total) * 100).toFixed(1)}%`,
          mediaDownload: `${((downloadTime / timing.total) * 100).toFixed(1)}%`,
          transcription: `${((transcribeTime / timing.total) * 100).toFixed(1)}%`,
        }
      };
    }

    return c.json(response);

  } catch (error) {
    console.error(error);

    // Calculate partial timing for debug even on error
    const errorTime = Date.now();
    const partialTiming = {
      total: errorTime - timing.start,
      metadata: timing.metadataEnd > 0 ? timing.metadataEnd - timing.metadataStart : 0,
      download: timing.downloadEnd > 0 ? timing.downloadEnd - timing.downloadStart : 0,
      transcription: timing.transcribeStart > 0 ? errorTime - timing.transcribeStart : 0,
    };

    // Handle timeout errors specifically
    if (error instanceof Error) {
      if (error.name === 'TimeoutError') {
        const errorResponse: any = {
          error: 'Request timed out. The video might be too long or the transcription service is slow.',
          details: 'Please try again or use a shorter video.'
        };

        if (debug) {
          errorResponse.debug = {
            timing: partialTiming,
            failedAt: timing.transcribeStart > 0 ? 'transcription' :
              timing.downloadStart > 0 ? 'download' : 'metadata'
          };
        }

        return c.json(errorResponse, 408);
      }
      if (error.name === 'AbortError') {
        const errorResponse: any = {
          error: 'Request was aborted due to timeout.',
          details: 'The operation took longer than expected.'
        };

        if (debug) {
          errorResponse.debug = {
            timing: partialTiming,
            failedAt: timing.transcribeStart > 0 ? 'transcription' :
              timing.downloadStart > 0 ? 'download' : 'metadata'
          };
        }

        return c.json(errorResponse, 408);
      }
    }

    return c.json({ error: 'An internal server error occurred.' }, 500);
  }
});


app.get('/', (c) => {
  return c.text(`
TikTok Video Transcription Service (Powered by tikwm.com API)

Endpoints:
- POST /caption - Get transcription of a TikTok video
  - Body: { "url": "https://www.tiktok.com/@mofuandmario/video/7550395062786477342" }
  - Optional: ?audio_only=true - Download only audio for faster processing (recommended)
  - Optional: ?debug=true - Include detailed timing and performance metrics
  - Returns: transcription + video metadata (title, author, duration, thumbnail, etc.)
  
- POST /download - Download TikTok video
  - Body: { "url": "https://www.tiktok.com/@mofuandmario/video/7550395062786477342" }
  - Optional: ?hq=true - Download high-quality version if available
  - Uses tikwm.com API for reliable video extraction

Examples using curl:

# Get transcription (audio-only, recommended for speed)
curl -X POST "http://localhost:3000/caption?audio_only=true&debug=true" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.tiktok.com/@mofuandmario/video/7550395062786477342"}'

# Get transcription (audio-only, no debug info)
curl -X POST "http://localhost:3000/caption?audio_only=true" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.tiktok.com/@mofuandmario/video/7550395062786477342"}'

# Get transcription (full video processing with debug)
curl -X POST "http://localhost:3000/caption?debug=true" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.tiktok.com/@mofuandmario/video/7550395062786477342"}'

# Download video (high quality)
curl -X POST "http://localhost:3000/download?hq=true" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.tiktok.com/@mofuandmario/video/7550395062786477342"}' \
  -L -o "tiktok_video.mp4"

Supported URL formats:
✓ https://www.tiktok.com/@mofuandmario/video/7550395062786477342
✓ https://tiktok.com/@username/video/1234567890123456789
✓ https://vm.tiktok.com/ZMhvw8kQG/

Benefits of tikwm.com over yt-dlp:
✓ No external dependencies required
✓ Fast API-based extraction
✓ Direct access to multiple quality options
✓ Reliable video and audio extraction
✓ No need for server-side tools installation

Benefits of audio_only=true:
✓ Faster download (smaller file size)
✓ More efficient transcription
✓ Reduced bandwidth usage
✓ Same transcription quality

Debug information includes:
✓ Timing breakdown (metadata, download, transcription)
✓ Performance metrics (download speed, transcription speed)
✓ Process efficiency analysis
✓ Percentage breakdown of time spent in each phase

Requirements:
- Internet connection for tikwm.com API access
- No additional server dependencies needed
  `);
});

export default {
  port: 3000,
  fetch: app.fetch,
  idleTimeout: 60, // 60 seconds timeout for long-running requests like video transcription
};