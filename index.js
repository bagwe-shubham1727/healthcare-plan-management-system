require('dotenv').config();
const app = require('./app');
const elasticsearchService = require('./services/elasticsearchService');
const rabbitmqService = require('./services/rabbitmqService');

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        // Initialize Elasticsearch (create index with mapping if not exists)
        console.log('Initializing Elasticsearch...');
        await elasticsearchService.initialize();

        // Connect to RabbitMQ
        console.log('Connecting to RabbitMQ...');
        await rabbitmqService.connect();

        // Start Express server
        app.listen(PORT, () => {
            console.log(`API v1 listening on http://localhost:${PORT}`);
            console.log('Services initialized: Redis, Elasticsearch, RabbitMQ');
        });
    } catch (error) {
        console.error('Failed to start server:', error.message);
        // Start server anyway - services may come online later
        app.listen(PORT, () => {
            console.log(`API v1 listening on http://localhost:${PORT} (degraded mode)`);
        });
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    await rabbitmqService.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    await rabbitmqService.close();
    process.exit(0);
});

startServer();
