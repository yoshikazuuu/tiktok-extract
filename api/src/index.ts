import { Hono } from 'hono';
import { spawn } from 'child_process';
import { promisify } from 'util';
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

// yt-dlp response types
interface YtDlpInfo {
  id: string;
  title: string;
  uploader: string;
  duration: number;
  url: string;
  ext: string;
  filesize?: number;
  thumbnail: string;
  description?: string;
}

// Helper function to execute yt-dlp and get video info
async function getVideoInfo(videoUrl: string): Promise<YtDlpInfo> {
  return new Promise((resolve, reject) => {
    const ytDlp = spawn('yt-dlp', [
      '--dump-json',
      '--no-download',
      videoUrl
    ]);

    let output = '';
    let errorOutput = '';

    ytDlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytDlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ytDlp.on('close', (code) => {
      if (code === 0) {
        try {
          const info = JSON.parse(output.trim()) as YtDlpInfo;
          resolve(info);
        } catch (error) {
          reject(new Error('Failed to parse yt-dlp output'));
        }
      } else {
        reject(new Error(`yt-dlp failed: ${errorOutput}`));
      }
    });

    ytDlp.on('error', (error) => {
      reject(new Error(`Failed to spawn yt-dlp: ${error.message}`));
    });
  });
}

// Helper function to download media with yt-dlp
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

  const tempDir = '/tmp';
  const timestamp = Date.now();
  const outputTemplate = join(tempDir, `tiktok_${timestamp}.%(ext)s`);

  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '-o', outputTemplate,
    ];

    if (audioOnly) {
      args.push(
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '128K'
      );
    } else {
      args.push(
        '--format', 'best[ext=mp4]/best',
        '--merge-output-format', 'mp4'
      );
    }

    args.push(videoUrl);

    const ytDlp = spawn('yt-dlp', args);

    let errorOutput = '';

    ytDlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ytDlp.on('close', async (code) => {
      if (code === 0) {
        try {
          // Find the downloaded file
          const extension = audioOnly ? 'mp3' : 'mp4';
          const expectedFile = join(tempDir, `tiktok_${timestamp}.${extension}`);

          // Read the file
          const fs = await import('fs/promises');
          const buffer = await fs.readFile(expectedFile);

          // Save to cache
          try {
            await writeFile(cachedFile, buffer);
            console.log('Saved to cache:', cachedFile);
          } catch (error) {
            console.warn('Failed to save to cache:', error);
          }

          // Clean up temp file only (keep cache)
          await fs.unlink(expectedFile).catch(() => { }); // Ignore cleanup errors

          resolve({
            buffer,
            filename: `tiktok_${cacheKey}.${extension}`,
            contentType: audioOnly ? 'audio/mp3' : 'video/mp4',
            cached: false
          });
        } catch (error) {
          reject(new Error(`Failed to read downloaded file: ${error}`));
        }
      } else {
        reject(new Error(`yt-dlp download failed: ${errorOutput}`));
      }
    });

    ytDlp.on('error', (error) => {
      reject(new Error(`Failed to spawn yt-dlp: ${error.message}`));
    });
  });
}

// The download endpoint using yt-dlp
app.post('/download', async (c) => {
  const { url } = await c.req.json();
  const hq = c.req.query('hq') === 'true';

  if (!url || !TIKTOK_URL_PATTERN.test(url)) {
    return c.json({ error: 'Invalid or missing TikTok URL.' }, 400);
  }

  try {
    // Get video info first to get direct URL
    const info = await getVideoInfo(url);

    // For download, redirect to the direct URL
    // yt-dlp provides the best available URL
    return c.redirect(info.url);

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

    console.log(`Got metadata for ${url}: ${metadata.title} by ${metadata.uploader}`);

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
        author: metadata.uploader,
        duration: metadata.duration,
        processingType: audioOnly ? 'audio-only' : 'video',
        fileSize: buffer.length,
        thumbnail: metadata.thumbnail,
        description: metadata.description,
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
TikTok Video Transcription Service (Powered by yt-dlp)

Endpoints:
- POST /caption - Get transcription of a TikTok video
  - Body: { "url": "https://www.tiktok.com/@username/video/1234567890123456789" }
  - Optional: ?audio_only=true - Download only audio for faster processing (recommended)
  - Optional: ?debug=true - Include detailed timing and performance metrics
  - Returns: transcription + video metadata (title, author, duration, thumbnail, etc.)
  
- POST /download - Download TikTok video
  - Body: { "url": "https://www.tiktok.com/@username/video/1234567890123456789" }
  - Uses yt-dlp for reliable video extraction

Examples using curl:

# Get transcription (audio-only, recommended for speed)
curl -X POST "http://localhost:3000/caption?audio_only=true&debug=true" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.tiktok.com/@username/video/1234567890123456789"}'

# Get transcription (audio-only, no debug info)
curl -X POST "http://localhost:3000/caption?audio_only=true" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.tiktok.com/@username/video/1234567890123456789"}'

# Get transcription (full video processing with debug)
curl -X POST "http://localhost:3000/caption?debug=true" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.tiktok.com/@username/video/1234567890123456789"}'

# Download video
curl -X POST "http://localhost:3000/download" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.tiktok.com/@username/video/1234567890123456789"}' \
  -L -o "tiktok_video.mp4"

Supported URL formats:
✓ https://www.tiktok.com/@username/video/1234567890123456789
✓ https://tiktok.com/@username/video/1234567890123456789
✓ https://vm.tiktok.com/ZMhvw8kQG/

Benefits of yt-dlp over TikWM:
✓ More reliable video extraction
✓ Better metadata (title, author, thumbnail, description)
✓ Direct audio extraction (no re-encoding)
✓ Handles various TikTok URL formats
✓ Active maintenance and updates

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
- yt-dlp must be installed on the server
- Install with: pip install yt-dlp
  `);
});

export default {
  port: 3000,
  fetch: app.fetch,
  idleTimeout: 60, // 60 seconds timeout for long-running requests like video transcription
};