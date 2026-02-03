import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import logger from '../config/logger';
import { OPENAI_API_KEY, WEBHOOK_URL } from '../config/env';
import { handleRealtimePipelineConnection } from '../handlers/realtimePipelineHandler';
import { handleModularPipelineConnection } from '../handlers/modularPipelineHandler';

export const handleWebSocketConnection = (ws: WebSocket, req: IncomingMessage) => {
    try {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const parts = url.pathname.split('/').filter(Boolean);

        if (parts.length < 2) {
            logger.error('WS 연결 URL이 올바르지 않습니다:', req.url);
            ws.close();
            return;
        }

        const type = parts[0];

        // Call Handling 엔드포인트: /call/{sessionId}/{elderId}/{pipeline}
        if (type === 'call') {
            if (parts.length < 4) {
                logger.error('WS 연결 URL이 올바르지 않습니다:', req.url);
                ws.close();
                return;
            }

            const sessionId = parts[1];
            const elderIdParam = parts[2];
            const pipeline = parts[3];

            if (pipeline !== 'realtime' && pipeline !== 'modular') {
                logger.error(`유효하지 않은 pipeline: ${pipeline}`);
                ws.close();
                return;
            }

            let prompt = undefined;
            if (sessionId) {
                prompt = (global as any).promptSessions?.get(sessionId);
                if (prompt) {
                    (global as any).promptSessions.delete(sessionId);
                    logger.info(`CallSid로 프롬프트 가져옴 - callSid: ${sessionId}, prompt 길이: ${prompt.length}`);
                } else {
                    logger.info(`CallSid로 프롬프트를 찾을 수 없음 - callSid: ${sessionId}`);
                }
            }

            const settingIdParam = url.searchParams.get('settingId');
            const settingId = settingIdParam ? parseInt(settingIdParam, 10) : undefined;

            if (!elderIdParam) {
                logger.error(`elderId가 없습니다. sessionId: ${sessionId}`);
                ws.close();
                return;
            }

            const elderId = parseInt(elderIdParam, 10);
            if (isNaN(elderId)) {
                logger.error(`elderId가 유효한 숫자가 아닙니다. sessionId: ${sessionId}, elderId: ${elderIdParam}`);
                ws.close();
                return;
            }

            logger.info(
                `WS 새 연결: pipeline=${pipeline}, sessionId=${sessionId}, elderId=${elderId}, prompt=${prompt ? '있음' : '없음'}`
            );

            ws.on('close', () => {
                logger.info(`WebSocket 연결 종료됨 (CallSid: ${sessionId}). 상태 콜백이 번호 해제를 처리합니다.`);
            });

            if (pipeline === 'modular') {
                handleModularPipelineConnection(ws, OPENAI_API_KEY, WEBHOOK_URL, elderId, settingId, prompt, sessionId);
            } else {
                handleRealtimePipelineConnection(ws, OPENAI_API_KEY, WEBHOOK_URL, elderId, settingId, prompt, sessionId);
            }
        } else {
            logger.error(`알 수 없는 연결 type: ${type}`);
            ws.close();
        }
    } catch (err) {
        logger.error('WS connection 핸들러 오류:', err);
        ws.close();
    }
};
