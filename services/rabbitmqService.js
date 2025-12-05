// services/rabbitmqService.js
const amqp = require('amqplib');

// Build RabbitMQ URL from environment variables
const RABBITMQ_USER = process.env.RABBITMQ_USER || 'healthcare';
const RABBITMQ_PASS = process.env.RABBITMQ_PASS || 'healthcare_secret';
const RABBITMQ_HOST = process.env.RABBITMQ_HOST || 'localhost';
const RABBITMQ_PORT = process.env.RABBITMQ_PORT || '5672';
const RABBITMQ_URL = process.env.RABBITMQ_URL || `amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@${RABBITMQ_HOST}:${RABBITMQ_PORT}`;

const QUEUE_NAME = process.env.QUEUE_NAME || 'plan_indexing_queue';
const EXCHANGE_NAME = 'plan_exchange';
const ROUTING_KEY = 'plan.index';

let connection = null;
let channel = null;

/**
 * Connect to RabbitMQ and setup channel
 */
async function connect() {
    if (connection && channel) {
        return { connection, channel };
    }

    try {
        connection = await amqp.connect(RABBITMQ_URL);
        channel = await connection.createChannel();

        // Setup exchange (direct type for routing)
        await channel.assertExchange(EXCHANGE_NAME, 'direct', { durable: true });

        // Setup queue with dead letter exchange for failed messages
        await channel.assertQueue(QUEUE_NAME, {
            durable: true,
            arguments: {
                'x-dead-letter-exchange': `${EXCHANGE_NAME}_dlx`,
                'x-dead-letter-routing-key': 'plan.dead'
            }
        });

        // Setup dead letter queue for failed messages
        await channel.assertExchange(`${EXCHANGE_NAME}_dlx`, 'direct', { durable: true });
        await channel.assertQueue(`${QUEUE_NAME}_dead`, { durable: true });
        await channel.bindQueue(`${QUEUE_NAME}_dead`, `${EXCHANGE_NAME}_dlx`, 'plan.dead');

        // Bind main queue to exchange
        await channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, ROUTING_KEY);

        // Set prefetch to 1 for fair dispatch
        await channel.prefetch(1);

        console.log('Connected to RabbitMQ');

        // Handle connection errors
        connection.on('error', (err) => {
            console.error('RabbitMQ connection error:', err.message);
            connection = null;
            channel = null;
        });

        connection.on('close', () => {
            console.log('RabbitMQ connection closed');
            connection = null;
            channel = null;
        });

        return { connection, channel };
    } catch (error) {
        console.error('Failed to connect to RabbitMQ:', error.message);
        throw error;
    }
}

/**
 * Publish a message to the queue
 * @param {string} operation - 'index', 'update', or 'delete'
 * @param {object} data - The plan document or plan ID
 */
async function publishMessage(operation, data) {
    try {
        const { channel } = await connect();

        const message = {
            operation,
            data,
            timestamp: new Date().toISOString(),
            messageId: `${operation}-${data.objectId || data}-${Date.now()}`
        };

        const messageBuffer = Buffer.from(JSON.stringify(message));

        channel.publish(EXCHANGE_NAME, ROUTING_KEY, messageBuffer, {
            persistent: true, // Message survives broker restart
            contentType: 'application/json',
            messageId: message.messageId
        });

        console.log(`Published ${operation} message for: ${data.objectId || data}`);
        return { success: true, messageId: message.messageId };
    } catch (error) {
        console.error('Failed to publish message:', error.message);
        throw error;
    }
}

/**
 * Publish index operation
 */
async function publishIndexOperation(planDocument) {
    return publishMessage('index', planDocument);
}

/**
 * Publish update operation (for PATCH)
 */
async function publishUpdateOperation(planDocument) {
    return publishMessage('update', planDocument);
}

/**
 * Publish delete operation
 */
async function publishDeleteOperation(planId) {
    return publishMessage('delete', { objectId: planId });
}

/**
 * Consume messages from the queue
 * @param {function} handler - Async function to process messages
 */
async function consumeMessages(handler) {
    const { channel } = await connect();

    console.log(`Waiting for messages in queue: ${QUEUE_NAME}`);

    channel.consume(QUEUE_NAME, async (msg) => {
        if (msg === null) return;

        try {
            const content = JSON.parse(msg.content.toString());
            console.log(`Processing message: ${content.operation} for ${content.data.objectId || content.data}`);

            await handler(content);

            // Acknowledge successful processing
            channel.ack(msg);
            console.log(`Message processed successfully: ${content.messageId}`);
        } catch (error) {
            console.error('Error processing message:', error.message);

            // Reject and don't requeue (will go to dead letter queue)
            channel.nack(msg, false, false);
        }
    }, { noAck: false });
}

/**
 * Get queue statistics
 */
async function getQueueStats() {
    try {
        const { channel } = await connect();
        const queueInfo = await channel.checkQueue(QUEUE_NAME);
        const deadQueueInfo = await channel.checkQueue(`${QUEUE_NAME}_dead`);

        return {
            queue: {
                name: QUEUE_NAME,
                messageCount: queueInfo.messageCount,
                consumerCount: queueInfo.consumerCount
            },
            deadLetterQueue: {
                name: `${QUEUE_NAME}_dead`,
                messageCount: deadQueueInfo.messageCount
            }
        };
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Health check for RabbitMQ - includes worker/consumer status
 */
async function healthCheck() {
    try {
        const { channel } = await connect();
        const queueInfo = await channel.checkQueue(QUEUE_NAME);

        return {
            status: 'connected',
            queue: QUEUE_NAME,
            consumers: queueInfo.consumerCount,
            messagesReady: queueInfo.messageCount,
            workerStatus: queueInfo.consumerCount > 0 ? 'running' : 'not_running'
        };
    } catch (error) {
        return { status: 'disconnected', error: error.message };
    }
}

/**
 * Close connection gracefully
 */
async function close() {
    try {
        if (channel) {
            await channel.close();
        }
        if (connection) {
            await connection.close();
        }
        console.log('RabbitMQ connection closed gracefully');
    } catch (error) {
        console.error('Error closing RabbitMQ connection:', error.message);
    }
}

module.exports = {
    connect,
    publishMessage,
    publishIndexOperation,
    publishUpdateOperation,
    publishDeleteOperation,
    consumeMessages,
    getQueueStats,
    healthCheck,
    close,
    QUEUE_NAME,
    EXCHANGE_NAME
};
