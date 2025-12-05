// workers/indexingWorker.js
/**
 * Queue Consumer Worker
 * Processes messages from RabbitMQ and indexes to Elasticsearch
 * Run separately: node workers/indexingWorker.js
 */

require('dotenv').config();
const rabbitmqService = require('../services/rabbitmqService');
const elasticsearchService = require('../services/elasticsearchService');

const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;

/**
 * Process a single message from the queue
 */
async function processMessage(message) {
    const { operation, data, messageId } = message;

    console.log(`[Worker] Processing ${operation} operation, messageId: ${messageId}`);

    switch (operation) {
        case 'index':
            await elasticsearchService.indexPlan(data);
            console.log(`[Worker] Indexed plan: ${data.objectId}`);
            break;

        case 'update':
            await elasticsearchService.updatePlan(data);
            console.log(`[Worker] Updated plan in index: ${data.objectId}`);
            break;

        case 'delete':
            await elasticsearchService.deletePlan(data.objectId);
            console.log(`[Worker] Deleted plan from index: ${data.objectId}`);
            break;

        default:
            console.warn(`[Worker] Unknown operation: ${operation}`);
    }
}

/**
 * Start the worker
 */
async function startWorker() {
    console.log('[Worker] Starting indexing worker...');

    // Wait for Elasticsearch to be ready
    let esReady = false;
    let retries = 0;

    while (!esReady && retries < MAX_RETRIES) {
        try {
            await elasticsearchService.initialize();
            esReady = true;
        } catch (error) {
            retries++;
            console.log(`[Worker] Waiting for Elasticsearch... (attempt ${retries}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }

    if (!esReady) {
        console.error('[Worker] Failed to connect to Elasticsearch after retries');
        process.exit(1);
    }

    // Start consuming messages
    try {
        await rabbitmqService.consumeMessages(processMessage);
        console.log('[Worker] Worker is running and waiting for messages...');
    } catch (error) {
        console.error('[Worker] Failed to start consumer:', error.message);
        process.exit(1);
    }
}

/**
 * Graceful shutdown
 */
async function shutdown() {
    console.log('[Worker] Shutting down gracefully...');
    await rabbitmqService.close();
    process.exit(0);
}

// Handle process signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the worker
startWorker().catch(error => {
    console.error('[Worker] Fatal error:', error);
    process.exit(1);
});
