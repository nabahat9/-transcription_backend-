import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import {
  dbRun,
  dbGet,
  dbAll,
  dbTransaction
} from './db.js';
import {
  downloadVideo,
  extractAudio,
  getAudioDuration,
  detectSilence,
  computeSegmentation,
  cutSegments
} from './services/audio.js';
import {
  uploadAudioToDrive,
  getLastIdFromSheet,
  appendRowToSheet
} from './services/google.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_dataset_collector_key_2026';

// Format helper for timestamps (e.g. 10.5 -> 00:00:10)
const formatTimestamp = (seconds) => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return [hrs, mins, secs].map(v => String(v).padStart(2, '0')).join(':');
};

// ==========================================
// Authentication Middleware
// ==========================================
export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Authentication token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token is invalid or expired' });
    }
    req.user = user;
    next();
  });
};

export const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ==========================================
// Auth Routes
// ==========================================

// Login
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register (Can be run by Admin to add workers)
router.post('/auth/register', authenticateToken, requireAdmin, async (req, res) => {
  const { email, password, name, role } = req.body;

  if (!email || !password || !name || !role) {
    return res.status(400).json({ error: 'All fields (email, password, name, role) are required' });
  }

  if (role !== 'worker' && role !== 'admin') {
    return res.status(400).json({ error: 'Role must be worker or admin' });
  }

  try {
    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await dbRun(
      'INSERT INTO users (email, password_hash, role, name) VALUES (?, ?, ?, ?)',
      [email, passwordHash, role, name]
    );

    res.status(201).json({ message: 'User registered successfully', userId: result.id });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get profile
router.get('/auth/me', authenticateToken, async (req, res) => {
  res.json({ user: req.user });
});

// ==========================================
// Video Import & Segmentation Routes
// ==========================================

// Import a video URL and process it in the background
router.post('/import', authenticateToken, async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Video URL is required' });
  }

  // Basic URL Validation
  let platform = '';
  if (url.includes('youtube.com') || url.includes('youtu.be')) platform = 'youtube';
  else if (url.includes('tiktok.com')) platform = 'tiktok';
  else if (url.includes('instagram.com')) platform = 'instagram';
  else platform = 'local'; // Generic URL or fallback

  try {
    // Create background job record
    const jobResult = await dbRun(
      'INSERT INTO jobs (source_url, platform, status) VALUES (?, ?, ?)',
      [url, platform, 'processing']
    );
    const jobId = jobResult.id;

    res.json({ message: 'Processing started', jobId });

    // Background Execution
    (async () => {
      const tempDir = process.env.TEMP_DIR || './temp';
      const jobTempDir = path.join(tempDir, `job_${jobId}`);

      try {
        // Step 1: Download video audio
        const downloadedFile = await downloadVideo(url, jobTempDir);
        
        // Step 2: Extract audio in WAV 16kHz Mono format
        const extractedWav = path.join(jobTempDir, 'extracted.wav');
        await extractAudio(downloadedFile, extractedWav);
        
        // Step 3: Get audio duration
        const duration = await getAudioDuration(extractedWav);

        // Step 4: Detect silences
        const silences = await detectSilence(extractedWav);

        // Step 5: Compute speech segments
        const segments = computeSegmentation(silences, duration);

        // Step 6: Cut audio into clip WAV files
        const clipDir = path.join(tempDir, 'clips');
        const cutClips = await cutSegments(extractedWav, segments, clipDir);

        // Step 7: Save clips to database
        for (const clip of cutClips) {
          await dbRun(
            `INSERT INTO clips (job_id, local_path, duration, start_time, end_time, status)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [jobId, clip.localPath, clip.duration, clip.start_time, clip.end_time, 'pending']
          );
        }

        // Update Job state
        await dbRun('UPDATE jobs SET status = ? WHERE id = ?', ['completed', jobId]);
        console.log(`Job ${jobId} completed successfully. Generated ${cutClips.length} segments.`);
      } catch (err) {
        console.error(`Job ${jobId} failed:`, err);
        await dbRun(
          'UPDATE jobs SET status = ?, error_message = ? WHERE id = ?',
          ['failed', err.message, jobId]
        );
      } finally {
        // Clean up raw downloaded files in jobTempDir (but keep generated clips in clips/)
        try {
          const files = fs.readdirSync(jobTempDir);
          for (const file of files) {
            const filePath = path.join(jobTempDir, file);
            if (file !== 'extracted.wav' && fs.statSync(filePath).isFile()) {
              fs.unlinkSync(filePath);
            }
          }
        } catch (cleanupErr) {
          console.error('Cleanup error:', cleanupErr);
        }
      }
    })();

  } catch (error) {
    console.error('Import startup error:', error);
    res.status(500).json({ error: 'Failed to initiate video import.' });
  }
});

// Get job status
router.get('/jobs/:id', authenticateToken, async (req, res) => {
  try {
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Fetch generated clips if job completed
    let clips = [];
    if (job.status === 'completed') {
      clips = await dbAll('SELECT id, duration, start_time, end_time, status FROM clips WHERE job_id = ?', [job.id]);
    }

    res.json({ job, clips });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ==========================================
// Clip & Transcription Routes
// ==========================================

// Get audio stream for a specific clip
router.get('/clips/:id/audio', authenticateToken, async (req, res) => {
  try {
    const clip = await dbGet('SELECT local_path FROM clips WHERE id = ?', [req.params.id]);
    if (!clip || !fs.existsSync(clip.local_path)) {
      return res.status(404).json({ error: 'Audio file not found' });
    }
    res.set('Content-Type', 'audio/wav');
    fs.createReadStream(clip.local_path).pipe(res);
  } catch (error) {
    res.status(500).json({ error: 'Error streaming audio' });
  }
});

// Get pending and draft clips for workers
router.get('/clips/pending', authenticateToken, async (req, res) => {
  try {
    const clips = await dbAll(
      `SELECT c.id, c.duration, c.start_time, c.end_time, c.transcription, c.quality_flags, c.quality_reason, c.status, j.source_url
       FROM clips c
       JOIN jobs j ON c.job_id = j.id
       WHERE c.status IN ('pending', 'draft') AND (c.annotator_id IS NULL OR c.annotator_id = ?)`,
      [req.user.id]
    );
    res.json(clips);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Save transcription draft
router.post('/clips/:id/draft', authenticateToken, async (req, res) => {
  const { transcription, qualityFlags, qualityReason } = req.body;

  try {
    await dbRun(
      `UPDATE clips 
       SET transcription = ?, quality_flags = ?, quality_reason = ?, status = 'draft', annotator_id = ?
       WHERE id = ?`,
      [transcription, JSON.stringify(qualityFlags || []), qualityReason || '', req.user.id, req.params.id]
    );
    res.json({ message: 'Draft saved successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save draft' });
  }
});

// Submit a completed transcription (Sync to Google Drive & Google Sheet)
router.post('/clips/:id/submit', authenticateToken, async (req, res) => {
  const { transcription, qualityFlags, qualityReason } = req.body;

  try {
    // 1. Fetch clip details
    const clip = await dbGet(
      `SELECT c.*, j.source_url 
       FROM clips c 
       JOIN jobs j ON c.job_id = j.id 
       WHERE c.id = ?`,
      [req.params.id]
    );

    if (!clip) {
      return res.status(404).json({ error: 'Clip not found' });
    }

    if (!fs.existsSync(clip.local_path)) {
      return res.status(404).json({ error: 'Local audio clip file is missing.' });
    }

    // 2. Perform global ID counter claim using SQLite transaction to ensure synchronization
    const globalId = await dbTransaction(async () => {
      // Fetch sheet ID to sync
      const sheetLastId = await getLastIdFromSheet();
      
      // Fetch DB setting last ID
      const settingRow = await dbGet("SELECT value FROM settings WHERE key = 'last_assigned_id'");
      const dbLastId = parseInt(settingRow.value, 10);
      
      // Concurrency protection: Take the absolute max between the Google Sheet and DB
      const nextId = Math.max(sheetLastId, dbLastId) + 1;
      
      // Write next ID back to settings
      await dbRun("UPDATE settings SET value = ? WHERE key = 'last_assigned_id'", [String(nextId)]);
      return nextId;
    });

    const paddedId = String(globalId).padStart(6, '0');
    const targetFilename = `frequence_${paddedId}.wav`;

    console.log(`Assigned global ID ${paddedId} to clip ${req.params.id}`);

    // 3. Upload audio to Google Drive
    const driveResult = await uploadAudioToDrive(clip.local_path, targetFilename);

    // 4. Log row in Google Sheet
    const uploadDate = new Date().toISOString().split('T')[0];
    const flagsString = (qualityFlags || []).join(', ');
    
    // Google Sheets row format:
    // [ID, File Name, Source URL, Start Time, End Time, Duration, Transcription, Annotator, Upload Date, Quality Flags, Quality Reason]
    await appendRowToSheet([
      paddedId,
      targetFilename,
      clip.source_url,
      formatTimestamp(clip.start_time),
      formatTimestamp(clip.end_time),
      Math.round(clip.duration),
      transcription || '',
      req.user.name,
      uploadDate,
      flagsString,
      qualityReason || ''
    ]);

    // 5. Update SQLite record
    await dbRun(
      `UPDATE clips 
       SET transcription = ?, 
           quality_flags = ?, 
           quality_reason = ?, 
           status = 'submitted', 
           annotator_id = ?, 
           global_id = ?, 
           uploaded_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        transcription,
        JSON.stringify(qualityFlags || []),
        qualityReason || '',
        req.user.id,
        globalId,
        req.params.id
      ]
    );

    // 6. Delete local temp file to save disk space
    try {
      fs.unlinkSync(clip.local_path);
      console.log(`Deleted temporary local file: ${clip.local_path}`);
    } catch (err) {
      console.error(`Failed to delete temporary file ${clip.local_path}:`, err);
    }

    res.json({
      message: 'Clip uploaded and logged successfully',
      globalId: paddedId,
      filename: targetFilename,
      driveLink: driveResult.webViewLink
    });

  } catch (error) {
    console.error(`Submission error for clip ${req.params.id}:`, error);
    res.status(500).json({ error: `Sync failed: ${error.message}` });
  }
});

// ==========================================
// Worker Dashboard
// ==========================================
router.get('/dashboard/worker', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // Clips completed today (submitted status)
    const today = new Date().toISOString().split('T')[0];
    const todayCount = await dbGet(
      `SELECT COUNT(id) as count 
       FROM clips 
       WHERE annotator_id = ? AND status = 'submitted' AND date(uploaded_at) = date(?)`,
      [userId, today]
    );

    // Clips completed this week
    const weekCount = await dbGet(
      `SELECT COUNT(id) as count 
       FROM clips 
       WHERE annotator_id = ? AND status = 'submitted' AND date(uploaded_at) >= date('now', '-7 days')`,
      [userId]
    );

    // Total clips completed
    const totalCount = await dbGet(
      `SELECT COUNT(id) as count, SUM(duration) as duration
       FROM clips 
       WHERE annotator_id = ? AND status = 'submitted'`,
      [userId]
    );

    const totalSeconds = totalCount.duration || 0;
    const totalHours = (totalSeconds / 3600).toFixed(2);

    res.json({
      todayCount: todayCount.count || 0,
      weekCount: weekCount.count || 0,
      totalCount: totalCount.count || 0,
      totalHours: parseFloat(totalHours)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to aggregate dashboard metrics' });
  }
});

// ==========================================
// Admin Dashboard & Supervisor Routes
// ==========================================
router.get('/dashboard/admin', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const totalWorkers = await dbGet("SELECT COUNT(id) as count FROM users WHERE role = 'worker'");
    const totalClips = await dbGet("SELECT COUNT(id) as count, SUM(duration) as duration FROM clips WHERE status = 'submitted'");
    
    // Dataset growth: total clips by date
    const growthStats = await dbAll(
      `SELECT date(uploaded_at) as date, COUNT(id) as count, SUM(duration) as duration 
       FROM clips 
       WHERE status = 'submitted' 
       GROUP BY date(uploaded_at) 
       ORDER BY date ASC`
    );

    // Work per user
    const workerStats = await dbAll(
      `SELECT u.name, u.email, COUNT(c.id) as clips_count, SUM(c.duration) as total_duration
       FROM users u
       LEFT JOIN clips c ON u.id = c.annotator_id AND c.status = 'submitted'
       WHERE u.role = 'worker'
       GROUP BY u.id`
    );

    // Upload History (last 50 uploads)
    const history = await dbAll(
      `SELECT c.global_id, c.duration, c.transcription, c.quality_flags, u.name as annotator, c.uploaded_at
       FROM clips c
       LEFT JOIN users u ON c.annotator_id = u.id
       WHERE c.status = 'submitted'
       ORDER BY c.uploaded_at DESC
       LIMIT 50`
    );

    res.json({
      totalWorkers: totalWorkers.count || 0,
      totalClips: totalClips.count || 0,
      totalAudioDuration: Math.round(totalClips.duration || 0),
      growthStats,
      workerStats,
      history
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch admin statistics' });
  }
});

// CSV Export route
router.get('/dashboard/admin/export', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const clips = await dbAll(
      `SELECT c.global_id, c.duration, c.start_time, c.end_time, c.transcription, c.quality_flags, c.quality_reason, u.name as annotator, c.uploaded_at
       FROM clips c
       LEFT JOIN users u ON c.annotator_id = u.id
       WHERE c.status = 'submitted'
       ORDER BY c.global_id ASC`
    );

    let csvContent = "ID,Filename,Duration(s),StartTime,EndTime,Transcription,Annotator,UploadDate,QualityFlags,QualityReason\n";
    for (const c of clips) {
      const paddedId = String(c.global_id).padStart(6, '0');
      const filename = `frequence_${paddedId}.wav`;
      const escapedTrans = (c.transcription || '').replace(/"/g, '""');
      const escapedReason = (c.quality_reason || '').replace(/"/g, '""');
      
      csvContent += `${paddedId},${filename},${Math.round(c.duration)},${formatTimestamp(c.start_time)},${formatTimestamp(c.end_time)},"${escapedTrans}",${c.annotator},${c.uploaded_at.split(' ')[0]},"${c.quality_flags || ''}","${escapedReason}"\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=transcriptions_export.csv');
    res.status(200).send(csvContent);
  } catch (error) {
    res.status(500).json({ error: 'CSV export failed' });
  }
});

export default router;
