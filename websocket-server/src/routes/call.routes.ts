import express from 'express';
import { getTwiml, runCall, statusCallback, getMetrics } from '../controllers/call.controller';

const router = express.Router();

router.post('/twiml/:pipeline', getTwiml);
router.post('/run/:pipeline', runCall);
router.post('/status-callback', statusCallback);
router.get('/metrics', getMetrics);

export default router;
