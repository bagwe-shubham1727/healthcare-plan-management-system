
const express = require('express');
const router = express.Router();
const controller = require('../controllers/plansController');
const requireAuth = require('../middleware/authGoogle');

// Apply authentication middleware to all plan routes
router.use(requireAuth);

// POST /v1/plans
router.post('/', controller.createPlan);

// GET /v1/plans/:id
router.get('/:id', controller.getPlan);

// PATCH /v1/plans/:id (partial merge update)
router.patch('/:id', controller.patchPlan);

// DELETE /v1/plans/:id (cascaded delete)
router.delete('/:id', controller.deletePlan);

module.exports = router;
