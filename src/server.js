import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { initDb } from './db.js';
import apiRouter from './routes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Setup essential local directories
const tempDir = process.env.TEMP_DIR || './temp';
const clipsDir = path.join(tempDir, 'clips');
const secretsDir = './secrets';

[tempDir, clipsDir, secretsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Dataset Collector Backend is healthy' });
});

// API Routes
app.use('/api', apiRouter);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Boot Database & Web server
const boot = async () => {
  try {
    await initDb();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`===================================================`);
      console.log(`  Dataset Collector Backend running on port ${PORT}`);
      console.log(`  Local endpoint: http://localhost:${PORT}`);
      console.log(`===================================================`);
    });
  } catch (error) {
    console.error('Failed to boot backend server:', error);
    process.exit(1);
  }
};

boot();
