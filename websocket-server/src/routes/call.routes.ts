import express from 'express';
import { getTwiml, runCall, statusCallback, getMetrics } from '../controllers/call.controller';

const router = express.Router();

router.post('/twiml', getTwiml);
router.post('/run', runCall);
router.post('/status-callback', statusCallback);
router.get('/metrics', getMetrics);

export default router;
