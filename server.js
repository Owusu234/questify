require('dotenv').config();

// ==================== VALIDATION ====================
const REQUIRED_ENV = ['PORT', 'JWT_SECRET', 'GOOGLE_AI_API_KEY', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SUPABASE_URL', 'SUPABASE_KEY'];
const MISSING = REQUIRED_ENV.filter(k => !process.env[k]);
if (MISSING.length) {
  console.error(`❌ Missing required environment variables: ${MISSING.join(', ')}`);
  process.exit(1);
}

// ==================== IMPORTS ====================
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs').promises;
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// ==================== MIDDLEWARE ====================
// ✅ UPDATED CSP: Allow Google Fonts, Source Maps, Supabase
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // ✅ Allow Google Fonts CSS
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      // ✅ Allow Google Fonts files and data URIs
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "cdn.jsdelivr.net"],
      // ✅ Allow source maps and CDNs
      connectSrc: [
        "'self'", 
        "https://generativelanguage.googleapis.com", 
        "https://api.qrserver.com", 
        "https://*.supabase.co",
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com"
      ],
      imgSrc: ["'self'", "https:", "data:", ""],
    }
  }
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  credentials: true
}));

app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1y' : '0',
  etag: true
}));

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const log = `${res.statusCode} ${req.method} ${req.originalUrl} ${ms}ms`;
    res.statusCode >= 400 ? console.warn(`⚠️  ${log}`) : console.log(`✅ ${log}`);
  });
  next();
});

// Rate Limiters
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, message: { error: 'Too many auth attempts' } });
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: 'AI rate limit reached' } });
app.use(rateLimit({ windowMs: 60 * 1000, max: 150, message: { error: 'Too many requests' } }));

// ==================== DATA LAYER ====================
const ensureDir = async () => await fs.mkdir(DATA_DIR, { recursive: true });
const loadJSON = async (file) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return []; } };
const saveJSON = async (file, data) => {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
};

const initStorage = async () => {
  await ensureDir();
  const users = await loadJSON(USERS_FILE);
  if (!users.find(u => u.email === process.env.ADMIN_EMAIL)) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    users.push({ id: 'admin_init', name: 'System Admin', email: process.env.ADMIN_EMAIL, password: hash, role: 'admin', createdAt: new Date().toISOString() });
    await saveJSON(USERS_FILE, users);
    console.log('✅ Default admin initialized');
  }
};

// ==================== AUTH MIDDLEWARE ====================
const verifyToken = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(403).json({ error: 'Invalid or expired session' }); }
};
const requireAdmin = (req, res, next) => req.user?.role !== 'admin' ? res.status(403).json({ error: 'Forbidden' }) : next();
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ==================== AUTH ROUTES ====================
app.post('/api/auth/signup', authLimiter, wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 8 || !/[A-Z]/.test(password) || !/\d/.test(password)) return res.status(400).json({ error: '8+ chars, 1 uppercase, 1 number' });
  const users = await loadJSON(USERS_FILE);
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'Email already registered' });
  
  const hash = await bcrypt.hash(password, 12);
  const user = { id: 'usr_' + Date.now().toString(36), name, email: email.toLowerCase(), password: hash, role: 'user', createdAt: new Date().toISOString() };
  users.push(user); await saveJSON(USERS_FILE, users);
  
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
  res.status(201).json({ success: true, user: { id: user.id, name, email, role: 'user' } });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const { email, password } = req.body;
  const users = await loadJSON(USERS_FILE);
  const user = users.find(u => u.email === email.toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
  
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
  res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

app.post('/api/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ success: true }); });
app.get('/api/auth/me', verifyToken, wrap(async (req, res) => {
  const users = await loadJSON(USERS_FILE);
  const u = users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
}));

// ==================== ADMIN ROUTES ====================
app.get('/api/admin/users', verifyToken, requireAdmin, wrap(async (req, res) => {
  const users = await loadJSON(USERS_FILE);
  res.json(users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt })));
}));

app.delete('/api/admin/users/:id', verifyToken, requireAdmin, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  const users = await loadJSON(USERS_FILE);
  const filtered = users.filter(u => u.id !== req.params.id);
  if (filtered.length === 0) return res.status(400).json({ error: 'Must keep at least one admin' });
  await saveJSON(USERS_FILE, filtered);
  res.json({ success: true });
}));

// ==================== ✅ SUPABASE CONFIG ROUTE (MUST BE ABOVE FALLBACK) ====================
app.get('/api/config', (req, res) => {
  console.log('🔑 Serving Supabase config to:', req.ip);
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY
  });
});

// ==================== AI ROUTES ====================
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
const callGemini = async (prompt, sys = '') => {
  const m = genAI.getGenerativeModel({ model: 'gemini-pro', generationConfig: { temperature: 0.7, maxOutputTokens: 4096 } });
  return (await m.generateContent(sys ? `${sys}\n\n${prompt}` : prompt)).response.text();
};

app.post('/api/ai/generate', aiLimiter, verifyToken, wrap(async (req, res) => {
  const { topic, count = 5, context = '' } = req.body;
  if (!topic) return res.status(400).json({ error: 'Topic required' });
  const c = await callGemini(`Create ${count} survey questions about: "${topic}". ${context ? `Context: ${context}` : ''} Return ONLY JSON array of {text,type(mc|cb|tx|ta|rt|dd),required,options[]}.`);
  res.json({ success: true, questions: JSON.parse(c.replace(/```(?:json)?\s*/g, '').replace(/\s*```/g, '').trim()) });
}));

app.post('/api/ai/analyze', aiLimiter, verifyToken, wrap(async (req, res) => {
  const { title, questions, responses, responseCount = 0 } = req.body;
  if (!questions?.length || !responses?.length) return res.status(400).json({ error: 'Data required' });
  
  const samples = responses.slice(0, 15).map((r) => {
    const obj = {};
    const ans = r.answers || r.responses || {};
    questions.forEach((q, i) => {
      const key = Object.keys(ans)[i] || `q_${i}`;
      const val = ans[key];
      obj[`Q${i + 1}`] = Array.isArray(val) ? val.join(', ') : (val || 'Skipped');
    });
    return obj;
  });

  const datasetNote = responseCount < 5 
    ? `Note: This analysis is based on only ${responseCount} response(s). Provide cautious, preliminary insights.` 
    : '';

  const c = await callGemini(
    `Analyze survey "${title}". Output ONLY JSON: {summary,sentiment(positive|neutral|mixed|negative),keyThemes[],recommendations[]}. ${datasetNote} Data: ${JSON.stringify(samples)}`, 
    'Data analyst. Strict JSON.'
  );
  res.json({ success: true, analysis: JSON.parse(c.replace(/```(?:json)?\s*/g, '').replace(/\s*```/g, '').trim()) });
}));

// ==================== HEALTH & FALLBACK (MUST BE LAST) ====================
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), env: process.env.NODE_ENV || 'development' }));

// ✅ FALLBACK ROUTE MUST BE LAST
app.get('*', (req, res) => {
  console.log('📄 Serving index.html for:', req.originalUrl);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== STARTUP ====================
const server = app.listen(PORT, async () => {
  try {
    await initStorage();
    console.log(`🌍 Questify Pro running: http://localhost:${PORT} [${process.env.NODE_ENV || 'dev'}]`);
    console.log(`🔒 Security: Helmet + CORS + Rate Limits`);
    console.log(`🔑 Supabase: ${process.env.SUPABASE_URL ? '✅ Configured' : '❌ Missing'}`);
  } catch (e) {
    console.error('❌ Startup failed:', e);
    process.exit(1);
  }
});

process.on('SIGTERM', () => { console.log('🛑 Shutting down...'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { console.log('🛑 Shutting down...'); server.close(() => process.exit(0)); });