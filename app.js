
const express = require('express');
const plansRouter = require('./routes/plans');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Basic logging 
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// Routes namespace: /v1
app.use('/v1/plans', plansRouter);

// Health
app.get('/v1/health', (req, res) => res.json({ status: 'ok' }));

// Basic error handler
app.use((err, req, res, next) => {
    console.error(err);
    if (!res.headersSent) {
        res.status(500).json({ error: 'internal_server_error' });
    }
});

module.exports = app;
