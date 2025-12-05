# Healthcare Plan Management API

> A production-grade distributed system demonstrating advanced Big Data indexing techniques with Elasticsearch parent-child relationships, message queue processing, and RESTful API design.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5.x-blue.svg)](https://expressjs.com/)
[![Elasticsearch](https://img.shields.io/badge/Elasticsearch-8.11-yellow.svg)](https://www.elastic.co/)
[![Redis](https://img.shields.io/badge/Redis-7-red.svg)](https://redis.io/)
[![RabbitMQ](https://img.shields.io/badge/RabbitMQ-3.12-orange.svg)](https://www.rabbitmq.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue.svg)](https://docs.docker.com/compose/)

---

## 🎯 Project Overview

This project implements a **healthcare insurance plan management system** that showcases:

- **Distributed Data Storage**: Plans stored as individual objects in Redis with `objectType:objectId` key pattern
- **Parent-Child Indexing**: Elasticsearch join field mapping for hierarchical plan data
- **Asynchronous Processing**: RabbitMQ message queue with Dead Letter Queue (DLQ) for reliable indexing
- **Conditional HTTP Semantics**: Full ETag support for optimistic concurrency control
- **OAuth2 Security**: Google ID token verification for API authentication

---

## 🏗️ System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT (Postman/cURL)                           │
│                           + Google OAuth2 ID Token                           │
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                            EXPRESS.js REST API                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  POST /plans │  │  GET /plans │  │ PATCH /plans│  │   DELETE /plans     │  │
│  │  (Create)   │  │   (Read)    │  │  (Update)   │  │ (Cascaded Delete)   │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                    JSON Schema Validation (AJV)                              │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│      REDIS 7      │  │   RABBITMQ 3.12   │  │   ELASTICSEARCH   │
│   (KV Storage)    │  │  (Message Queue)  │  │      8.11         │
│                   │  │                   │  │                   │
│ Keys:             │  │ Queues:           │  │ Index:            │
│ • plan:id         │  │ • plan_indexing   │  │ • healthcare_plans│
│ • service:id      │  │ • dead_letter_q   │  │                   │
│ • planservice:id  │  │                   │  │ Join Mapping:     │
│ • membercostshare │  │                   │  │ plan → children   │
│   :id             │  │                   │  │                   │
└───────────────────┘  └─────────┬─────────┘  └───────────────────┘
                                 │                       ▲
                                 ▼                       │
                      ┌───────────────────┐              │
                      │   WORKER PROCESS  │──────────────┘
                      │  (Queue Consumer) │
                      │                   │
                      │ Operations:       │
                      │ • index           │
                      │ • update          │
                      │ • delete          │
                      └───────────────────┘
```

---

## 💡 Key Technical Features

### 1. **Distributed Key-Value Storage (Redis)**
- Each object stored with its own key: `{objectType}:{objectId}`
- Example keys: `plan:12345`, `service:67890`, `membercostshare:11111`
- Plan reconstructed from individual objects on read
- Enables granular access and updates

### 2. **Parent-Child Elasticsearch Indexing**
```
Plan (root)
├── planCostShares (membercostshare)
└── linkedPlanServices[] (planservice)
    ├── linkedService (service)
    └── planserviceCostShares (membercostshare)
```
- Uses Elasticsearch `join` field type
- All documents for a plan share the same `routing` key
- Enables efficient parent-child queries

### 3. **Message Queue with Dead Letter Queue**
- RabbitMQ processes index/update/delete operations asynchronously
- Failed messages routed to DLQ for debugging
- Decouples API from indexing latency

### 4. **Conditional HTTP Operations**
| Header | Purpose |
|--------|---------|
| `ETag` | Resource version identifier (SHA-256 hash) |
| `If-Match` | Required for PATCH/DELETE (optimistic locking) |
| `If-None-Match` | Cache validation (returns 304 if unchanged) |
| `Last-Modified` | Timestamp of last modification |

### 5. **JSON Schema Validation**
- Strict validation using AJV (Another JSON Validator)
- Schema enforces required fields, types, and nested structure
- Returns detailed validation errors

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- Google Cloud OAuth2 Client ID

### 1. Clone & Install
```bash
git clone https://github.com/yourusername/healthcare-plan-management-system.git
cd healthcare-plan-management-system
npm install
```

### 2. Configure Environment
```bash
# Create .env file
cat > .env << EOF
PORT=3000
REDIS_URL=redis://localhost:6379
ELASTICSEARCH_URL=http://localhost:9200
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
RABBITMQ_USER=healthcare
RABBITMQ_PASS=healthcare_secret
EOF
```

### 3. Start Infrastructure
```bash
docker-compose up -d
# Wait ~30 seconds for services to initialize
```

### 4. Start Application
```bash
# Terminal 1: API Server
npm run dev

# Terminal 2: Queue Worker
npm run worker
```

### 5. Verify Services
| Service | URL | Credentials |
|---------|-----|-------------|
| API Health | http://localhost:3000/v1/health | - |
| Kibana | http://localhost:5601 | - |
| RabbitMQ UI | http://localhost:15672 | healthcare / healthcare_secret |
| Elasticsearch | http://localhost:9200 | - |

---

## 📡 API Reference

### Authentication
All endpoints require Google OAuth2 ID token:
```bash
-H "Authorization: Bearer <google-id-token>"
```

### Endpoints

#### Create Plan
```bash
POST /v1/plans
Content-Type: application/json

# Response: 201 Created
# Headers: ETag, Last-Modified, Location
```

#### Get Plan
```bash
GET /v1/plans/:objectId
# Optional: If-None-Match header for caching

# Response: 200 OK (or 304 Not Modified)
```

#### Update Plan (Merge Patch)
```bash
PATCH /v1/plans/:objectId
If-Match: "<etag>"
Content-Type: application/json

# Response: 200 OK with updated document
```

#### Delete Plan (Cascaded)
```bash
DELETE /v1/plans/:objectId
If-Match: "<etag>"

# Response: 204 No Content
# Deletes from Redis AND Elasticsearch
```

#### Health Check
```bash
GET /v1/health

# Response includes status of:
# - Redis
# - Elasticsearch  
# - RabbitMQ (with worker count)
```

---

## 📊 Data Model

### Plan Structure
```json
{
  "planCostShares": {
    "deductible": 2000,
    "_org": "example.com",
    "copay": 23,
    "objectId": "1234vxc2324sdf-501",
    "objectType": "membercostshare"
  },
  "linkedPlanServices": [
    {
      "linkedService": {
        "_org": "example.com",
        "objectId": "1234520xvc30asdf-502",
        "objectType": "service",
        "name": "Yearly physical"
      },
      "planserviceCostShares": {
        "deductible": 10,
        "_org": "example.com",
        "copay": 0,
        "objectId": "1234512xvc1314asdfs-503",
        "objectType": "membercostshare"
      },
      "_org": "example.com",
      "objectId": "27283xvx9asdff-504",
      "objectType": "planservice"
    }
  ],
  "_org": "example.com",
  "objectId": "12xvxc345ssdsds-508",
  "objectType": "plan",
  "planType": "inNetwork",
  "creationDate": "12-12-2024"
}
```

### Redis Key Pattern
```
plan:12xvxc345ssdsds-508           → Plan root object + metadata (etag, timestamps)
membercostshare:1234vxc2324sdf-501 → planCostShares
planservice:27283xvx9asdff-504     → linkedPlanService
service:1234520xvc30asdf-502       → linkedService
membercostshare:1234512xvc1314asdfs-503 → planserviceCostShares
```

**8 keys per plan** (matching 8 documents in Elasticsearch)

---

## 🔍 Elasticsearch Queries

### Query All Documents
```bash
curl "localhost:9200/healthcare_plans/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{"query": {"match_all": {}}}'
```

### Find Children of a Plan
```bash
curl "localhost:9200/healthcare_plans/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "has_parent": {
        "parent_type": "plan",
        "query": { "term": { "objectId": "12xvxc345ssdsds-508" }}
      }
    }
  }'
```

### Count Documents
```bash
curl "localhost:9200/healthcare_plans/_count"
```

### Delete All Documents
```bash
curl -X POST "localhost:9200/healthcare_plans/_delete_by_query" \
  -H "Content-Type: application/json" \
  -d '{"query": {"match_all": {}}}'
```

---

## 🧪 Testing

### Sample cURL Commands

```bash
# Get OAuth token (use Google OAuth Playground or gcloud CLI)
TOKEN=$(gcloud auth print-identity-token)

# Create Plan
curl -X POST http://localhost:3000/v1/plans \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @plan-example.json

# Get Plan (note the ETag in response headers)
curl -i http://localhost:3000/v1/plans/12xvxc345ssdsds-508 \
  -H "Authorization: Bearer $TOKEN"

# Update Plan (use ETag from GET response)
curl -X PATCH http://localhost:3000/v1/plans/12xvxc345ssdsds-508 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'If-Match: "<etag-value>"' \
  -H "Content-Type: application/json" \
  -d '{"planType": "outOfNetwork"}'

# Delete Plan (cascaded delete from Redis + Elasticsearch)
curl -X DELETE http://localhost:3000/v1/plans/12xvxc345ssdsds-508 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'If-Match: "<etag-value>"'

# Health Check
curl http://localhost:3000/v1/health
```

---

## 📁 Project Structure

```
├── app.js                  # Express app configuration
├── index.js                # Server entry point
├── docker-compose.yml      # Infrastructure services
├── package.json
├── .env                    # Environment variables
├── plan-example.json       # Sample plan document
│
├── controllers/
│   ├── plansController.js  # Plan CRUD handlers
│   └── searchController.js # Search endpoints
│
├── services/
│   ├── planService.js      # Business logic, Redis operations
│   ├── elasticsearchService.js  # ES indexing with parent-child
│   └── rabbitmqService.js  # Message queue operations
│
├── workers/
│   └── indexingWorker.js   # Queue consumer for ES indexing
│
├── middleware/
│   └── authGoogle.js       # OAuth2 token verification
│
├── validators/
│   └── planValidator.js    # JSON Schema validation
│
├── schemas/
│   └── plan.schema.json    # AJV schema definition
│
├── routes/
│   ├── plans.js            # Plan routes
│   └── search.js           # Search routes
│
├── models/
│   └── redisClient.js      # Redis connection
│
└── utils/
    └── etag.js             # ETag generation (SHA-256)
```

---

## 🛠️ Tech Stack

| Category | Technology | Purpose |
|----------|------------|---------|
| **Runtime** | Node.js 18+ | JavaScript runtime |
| **Framework** | Express 5 | Web framework |
| **Database** | Redis 7 | Primary key-value storage |
| **Search** | Elasticsearch 8.11 | Parent-child indexing & search |
| **Queue** | RabbitMQ 3.12 | Async message processing |
| **Visualization** | Kibana 8.11 | Elasticsearch GUI |
| **Auth** | Google OAuth2 | ID token verification |
| **Validation** | AJV | JSON Schema validation |
| **Container** | Docker Compose | Infrastructure orchestration |

---

## Context

This project was developed for demonstrating:

1. **Distributed storage patterns** - Individual object storage vs document storage
2. **Parent-child relationships** in search indices
3. **Message queue patterns** for decoupled processing
4. **RESTful API design** with conditional operations
5. **Optimistic concurrency control** using ETags

---

## 🔧 NPM Scripts

```bash
npm run dev        # Start API server with hot reload
npm run worker     # Start queue consumer worker
npm start          # Production start
```

---

## 📝 License

MIT License - See [LICENSE](LICENSE) for details.

---

## 👤 Author

**Shubham Bagwe**  
MS in Information Systems, Northeastern University

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Connect-blue.svg)](https://linkedin.com/in/yourprofile)
[![GitHub](https://img.shields.io/badge/GitHub-Follow-black.svg)](https://github.com/yourusername)

---

*Built with ☕ and distributed systems enthusiasm*
