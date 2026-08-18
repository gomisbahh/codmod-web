const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Storage } = require('@google-cloud/storage');
require('dotenv').config();

// Prepend local bin/ to PATH so that spawn('codmod') finds our mock script during local testing.
process.env.PATH = path.join(__dirname, 'bin') + path.delimiter + process.env.PATH;


const app = express();
const PORT = process.env.PORT || 8080;app.use(express.json());

// ==========================================
// APPLICATION-LEVEL AUTHENTICATION (HYBRID)
// ==========================================
const crypto = require('crypto');

const AUTH_ENABLED = process.env.APP_AUTH_ENABLED === 'true';
const APP_PASSWORD = process.env.APP_PASSWORD || 'admin123'; 
const COOKIE_NAME = 'codmod_session';
// Generate secure ephemeral secret per container instance, or use configured secret
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (AUTH_ENABLED && !process.env.APP_PASSWORD) {
  console.warn('WARNING: APP_AUTH_ENABLED is true but APP_PASSWORD is not set. Falling back to default: "admin123". PLEASE SET APP_PASSWORD IN ENVIRONMENT!');
}

// Zero-dependency secure cookie parser
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
  });
  return list;
}

// Cryptographically secure token signing using HMAC-SHA256
function signToken(data, secret) {
  const timestamp = Date.now().toString();
  const payload = Buffer.from(JSON.stringify({ data, timestamp })).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const signature = hmac.digest('base64url');
  return `${payload}.${signature}`;
}

// Verify token signature and check expiration (24-hour sessions)
function verifyToken(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    
    // Verify signature
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedSignature = hmac.digest('base64url');
    
    // Timing-safe comparison to prevent timing attacks
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return null;
    }
    
    // Decode and check expiration (24 hours = 86400000 ms)
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const age = Date.now() - parseInt(session.timestamp, 10);
    if (age > 86400000 || age < 0) {
      return null; // Expired
    }
    return session.data;
  } catch (err) {
    return null;
  }
}

// Auth Middleware (Placed BEFORE express.static to protect static dashboard assets)
app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();

  // Allow unauthenticated access to the login page and its static assets/APIs
  if (
    req.path === '/login.html' ||
    req.path === '/login.css' ||
    req.path === '/login.js' ||
    req.path === '/api/login' ||
    req.path === '/api/logout'
  ) {
    return next();
  }

  // Parse cookies and verify session
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies[COOKIE_NAME];
  const user = sessionToken ? verifyToken(sessionToken, SESSION_SECRET) : null;

  if (!user) {
    // If it's an API call, return 401 Unauthorized
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized. Please log in.' });
    }
    // Otherwise, redirect to the login page
    return res.redirect('/login.html');
  }

  req.user = user;
  next();
});

// Serve frontend static assets from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Auth API: Login
app.post('/api/login', (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password is required' });
  }

  // Timing-safe comparison to prevent timing attacks
  const inputBuffer = Buffer.from(password);
  const targetBuffer = Buffer.from(APP_PASSWORD);
  
  const isValid = inputBuffer.length === targetBuffer.length && 
                  crypto.timingSafeEqual(inputBuffer, targetBuffer);

  if (!isValid) {
    return res.status(401).json({ error: 'Incorrect passcode. Access denied.' });
  }

  // Create a secure signed token
  const token = signToken('admin', SESSION_SECRET);

  // Set as secure HttpOnly, SameSite=Lax cookie (Max-age: 24 hours)
  const secureFlag = process.env.NODE_ENV === 'production' ? 'Secure;' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; ${secureFlag} SameSite=Lax; Max-Age=86400`
  );

  res.json({ message: 'Login successful' });
});

// Auth API: Logout
app.post('/api/logout', (req, res) => {
  // Clear the cookie by setting Max-Age to 0
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
  res.json({ message: 'Logged out successfully' });
});


// In-memory Job Database (for simplicity in this single-container setup)
const jobs = {};
const jobQueue = [];
let activeJobId = null;

// SSE Clients mapping: jobId -> array of response objects
const sseClients = {};

// Initialize Google Cloud Storage
// In Cloud Run, it will automatically use the container's service account.
// Locally, it will use GOOGLE_APPLICATION_CREDENTIALS or fallback.
let storage;
try {
  storage = new Storage();
  console.log('Google Cloud Storage client initialized successfully.');
} catch (err) {
  console.warn('Warning: Could not initialize Google Cloud Storage. Using local mock storage fallback.', err.message);
}

// Ensure sandbox directory exists
const SANDBOX_DIR = '/tmp/codmod-jobs';
if (!fs.existsSync(SANDBOX_DIR)) {
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
}

// Ensure writable XDG_CONFIG_HOME directory exists for CLI tool configuration
const XDG_CONFIG_DIR = process.env.XDG_CONFIG_HOME || '/tmp/.config';
if (!fs.existsSync(XDG_CONFIG_DIR)) {
  try {
    fs.mkdirSync(XDG_CONFIG_DIR, { recursive: true, mode: 0o777 });
  } catch (err) {}
}

// Local Repositories root directory for folder picking in local mode
const LOCAL_REPOS_DIR = process.env.LOCAL_REPOS_DIR || 
  (fs.existsSync('/repos') ? '/repos' : path.resolve(__dirname, 'sample-repos'));

if (!fs.existsSync(LOCAL_REPOS_DIR)) {
  try {
    fs.mkdirSync(LOCAL_REPOS_DIR, { recursive: true });
  } catch (err) {
    console.warn('Could not create default LOCAL_REPOS_DIR:', err.message);
  }
}

// Ephemeral in-memory secret store for git credentials during cloning (NEVER saved to GCS or disk)
const jobSecrets = {};

// ==========================================
// SECURITY VALIDATIONS
// ==========================================

// Validate Git URL (Strict HTTPS only, no shell characters, no SSH)
function validateGitUrl(url) {
  if (!url || typeof url !== 'string') return false;
  // Allows standard https github/gitlab/bitbucket repositories
  const gitRegex = /^https:\/\/[a-zA-Z0-9_.-]+\.[a-zA-Z]{2,}\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\.git)?$/;
  return gitRegex.test(url);
}

// Validate GCS Bucket Name (GCP standard rules)
function validateBucketName(name) {
  if (!name || typeof name !== 'string') return false;
  const bucketRegex = /^[a-z0-9_.-]{3,63}$/;
  return bucketRegex.test(name);
}

// Validate Git Branch Name (no flag injection, alphanumeric, slashes, dots, underscores, hyphens)
function validateBranchName(branch) {
  if (!branch) return true;
  if (typeof branch !== 'string') return false;
  return /^[a-zA-Z0-9/_.-]+$/.test(branch) && !branch.startsWith('-');
}

// Validate options against strict allow-lists
const ALLOWED_MODELS = ['2.0-flash', '2.5-flash', '2.5-pro', 'adaptive'];
const ALLOWED_FORMATS = ['html', 'markdown', 'odt', 'json'];
const ALLOWED_INTENTS = [
  'MICROSOFT_MODERNIZATION',
  'CLOUD_TO_CLOUD',
  'JAVA_LEGACY_TO_MODERN',
  'WILDFLY_LEGACY_TO_MODERN',
  'ARM_MIGRATION'
];
const ALLOWED_REPORT_TYPES = ['default', 'full', 'data-layer', 'custom'];
const ALLOWED_OPTIONAL_SECTIONS = ['files', 'classes'];

function validateOptions(opts) {
  if (opts.modelset && !ALLOWED_MODELS.includes(opts.modelset)) return false;
  if (opts.format && !ALLOWED_FORMATS.includes(opts.format)) return false;
  if (opts.intent && !ALLOWED_INTENTS.includes(opts.intent)) return false;
  if (opts.reportType && !ALLOWED_REPORT_TYPES.includes(opts.reportType)) return false;
  if (opts.project && !/^[a-z0-9:-]{6,30}$/.test(opts.project)) return false; // Basic GCP project ID validation
  if (opts.region && !/^[a-z0-9-]+$/.test(opts.region)) return false;
  if (opts.optionalSections && Array.isArray(opts.optionalSections)) {
    const validSections = opts.optionalSections.every(sec => ALLOWED_OPTIONAL_SECTIONS.includes(sec));
    if (!validSections) return false;
  }
  if (opts.context && (typeof opts.context !== 'string' || opts.context.length > 2000)) return false;
  return true;
}

// Security helper to redact sensitive git passwords/tokens from log output
function sanitizeLogMessage(message, secretAuth) {
  if (!message) return '';
  let cleaned = message;
  if (secretAuth && secretAuth.password) {
    const encodedPass = encodeURIComponent(secretAuth.password);
    cleaned = cleaned.split(encodedPass).join('***REDACTED***');
    cleaned = cleaned.split(secretAuth.password).join('***REDACTED***');
  }
  // Strip any URL auth user:pass@ from https:// URLs in command output
  cleaned = cleaned.replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)@/g, '$1***REDACTED***:***REDACTED***@');
  return cleaned;
}

// Helper to log system events to a job's log list
function logSystemEvent(jobId, message, isError = false) {
  const sanitized = sanitizeLogMessage(message, jobSecrets[jobId]);
  const logEntry = {
    time: new Date(),
    source: isError ? 'stderr' : 'system',
    message: sanitized
  };
  if (jobs[jobId]) {
    jobs[jobId].logs.push(logEntry);
  }
  
  // Broadcast to SSE clients
  if (sseClients[jobId]) {
    sseClients[jobId].forEach(res => {
      res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
    });
  }
}

// Persist all jobs metadata to GCS (or mock local storage) as a single JSON array
async function persistJobsMetadata() {
  const jobsArray = Object.values(jobs);
  const jsonContent = JSON.stringify(jobsArray, null, 2);
  
  if (!storage) {
    try {
      const mockStorageDir = path.join(__dirname, 'mock-storage');
      fs.mkdirSync(mockStorageDir, { recursive: true });
      fs.writeFileSync(
        path.join(mockStorageDir, 'codmod-jobs.json'),
        jsonContent
      );
      console.log('Saved all jobs metadata to local mock storage.');
    } catch (err) {
      console.error('Failed to save mock metadata locally:', err.message);
    }
    return;
  }
  
  const bucketName = process.env.GCS_BUCKET_NAME || 'codmod-output';
  
  try {
    const bucket = storage.bucket(bucketName);
    const gcsDestination = 'codmod-jobs.json';
    const tempMetadataPath = path.join(SANDBOX_DIR, 'codmod-jobs.json');
    
    // Write metadata to temporary file
    fs.writeFileSync(tempMetadataPath, jsonContent);
    
    // Upload to GCS
    await bucket.upload(tempMetadataPath, {
      destination: gcsDestination,
      metadata: {
        contentType: 'application/json',
        cacheControl: 'no-cache, no-store, must-revalidate',
      }
    });
    
    // Clean up temporary file
    if (fs.existsSync(tempMetadataPath)) {
      fs.unlinkSync(tempMetadataPath);
    }
    
    console.log(`All jobs metadata successfully persisted to GCS: gs://${bucketName}/${gcsDestination}`);
  } catch (err) {
    console.error('Failed to persist jobs metadata to GCS:', err.message);
  }
}

// Load all jobs metadata from GCS on startup
async function loadJobsFromGCS() {
  if (!storage) return false;
  const bucketName = process.env.GCS_BUCKET_NAME || 'codmod-output';
  console.log(`Attempting to load jobs from GCS bucket: ${bucketName}...`);
  
  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file('codmod-jobs.json');
    
    const [exists] = await file.exists();
    if (!exists) {
      console.log('No previous jobs metadata file found in GCS. Starting with empty history.');
      return true;
    }
    
    const [content] = await file.download();
    const jobsList = JSON.parse(content.toString('utf8'));
    
    jobsList.forEach(jobData => {
      if (jobData.createdAt) jobData.createdAt = new Date(jobData.createdAt);
      if (jobData.startedAt) jobData.startedAt = new Date(jobData.startedAt);
      if (jobData.completedAt) jobData.completedAt = new Date(jobData.completedAt);
      
      jobs[jobData.id] = jobData;
    });
    
    console.log(`Successfully loaded ${Object.keys(jobs).length} jobs from GCS.`);
    return true;
  } catch (err) {
    console.error('Failed to load jobs from GCS:', err.message);
    return false;
  }
}

// Load all jobs metadata from local mock storage on startup
async function loadJobsFromMockStorage() {
  const mockStoragePath = path.join(__dirname, 'mock-storage', 'codmod-jobs.json');
  if (!fs.existsSync(mockStoragePath)) {
    console.log('No previous jobs metadata file found in local mock storage. Starting with empty history.');
    return;
  }
  
  try {
    const content = fs.readFileSync(mockStoragePath, 'utf8');
    const jobsList = JSON.parse(content);
    
    jobsList.forEach(jobData => {
      if (jobData.createdAt) jobData.createdAt = new Date(jobData.createdAt);
      if (jobData.startedAt) jobData.startedAt = new Date(jobData.startedAt);
      if (jobData.completedAt) jobData.completedAt = new Date(jobData.completedAt);
      
      jobs[jobData.id] = jobData;
    });
    
    console.log(`Successfully loaded ${Object.keys(jobs).length} jobs from local mock storage.`);
  } catch (err) {
    console.error('Failed to load jobs from local mock storage:', err.message);
  }
}

// ==========================================
// JOB RUNNER & QUEUE
// ==========================================

async function processQueue() {
  if (activeJobId || jobQueue.length === 0) return;

  activeJobId = jobQueue.shift();
  const job = jobs[activeJobId];
  job.status = 'started';
  job.startedAt = new Date();
  logSystemEvent(activeJobId, `Job started. Active workspace: ${activeJobId}`);

  const workspacePath = path.join(SANDBOX_DIR, activeJobId);
  const repoPath = path.join(workspacePath, 'repo');
  let skipCleanup = false;

  try {
    // 1. Path Security Check
    const resolvedWorkspace = path.resolve(workspacePath);
    if (!resolvedWorkspace.startsWith(SANDBOX_DIR + path.sep) && resolvedWorkspace !== SANDBOX_DIR) {
      throw new Error('Security Error: Path traversal detected.');
    }

    // 2. Create directories
    fs.mkdirSync(repoPath, { recursive: true });
    logSystemEvent(activeJobId, 'Workspace directories created.');

    // 3. Prepare Repository (Git clone or copy local folder)
    job.status = 'cloning';
    if (job.sourceType === 'local' || job.localPath) {
      logSystemEvent(activeJobId, `Copying local repository folder from ${job.localPath} to sandbox workspace...`);
      const targetLocalPath = path.resolve(job.localPath);
      if (!fs.existsSync(targetLocalPath)) {
        throw new Error(`Local repository path does not exist: ${job.localPath}`);
      }
      fs.cpSync(targetLocalPath, repoPath, {
        recursive: true,
        filter: (src) => !src.includes('/node_modules') && !src.includes('/.git')
      });
      logSystemEvent(activeJobId, 'Local repository prepared successfully in isolated sandbox.');
    } else {
      logSystemEvent(activeJobId, `Cloning repository: ${job.repoUrl} (branch: ${job.branch || 'default'})`);
      
      const gitArgs = ['clone', '--depth', '1'];
      if (job.branch) {
        if (!validateBranchName(job.branch)) {
          throw new Error('Security Error: Invalid git branch name specified.');
        }
        gitArgs.push('--branch', job.branch);
      }
      
      let cloneUrl = job.repoUrl;
      if (jobSecrets[activeJobId] && jobSecrets[activeJobId].password) {
        try {
          const urlObj = new URL(job.repoUrl);
          urlObj.username = encodeURIComponent(jobSecrets[activeJobId].username || 'git');
          urlObj.password = encodeURIComponent(jobSecrets[activeJobId].password);
          cloneUrl = urlObj.toString();
        } catch (err) {
          throw new Error('Invalid Git URL format for authentication.');
        }
      }
      gitArgs.push('--', cloneUrl, repoPath);

      await runCommand('git', gitArgs, activeJobId, jobSecrets[activeJobId]);
      logSystemEvent(activeJobId, 'Repository cloned successfully.');
    }

    // 4a. Handle Cost Estimation Only Job
    if (job.estimateOnly) {
      job.status = 'analyzing';
      logSystemEvent(activeJobId, `Running Codmod Cost Estimation... (Modelset: ${job.options.modelset || '2.5-pro'})`);

      const codmodArgs = ['create', '--estimate-cost'];
      if (job.options.reportType === 'full') {
        codmodArgs.push('full');
      } else if (job.options.reportType === 'data-layer') {
        codmodArgs.push('data-layer');
      } else if (job.options.reportType === 'custom') {
        codmodArgs.push('custom');
      }
      codmodArgs.push('-c', repoPath);

      const project = job.options.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'coba-sdlc';
      const region = job.options.region || 'us-central1';
      codmodArgs.push('-p', project, '-r', region);

      if (job.options.modelset) codmodArgs.push('--modelset', job.options.modelset);
      if (job.options.intent && job.options.reportType !== 'custom') {
        codmodArgs.push('--intent', job.options.intent);
      }
      if (job.options.optionalSections && job.options.optionalSections.length > 0) {
        codmodArgs.push('--optional-sections', job.options.optionalSections.join(','));
      }
      if (job.options.context) {
        codmodArgs.push('--context', job.options.context);
      }
      codmodArgs.push('--allow-large-codebase');

      await runCommand('codmod', codmodArgs, activeJobId);

      let estimatedCostStr = 'Unknown';
      const allLogsText = job.logs.map(l => l.message).join('\n');
      const match = allLogsText.match(/Estimated total cost:\s*([^\r\n]+)/i);
      if (match) {
        estimatedCostStr = match[1].trim();
      }
      job.estimatedCost = estimatedCostStr;
      job.status = 'completed';
      job.completedAt = new Date();
      logSystemEvent(activeJobId, `Cost estimation completed successfully: ${estimatedCostStr}`);
      await persistJobsMetadata();
      return;
    }

    // 4. Run Codmod Assessment
    job.status = 'analyzing';
    logSystemEvent(activeJobId, `Running codmod assessment... (Type: ${job.options.reportType})`);

    const codmodArgs = ['create'];
    
    // Select report type subcommand
    if (job.options.reportType === 'full') {
      codmodArgs.push('full');
    } else if (job.options.reportType === 'data-layer') {
      codmodArgs.push('data-layer');
    } else if (job.options.reportType === 'custom') {
      codmodArgs.push('custom');
    }

    // Input codebase and output path
    codmodArgs.push('-c', repoPath);
    
    const reportFilename = `report.${job.options.format}`;
    const localReportPath = path.join(workspacePath, reportFilename);
    codmodArgs.push('-o', localReportPath);

    // Append GCP configurations
    if (job.options.project) codmodArgs.push('-p', job.options.project);
    if (job.options.region) codmodArgs.push('-r', job.options.region);
    if (job.options.modelset) codmodArgs.push('--modelset', job.options.modelset);
    if (job.options.format) codmodArgs.push('--format', job.options.format);
    
    // Intent is only allowed for non-custom types
    if (job.options.intent && job.options.reportType !== 'custom') {
      codmodArgs.push('--intent', job.options.intent);
    }

    // Optional sections
    if (job.options.optionalSections && job.options.optionalSections.length > 0) {
      codmodArgs.push('--optional-sections', job.options.optionalSections.join(','));
    }

    // Custom context
    if (job.options.context) {
      codmodArgs.push('--context', job.options.context);
    }

    // Non-interactive large codebase consent
    codmodArgs.push('--allow-large-codebase');

    // Run codmod CLI
    await runCommand('codmod', codmodArgs, activeJobId);
    logSystemEvent(activeJobId, 'Codmod analysis completed successfully.');

    // 5. Upload Report to GCS
    job.status = 'uploading';
    logSystemEvent(activeJobId, `Uploading report to GCS bucket: ${job.gcsBucket}`);

    if (storage) {
      const bucket = storage.bucket(job.gcsBucket);
      const gcsDestination = `codmod-reports/${activeJobId}/${reportFilename}`;
      
      await bucket.upload(localReportPath, {
        destination: gcsDestination,
        metadata: {
          contentType: job.options.format === 'html' ? 'text/html' : 'text/plain',
        }
      });
      job.gcsReportPath = gcsDestination;
      logSystemEvent(activeJobId, `Report uploaded successfully to GCS: gs://${job.gcsBucket}/${gcsDestination}`);
    } else {
      // Mock local storage fallback for local development without credentials
      const localStore = path.join(__dirname, 'mock-storage', activeJobId);
      fs.mkdirSync(localStore, { recursive: true });
      fs.copyFileSync(localReportPath, path.join(localStore, reportFilename));
      job.gcsReportPath = `local-fallback/${activeJobId}/${reportFilename}`;
      logSystemEvent(activeJobId, `Warning: Saved report to local mock storage fallback: ${job.gcsReportPath}`);
    }

    job.status = 'completed';
    job.completedAt = new Date();
    logSystemEvent(activeJobId, 'Job finished successfully.');
    await persistJobsMetadata();

  } catch (err) {
    console.error(`Error in Job ${activeJobId}:`, err);
    if (job.status === 'uploading') {
      skipCleanup = true;
    }
    job.status = 'failed';
    job.error = err.message;
    job.completedAt = new Date();
    logSystemEvent(activeJobId, `Job failed: ${err.message}`, true);
    await persistJobsMetadata();
  } finally {
    // SECURITY: Remove any temporary in-memory credentials immediately
    delete jobSecrets[activeJobId];

    // Clean up local workspace files to save space
    if (!skipCleanup) {
      try {
        if (fs.existsSync(workspacePath)) {
          fs.rmSync(workspacePath, { recursive: true, force: true });
          logSystemEvent(activeJobId, 'Temporary workspace files cleaned up.');
        }
      } catch (cleanupErr) {
        console.error('Error cleaning up workspace:', cleanupErr);
      }
    } else {
      logSystemEvent(activeJobId, `Workspace cleanup skipped because upload failed. Temporary files retained at: ${workspacePath}`);
    }

    // Close any remaining SSE connections for this job
    if (sseClients[activeJobId]) {
      sseClients[activeJobId].forEach(res => {
        res.write('event: end\ndata: Job completed\n\n');
        res.end();
      });
      delete sseClients[activeJobId];
    }

    activeJobId = null;
    // Process next job
    processQueue();
  }
}

// Promisified execution using spawn with direct logs capture and secret redaction
function runCommand(command, args, jobId, secretAuth = null) {
  return new Promise((resolve, reject) => {
    // Ensure CLI tools write config to writable XDG_CONFIG_DIR
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: XDG_CONFIG_DIR
    };
    // SECURITY: Spawn process directly without shell:true. Arguments are completely isolated.
    const proc = spawn(command, args, { env });

    proc.stdout.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        const sanitizedMsg = sanitizeLogMessage(message, secretAuth);
        const logEntry = { time: new Date(), source: 'stdout', message: sanitizedMsg };
        jobs[jobId].logs.push(logEntry);
        // Broadcast
        if (sseClients[jobId]) {
          sseClients[jobId].forEach(res => {
            res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
          });
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        const sanitizedMsg = sanitizeLogMessage(message, secretAuth);
        const logEntry = { time: new Date(), source: 'stderr', message: sanitizedMsg };
        jobs[jobId].logs.push(logEntry);
        // Broadcast
        if (sseClients[jobId]) {
          sseClients[jobId].forEach(res => {
            res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
          });
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command '${command}' failed with exit code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start command '${command}': ${err.message}`));
    });
  });
}

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Get list of all jobs
app.get('/api/jobs', (req, res) => {
  const jobsList = Object.values(jobs)
    .filter(j => !j.estimateOnly)
    .map(j => {
      // Exclude full logs from the main list to reduce payload size
      const { logs, ...jobSummary } = j;
      return jobSummary;
    });
  res.json(jobsList);
});

// Get detailed job info
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

// Endpoint to browse local filesystem folders for Local Repository selection
app.get('/api/fs/browse', (req, res) => {
  try {
    const queryDir = req.query.dir ? String(req.query.dir) : LOCAL_REPOS_DIR;
    const resolvedDir = path.resolve(queryDir);
    
    if (!fs.existsSync(resolvedDir)) {
      return res.status(404).json({ error: 'Directory does not exist: ' + queryDir });
    }
    const stat = fs.statSync(resolvedDir);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory.' });
    }

    const parentDir = path.dirname(resolvedDir) !== resolvedDir ? path.dirname(resolvedDir) : null;
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    
    const directories = entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => ({
        name: entry.name,
        path: path.join(resolvedDir, entry.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      currentDir: resolvedDir,
      parentDir,
      directories
    });
  } catch (err) {
    console.error('FS Browse error:', err);
    res.status(500).json({ error: 'Failed to read directory: ' + err.message });
  }
});

// Create/Trigger a new job
app.post('/api/jobs', (req, res) => {
  const { sourceType, repoUrl, branch, gitUsername, gitPassword, localPath, gcsBucket, options, force } = req.body;
  const type = sourceType === 'local' ? 'local' : 'git';

  // 1. Security Inputs Validation
  if (type === 'git') {
    if (!validateGitUrl(repoUrl)) {
      return res.status(400).json({ error: 'Invalid Git Repository URL. Only standard HTTPS GitHub/GitLab URLs are supported.' });
    }
  } else {
    if (!localPath || typeof localPath !== 'string') {
      return res.status(400).json({ error: 'Local repository folder path is required when using a local source.' });
    }
    const targetPath = path.resolve(localPath);
    if (!fs.existsSync(targetPath)) {
      return res.status(400).json({ error: `Local repository folder does not exist: ${localPath}` });
    }
    if (!fs.statSync(targetPath).isDirectory()) {
      return res.status(400).json({ error: `Local repository path must be a directory: ${localPath}` });
    }
  }

  if (!validateBucketName(gcsBucket)) {
    return res.status(400).json({ error: 'Invalid Google Cloud Storage bucket name.' });
  }
  
  const jobOptions = {
    reportType: options?.reportType || 'default',
    format: options?.format || 'html',
    modelset: options?.modelset || '2.5-pro',
    project: options?.project || '',
    region: options?.region || 'us-central1',
    intent: options?.intent || '',
    optionalSections: options?.optionalSections || [],
    context: options?.context || ''
  };

  if (!validateOptions(jobOptions)) {
    return res.status(400).json({ error: 'Invalid assessment configuration options.' });
  }

  // 1b. Check for duplicate repository run
  if (!force) {
    const checkUrl = type === 'local' ? `local://${path.resolve(localPath)}` : repoUrl;
    const existingJob = Object.values(jobs).find(j => 
      j.repoUrl === checkUrl && 
      (j.branch || null) === (branch || null) && 
      j.status === 'completed' &&
      j.gcsReportPath
    );
    
    if (existingJob) {
      return res.status(409).json({
        duplicate: true,
        existingJobId: existingJob.id,
        completedAt: existingJob.completedAt,
        format: existingJob.options.format,
        message: `An assessment report for this repository was already successfully generated on ${new Date(existingJob.completedAt).toISOString()}.`
      });
    }
  }

  // 2. Create Job Record
  const jobId = uuidv4();
  const checkUrl = type === 'local' ? `local://${path.resolve(localPath)}` : repoUrl;
  const newJob = {
    id: jobId,
    sourceType: type,
    repoUrl: checkUrl,
    localPath: type === 'local' ? path.resolve(localPath) : null,
    branch: type === 'local' ? null : (branch || null),
    gcsBucket,
    status: 'queued',
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    options: jobOptions,
    logs: [],
    error: null
  };

  if (type === 'git' && gitPassword) {
    jobSecrets[jobId] = { username: gitUsername || 'git', password: gitPassword };
  }

  jobs[jobId] = newJob;
  jobQueue.push(jobId);

  logSystemEvent(jobId, 'Job successfully queued.');
  
  // Trigger queue processing asynchronously
  processQueue();

  res.status(202).json({
    message: 'Job successfully queued',
    jobId: jobId
  });
});

// Estimate Assessment Cost endpoint (runs codmod --estimate-cost)
app.post('/api/estimate', (req, res) => {
  const { sourceType, repoUrl, branch, gitUsername, gitPassword, localPath, options } = req.body;
  const type = sourceType === 'local' ? 'local' : 'git';

  if (type === 'git') {
    if (!validateGitUrl(repoUrl)) {
      return res.status(400).json({ error: 'Invalid Git Repository URL. Only standard HTTPS GitHub/GitLab URLs are supported.' });
    }
  } else {
    if (!localPath || typeof localPath !== 'string') {
      return res.status(400).json({ error: 'Local repository folder path is required when using a local source.' });
    }
    const targetPath = path.resolve(localPath);
    if (!fs.existsSync(targetPath)) {
      return res.status(400).json({ error: `Local repository folder does not exist: ${localPath}` });
    }
    if (!fs.statSync(targetPath).isDirectory()) {
      return res.status(400).json({ error: `Local repository path must be a directory: ${localPath}` });
    }
  }

  const jobOptions = {
    reportType: options?.reportType || 'default',
    format: options?.format || 'html',
    modelset: options?.modelset || '2.5-pro',
    project: options?.project || '',
    region: options?.region || 'us-central1',
    intent: options?.intent || '',
    optionalSections: options?.optionalSections || [],
    context: options?.context || ''
  };

  if (!validateOptions(jobOptions)) {
    return res.status(400).json({ error: 'Invalid assessment configuration options.' });
  }

  const jobId = uuidv4();
  const checkUrl = type === 'local' ? `local://${path.resolve(localPath)}` : repoUrl;
  const newJob = {
    id: jobId,
    sourceType: type,
    repoUrl: checkUrl,
    localPath: type === 'local' ? path.resolve(localPath) : null,
    branch: type === 'local' ? null : (branch || null),
    gcsBucket: 'estimate-only',
    status: 'queued',
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    options: jobOptions,
    estimateOnly: true,
    estimatedCost: null,
    logs: [],
    error: null
  };

  if (type === 'git' && gitPassword) {
    jobSecrets[jobId] = { username: gitUsername || 'git', password: gitPassword };
  }

  jobs[jobId] = newJob;
  jobQueue.push(jobId);

  logSystemEvent(jobId, 'Cost estimation job successfully queued.');
  
  processQueue();

  res.status(202).json({
    message: 'Cost estimation job successfully queued',
    jobId: jobId
  });
});

// Server-Sent Events (SSE) log stream endpoint
app.get('/api/jobs/:id/logs', (req, res) => {
  const jobId = req.params.id;
  const job = jobs[jobId];

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send historical logs first
  job.logs.forEach(log => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });

  // If the job is already finished, close connection immediately
  if (job.status === 'completed' || job.status === 'failed') {
    res.write('event: end\ndata: Job finished\n\n');
    return res.end();
  }

  // Register client
  if (!sseClients[jobId]) {
    sseClients[jobId] = [];
  }
  sseClients[jobId].push(res);

  // Send periodic keep-alive heartbeat comments every 30 seconds to prevent timeout
  const heartbeatId = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(heartbeatId);
    }
  }, 30000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(heartbeatId);
    if (sseClients[jobId]) {
      sseClients[jobId] = sseClients[jobId].filter(client => client !== res);
    }
  });
});

// Fetch/Stream report from GCS
app.get('/api/jobs/:id/report', async (req, res) => {
  const job = jobs[req.params.id];
  if (!job || !job.gcsReportPath) {
    return res.status(404).json({ error: 'Report not found or job has not completed.' });
  }

  const filename = path.basename(job.gcsReportPath);
  
  // Set headers
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Content-Type', job.options.format === 'html' ? 'text/html' : 'text/plain');

  if (storage) {
    try {
      const bucket = storage.bucket(job.gcsBucket);
      const file = bucket.file(job.gcsReportPath);
      
      const [exists] = await file.exists();
      if (!exists) {
        return res.status(404).json({ error: 'Report file no longer exists in Google Cloud Storage.' });
      }

      // Stream file directly from GCS to user browser
      file.createReadStream()
        .on('error', (err) => {
          console.error('Error streaming from GCS:', err);
          res.status(500).json({ error: 'Failed to retrieve report from Google Cloud Storage' });
        })
        .pipe(res);
    } catch (err) {
      console.error('GCS Error:', err);
      res.status(500).json({ error: 'Storage client error.' });
    }
  } else {
    // Local fallback for local development
    const localStorePath = path.join(__dirname, 'mock-storage', job.id, filename);
    if (fs.existsSync(localStorePath)) {
      res.sendFile(localStorePath);
    } else {
      res.status(404).json({ error: 'Report file not found on local fallback.' });
    }
  }
});

// Start the server
const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, async () => {
  console.log(`Express Server running at http://${HOST}:${PORT}`);
  console.log(`NOTE: Server is bound to ${HOST} for security compliance.`);
  
  // Load previous jobs from GCS or mock local storage on startup
  let gcsLoaded = false;
  if (storage) {
    gcsLoaded = await loadJobsFromGCS();
  }
  if (!gcsLoaded) {
    if (storage) {
      console.warn('WARNING: Could not load job history from Google Cloud Storage (credentials expired or unreachable). Automatically switching to local mock storage fallback.');
      storage = null;
    }
    await loadJobsFromMockStorage();
  }
});

// Periodic cleanup of stale temporary sandbox directories (>1 hour old)
setInterval(() => {
  try {
    if (fs.existsSync(SANDBOX_DIR)) {
      const now = Date.now();
      const entries = fs.readdirSync(SANDBOX_DIR);
      entries.forEach(entry => {
        const fullPath = path.join(SANDBOX_DIR, entry);
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > 3600000) { // 1 hour
          fs.rmSync(fullPath, { recursive: true, force: true });
          console.log(`Cleaned up stale sandbox directory: ${fullPath}`);
        }
      });
    }
  } catch (err) {
    console.error('Error in periodic sandbox cleanup:', err);
  }
}, 3600000).unref();

// Graceful Shutdown for Cloud Run (SIGTERM / SIGINT)
function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Starting graceful shutdown...`);
  if (activeJobId && jobs[activeJobId]) {
    jobs[activeJobId].status = 'failed';
    jobs[activeJobId].error = `Service interrupted due to container shutdown (${signal}).`;
    jobs[activeJobId].completedAt = new Date();
    logSystemEvent(activeJobId, `Job interrupted by server termination (${signal}).`, true);
  }
  Object.keys(sseClients).forEach(jobId => {
    sseClients[jobId].forEach(res => {
      res.write(`event: end\ndata: Server terminating (${signal})\n\n`);
      res.end();
    });
  });
  try {
    if (activeJobId) {
      const workspacePath = path.join(SANDBOX_DIR, activeJobId);
      if (fs.existsSync(workspacePath)) {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
    }
  } catch (err) {
    console.error('Error cleaning up workspace during shutdown:', err);
  }
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

