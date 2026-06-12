import { exec, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';

const execPromise = promisify(exec);

/**
 * Downloads a video's audio from a given social media URL using yt-dlp.
 * @param {string} url - The URL of the video (YouTube, TikTok, Instagram).
 * @param {string} outputDir - Directory to store the downloaded file.
 * @returns {Promise<string>} - Absolute path to the downloaded file.
 */
export const downloadVideo = async (url, outputDir) => {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const tempFilename = `download_${Date.now()}`;
  const outputPath = path.join(outputDir, `${tempFilename}.%(ext)s`);

  console.log(`Downloading video from URL: ${url}`);
  
  // Use yt-dlp to download the best audio format
  // --no-playlist prevents downloading full playlists if a playlist URL is supplied
  const command = `yt-dlp -f bestaudio -o "${outputPath}" --no-playlist "${url}"`;
  
  try {
    await execPromise(command);
  } catch (error) {
    console.error('yt-dlp download failed:', error);
    throw new Error(`Failed to download video from URL. Make sure yt-dlp is installed and the URL is correct.`);
  }

  // Find the downloaded file (since extension is resolved by yt-dlp)
  const files = fs.readdirSync(outputDir);
  const downloadedFile = files.find(file => file.startsWith(tempFilename));
  
  if (!downloadedFile) {
    throw new Error('Downloaded file not found in output directory.');
  }

  return path.join(outputDir, downloadedFile);
};

/**
 * Converts any audio/video file to WAV, Mono, 16kHz audio using FFmpeg.
 * @param {string} inputPath - Path to the source file.
 * @param {string} outputPath - Path to the output WAV file.
 * @returns {Promise<void>}
 */
export const extractAudio = async (inputPath, outputPath) => {
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`Extracting 16kHz Mono WAV from: ${inputPath}`);
  
  // FFmpeg command: -y (overwrite), -ac 1 (mono), -ar 16000 (16kHz), -f wav
  const command = `ffmpeg -y -i "${inputPath}" -ac 1 -ar 16000 -f wav "${outputPath}"`;
  
  try {
    await execPromise(command);
  } catch (error) {
    console.error('FFmpeg extraction failed:', error);
    throw new Error('Failed to convert audio using FFmpeg. Make sure FFmpeg is installed.');
  }
};

/**
 * Retrieves the total duration of an audio file in seconds.
 * @param {string} audioPath - Path to the audio file.
 * @returns {Promise<number>} - Duration in seconds.
 */
export const getAudioDuration = async (audioPath) => {
  const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
  try {
    const { stdout } = await execPromise(command);
    return parseFloat(stdout.trim());
  } catch (error) {
    console.error('ffprobe failed to get duration, attempting fallback parse via ffmpeg:', error);
    // Fallback: Parse from ffmpeg -i info if ffprobe isn't fully set up
    const fallbackCommand = `ffmpeg -i "${audioPath}"`;
    try {
      await execPromise(fallbackCommand);
    } catch (ffmpegErr) {
      const durationMatch = ffmpegErr.message.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/);
      if (durationMatch) {
        const hours = parseInt(durationMatch[1]);
        const minutes = parseInt(durationMatch[2]);
        const seconds = parseFloat(durationMatch[3]);
        return hours * 3600 + minutes * 60 + seconds;
      }
    }
    throw new Error('Failed to retrieve audio duration.');
  }
};

/**
 * Runs FFmpeg silence detection on a WAV file.
 * @param {string} audioPath - Path to the WAV file.
 * @returns {Promise<Array<{start: number, end: number, duration: number}>>} - Detected silence intervals.
 */
export const detectSilence = async (audioPath) => {
  console.log(`Running silence detection on: ${audioPath}`);
  // Detect silence below -30dB for at least 0.5 seconds
  const command = `ffmpeg -i "${audioPath}" -af silencedetect=noise=-30dB:d=0.5 -f null -`;
  
  try {
    // FFmpeg outputs silencedetect details to stderr
    await execPromise(command);
    return []; // No silence detected (or it finished with no stderr output, which is unlikely)
  } catch (error) {
    // If it's a normal run, FFmpeg exits with code 0 but since we direct to null it may throw/exit
    // We parse the stderr output from the error object
    const stderrText = error.stderr || error.message || '';
    
    const silences = [];
    const startRegex = /silence_start:\s+(\d+\.?\d*)/g;
    const endRegex = /silence_end:\s+(\d+\.?\d*)\s+\|\s+silence_duration:\s+(\d+\.?\d*)/g;
    
    let startMatch;
    const starts = [];
    while ((startMatch = startRegex.exec(stderrText)) !== null) {
      starts.push(parseFloat(startMatch[1]));
    }
    
    let endMatch;
    const ends = [];
    while ((endMatch = endRegex.exec(stderrText)) !== null) {
      ends.push({
        end: parseFloat(endMatch[1]),
        duration: parseFloat(endMatch[2])
      });
    }
    
    for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
      silences.push({
        start: starts[i],
        end: ends[i].end,
        duration: ends[i].duration
      });
    }
    
    console.log(`Detected ${silences.length} silence intervals`);
    return silences;
  }
};

/**
 * Creates segments from speech intervals by merging/splitting.
 * Target duration: 20 to 30 seconds.
 * @param {Array<{start: number, end: number, duration: number}>} silences - Silences.
 * @param {number} totalDuration - Total duration of the track.
 * @returns {Array<{start: number, end: number}>} - Split segments config.
 */
export const computeSegmentation = (silences, totalDuration) => {
  // 1. Get speech intervals (invert silences)
  const speechIntervals = [];
  let lastEnd = 0;

  for (const s of silences) {
    if (s.start > lastEnd + 0.1) {
      speechIntervals.push({
        start: lastEnd,
        end: s.start,
        duration: s.start - lastEnd
      });
    }
    lastEnd = s.end;
  }

  if (totalDuration > lastEnd + 0.1) {
    speechIntervals.push({
      start: lastEnd,
      end: totalDuration,
      duration: totalDuration - lastEnd
    });
  }

  // If there are no speech intervals (no silence detected at all), use the entire audio
  if (speechIntervals.length === 0) {
    speechIntervals.push({
      start: 0,
      end: totalDuration,
      duration: totalDuration
    });
  }

  const finalSegments = [];
  let currentSegment = null;

  for (const interval of speechIntervals) {
    // If the interval itself is longer than 30 seconds, we need to split it
    if (interval.duration > 30) {
      // Clear out the running segment first if it exists
      if (currentSegment) {
        finalSegments.push(currentSegment);
        currentSegment = null;
      }

      // Split the long interval into equal parts between 20 and 30 seconds
      // e.g. 45s -> two 22.5s parts
      // If it's too short to split into >= 20s parts (e.g. 35s), we split it into one 20s and one 15s,
      // or we can make it 17.5s each (slight compromise) or keep as 35s. Let's aim for 20-30s.
      const numParts = Math.max(1, Math.round(interval.duration / 25));
      const partLength = interval.duration / numParts;

      for (let i = 0; i < numParts; i++) {
        const start = interval.start + i * partLength;
        const end = Math.min(interval.end, start + partLength);
        finalSegments.push({ start, end, duration: end - start });
      }
      continue;
    }

    // Normal interval (<= 30s)
    if (!currentSegment) {
      currentSegment = { ...interval };
    } else {
      const combinedDuration = interval.end - currentSegment.start;
      if (combinedDuration <= 30) {
        // Merge it!
        currentSegment.end = interval.end;
        currentSegment.duration = combinedDuration;
      } else {
        // Cannot merge because it exceeds 30s. Save currentSegment and start new one.
        finalSegments.push(currentSegment);
        currentSegment = { ...interval };
      }
    }

    // If the current merged segment is within the target 20-30s range, we can close it
    if (currentSegment && currentSegment.duration >= 20 && currentSegment.duration <= 30) {
      finalSegments.push(currentSegment);
      currentSegment = null;
    }
  }

  // Handle leftovers
  if (currentSegment) {
    // If the leftover is too short (< 20s), try to merge with the previous segment if possible
    if (currentSegment.duration < 20 && finalSegments.length > 0) {
      const prev = finalSegments[finalSegments.length - 1];
      const mergedDuration = currentSegment.end - prev.start;
      if (mergedDuration <= 30) {
        // Merge with previous
        prev.end = currentSegment.end;
        prev.duration = mergedDuration;
      } else {
        // If we can't merge because it exceeds 30s, check if we can adjust the split point.
        // For simplicity, if it's close to 20s (e.g. >= 15s), we keep it, otherwise we discard or keep.
        // The prompt says "Keep only clips whose duration is between 20 and 30 seconds."
        // So let's keep it if duration >= 20, otherwise we filter it out to strictly obey the range.
        if (currentSegment.duration >= 20) {
          finalSegments.push(currentSegment);
        }
      }
    } else if (currentSegment.duration >= 20) {
      finalSegments.push(currentSegment);
    }
  }

  // Strictly filter to match the 20-30 seconds requirement
  return finalSegments.filter(seg => seg.duration >= 20.0 && seg.duration <= 30.0);
};

/**
 * Cuts a main WAV audio file into segment WAV files using FFmpeg.
 * @param {string} inputWav - Path to the source WAV file.
 * @param {Array<{start: number, end: number}>} segments - Calculated segment boundaries.
 * @param {string} outputDir - Directory to store the cut WAV segments.
 * @returns {Promise<Array<{filename: string, start: number, end: number, duration: number, localPath: string}>>}
 */
export const cutSegments = async (inputWav, segments, outputDir) => {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const results = [];
  const baseName = `clip_${Date.now()}`;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const filename = `${baseName}_${String(i + 1).padStart(3, '0')}.wav`;
    const outputPath = path.join(outputDir, filename);

    console.log(`Cutting segment ${i + 1}/${segments.length}: ${seg.start}s to ${seg.end}s`);
    
    // FFmpeg split command:
    // -ss (start time), -to (end time), -c copy (fast stream copy if same codec, but since we cut WAV we can just copy)
    const command = `ffmpeg -y -ss ${seg.start} -i "${inputWav}" -to ${seg.end - seg.start} -c copy "${outputPath}"`;
    
    try {
      await execPromise(command);
      
      results.push({
        filename,
        start_time: seg.start,
        end_time: seg.end,
        duration: seg.end - seg.start,
        localPath: outputPath
      });
    } catch (error) {
      console.error(`Failed to cut segment ${filename}:`, error);
      // Continue cutting other segments even if one fails
    }
  }

  return results;
};
