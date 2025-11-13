import http from 'http';
import { WebSocketServer } from 'ws';
import app from './app';
import logger from './config/logger';
import { PORT, TWILIO_CALLER_NUMBERS } from './config/env';
import { handleWebSocketConnection } from './controllers/websocket.controller';

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', handleWebSocketConnection);

server.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
    logger.info(`등록된 발신 번호: ${TWILIO_CALLER_NUMBERS.join(', ')}`);
    logger.info(`총 발신 번호 개수: ${TWILIO_CALLER_NUMBERS.length}`);
});
