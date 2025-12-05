
const express = require('express');
const plansRouter = require('./routes/plans');
const searchRouter = require('./routes/search');
const elasticsearchService = require('./services/elasticsearchService');
const rabbitmqService = require('./services/rabbitmqService');
const redisClient = require('./models/redisClient');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Basic logging 
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// Routes namespace: /v1
app.use('/v1/plans', plansRouter);
app.use('/v1/search', searchRouter);

// Health check with service status
app.get('/v1/health', async (req, res) => {
    const [redisHealth, esHealth, mqHealth] = await Promise.all([
        redisClient.healthCheck(),
        elasticsearchService.healthCheck(),
        rabbitmqService.healthCheck()
    ]);

    const servicesConnected =
        redisHealth.status === 'connected' &&
        esHealth.status === 'connected' &&
        mqHealth.status === 'connected';

    const workerRunning = mqHealth.workerStatus === 'running';

    // Determine overall status
    let status = 'ok';
    if (!servicesConnected) {
        status = 'degraded';
    } else if (!workerRunning) {
        status = 'warning'; // Services up but worker not running
    }

    res.status(servicesConnected ? 200 : 503).json({
        status,
        warning: !workerRunning ? 'Indexing worker is not running. Messages will queue until worker starts.' : undefined,
        services: {
            redis: redisHealth,
            elasticsearch: esHealth,
            rabbitmq: mqHealth
        }
    });
});

// Queue stats endpoint (for monitoring)
app.get('/v1/queue/stats', async (req, res) => {
    try {
        const stats = await rabbitmqService.getQueueStats();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get queue stats' });
    }
});

// Basic error handler
app.use((err, req, res, next) => {
    console.error(err);
    if (!res.headersSent) {
        res.status(500).json({ error: 'internal_server_error' });
    }
});

module.exports = app;
