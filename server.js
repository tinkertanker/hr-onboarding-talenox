const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Honour X-Forwarded-For when behind nginx-proxy
app.set('trust proxy', 1);

// CORS configuration
const corsOptions = {
  origin: function(origin, callback) {
    // In production, require explicit ALLOWED_ORIGINS
    if (process.env.NODE_ENV === 'production') {
      if (!process.env.ALLOWED_ORIGINS) {
        return callback(new Error('ALLOWED_ORIGINS not configured'));
      }
      const allowedOrigins = process.env.ALLOWED_ORIGINS.split(',');
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    } else {
      // Development: allow localhost
      const devOrigins = ['http://localhost:3000', 'http://localhost:8888'];
      if (!origin || devOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(null, true); // Allow all in development
      }
    }
  },
  credentials: true
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
// Parser errors can embed request text in their message/stack. Handle them
// before Express's default logger, without exposing the body or exception.
app.use((error, req, res, next) => {
  const status = error.status || 500;
  console.error(`Request middleware failed with status ${status}`);
  res.status(status).json({
    success: false,
    message: status === 413 ? 'Request too large' : status === 400 ? 'Invalid request' : 'Internal server error'
  });
});
app.use(express.static(path.join(__dirname, 'public')));

// Import handlers
const submitOnboarding = require('./backend/submit-onboarding');
const updateParticulars = require('./backend/update-particulars');

// Shared Netlify-style handler adapter for Express
async function handleNetlifyStyle(handler, req, res, label) {
  try {
    const forwarded = req.headers['x-forwarded-for'];
    const clientIp = req.ip ||
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
      req.socket.remoteAddress ||
      'unknown';

    const event = {
      body: JSON.stringify(req.body),
      headers: req.headers,
      httpMethod: req.method,
      clientIp
    };

    const result = await handler(event);

    // Express middleware owns CORS; do not let function-style handlers override it.
    if (result.headers && typeof result.headers === 'object') {
      for (const [key, value] of Object.entries(result.headers)) {
        if (
          !key.toLowerCase().startsWith('access-control-') &&
          value !== undefined &&
          value !== null &&
          value !== ''
        ) {
          res.setHeader(key, value);
        }
      }
    }

    try {
      const responseBody = typeof result.body === 'string'
        ? JSON.parse(result.body)
        : result.body;
      res.status(result.statusCode).json(responseBody);
    } catch {
      console.error(`Error parsing ${label} response body`);
      res.status(500).json({
        success: false,
        message: 'Invalid response format'
      });
    }
  } catch {
    console.error(`Error in ${label}`);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}

app.post('/api/submit-onboarding', (req, res) => {
  handleNetlifyStyle(submitOnboarding.handler, req, res, 'submit-onboarding');
});

app.post('/api/update-particulars/request-code', (req, res) => {
  return handleNetlifyStyle(updateParticulars.requestCodeHandler, req, res, 'update-particulars-request-code');
});

app.post('/api/update-particulars/verify-code', (req, res) => {
  return handleNetlifyStyle(updateParticulars.verifyCodeHandler, req, res, 'update-particulars-verify-code');
});

app.post('/api/update-particulars', (req, res) => {
  return handleNetlifyStyle(updateParticulars.handler, req, res, 'update-particulars');
});

app.options('/api/submit-onboarding', (req, res) => {
  res.status(200).end();
});

app.options('/api/update-particulars/request-code', (req, res) => {
  res.status(200).end();
});

app.options('/api/update-particulars/verify-code', (req, res) => {
  res.status(200).end();
});

app.options('/api/update-particulars', (req, res) => {
  res.status(200).end();
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'tinkercademy-onboarding'
  });
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
