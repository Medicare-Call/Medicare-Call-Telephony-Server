import express, { Request, Response } from 'express';
import twilio from 'twilio';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import dotenv from 'dotenv';
import http from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import cors from 'cors';
import { handleCallConnection, getSession, closeAllConnections, createSession } from './sessionManager';
import winston from 'winston';
import { register, availableCallerNumbersGauge } from './metrics';

dotenv.config();

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.simple()),
    transports: [new winston.transports.Console()],
});

const PORT = parseInt(process.env.PORT || '8081', 10);
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID!;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;

const TWILIO_CALLER_NUMBERS = process.env.TWILIO_CALLER_NUMBERS?.split(',').map((num) => num.trim()) || [];
if (TWILIO_CALLER_NUMBERS.length === 0) {
    logger.error('TWILIO_CALLER_NUMBERS environment variable is required (comma-separated)');
    process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

if (!OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY environment variable is required');
    process.exit(1);
}

const activeCallerNumbers = new Set<string>();

function getAvailableCallerNumber(): string | null {
    for (const number of TWILIO_CALLER_NUMBERS) {
        if (!activeCallerNumbers.has(number)) {
            return number;
        }
    }
    return null;
}

function startUsingCallerNumber(number: string): void {
    activeCallerNumbers.add(number);
    logger.info(
        `발신 번호 사용 시작: ${number} (사용 중: ${activeCallerNumbers.size}/${TWILIO_CALLER_NUMBERS.length})`
    );
}

function stopUsingCallerNumber(number: string): void {
    if (activeCallerNumbers.has(number)) {
        activeCallerNumbers.delete(number);
        logger.info(
            `발신 번호 사용 종료: ${number} (사용 중: ${activeCallerNumbers.size}/${TWILIO_CALLER_NUMBERS.length})`
        );
    }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

export const callConnections = new Map<string, WebSocket>();
export const modelConnections = new Map<string, WebSocket>();
export const frontendConnections = new Map<string, WebSocket>();

export const callToCallerNumber = new Map<string, string>();

const twimlPath = join(__dirname, 'twiml.xml');
const twimlTemplate = readFileSync(twimlPath, 'utf-8');

const mainRouter = express.Router();

mainRouter.post('/twiml', (req: Request, res: Response) => {
    const callSid = req.body.CallSid;
    const elderIdParam = req.query.elderId || req.body.elderId;

    let prompt = undefined;
    let settingId = undefined;
    if (callSid) {
        prompt = (global as any).promptSessions?.get(callSid);
        settingId = (global as any).settingIdSessions?.get(callSid);
        logger.info(`CallSid로 프롬프트 가져오기 - callSid: ${callSid}, found: ${prompt ? '있음' : '없음'}`);
    }

    if (!callSid) {
        res.status(400).send('CallSid is required');
        return;
    }
    if (!elderIdParam) {
        res.status(400).send('elderId is required');
        return;
    }

    const elderId = parseInt(elderIdParam, 10);
    if (isNaN(elderId)) {
        res.status(400).send('elderId must be a valid number');
        return;
    }

    logger.info(`TwiML 요청 - CallSid: ${callSid}, elderId: ${elderId}, prompt: ${prompt ? '있음' : '없음'}`);

    const wsUrl = new URL(PUBLIC_URL);
    wsUrl.protocol = 'wss:';
    wsUrl.pathname = `/call/${callSid}/${elderId}`;
    if (settingId) {
        wsUrl.searchParams.set('settingId', settingId.toString());
    }

    const wsUrlString = wsUrl.toString().replace(/&/g, '&amp;');
    logger.info(`생성된 WebSocket URL: ${wsUrlString}`);

    const twimlContent = twimlTemplate.replace('{{WS_URL}}', wsUrlString);
    res.set('Content-Type', 'text/xml; charset=utf-8').send(twimlContent);
});

mainRouter.post('/run', async (req: Request, res: Response) => {
    try {
        const { elderId, settingId, phoneNumber, prompt } = req.body;

        logger.info(
            `/run 요청 받음 - elderId: ${elderId}, settingId: ${settingId}, phoneNumber: ${phoneNumber}, prompt: ${prompt ? '있음' : '없음'}`
        );
        if (prompt) {
            logger.info(`프롬프트 내용: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`);
        }

        if (!elderId || typeof elderId !== 'number') {
            res.status(400).json({ success: false, error: 'elderId는 숫자여야 합니다' });
            return;
        }

        const availableCallerNumber = getAvailableCallerNumber();
        if (!availableCallerNumber) {
            logger.error('모든 발신 번호가 사용 중입니다');
            res.status(503).json({
                success: false,
                error: '모든 발신 번호가 사용 중입니다. 잠시 후 다시 시도해주세요.',
                availableNumbers: TWILIO_CALLER_NUMBERS.length,
                activeCalls: activeCallerNumbers.size,
            });
            return;
        }

        const twimlUrl = new URL(`${PUBLIC_URL}/call/twiml`);
        twimlUrl.searchParams.set('elderId', elderId.toString());

        logger.info(`전화 생성 파라미터:`, {
            url: twimlUrl.toString(),
            to: phoneNumber,
            from: availableCallerNumber,
        });

        const call = await twilioClient.calls.create({
            url: twimlUrl.toString(),
            statusCallback: `${PUBLIC_URL}/call/status-callback`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallbackMethod: 'POST',
            method: 'POST',
            to: phoneNumber,
            from: availableCallerNumber,
            timeout: 50,
        });

        createSession(call.sid, {
            openAIApiKey: OPENAI_API_KEY,
            webhookUrl: WEBHOOK_URL,
            elderId,
            settingId,
            prompt,
        });

        startUsingCallerNumber(availableCallerNumber);
        callToCallerNumber.set(call.sid, availableCallerNumber);

        startUsingCallerNumber(availableCallerNumber);
        callToCallerNumber.set(call.sid, availableCallerNumber);

        logger.info(
            `전화 연결 시작 - CallSid: ${call.sid}, elderId: ${elderId}, settingId: ${settingId}, 발신번호: ${availableCallerNumber}`
        );
        res.json({
            success: true,
            sid: call.sid,
            elderId,
            settingId,
            prompt: prompt || null,
            callerNumber: availableCallerNumber,
            availableNumbers: TWILIO_CALLER_NUMBERS.length - activeCallerNumbers.size,
        });
    } catch (err) {
        logger.error('전화 실패:', err);
        res.status(500).json({ success: false, error: String(err) });
    }
});

mainRouter.post('/status-callback', (req: Request, res: Response) => {
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;

    logger.info(`상태 콜백 수신 - CallSid: ${callSid}, Status: ${callStatus}`);

    if (!callSid || !callStatus) {
        res.status(400).send('CallSid and CallStatus are required');
        return;
    }

    const session = getSession(callSid);
    if (session) {
        session.callStatus = callStatus;
        if (callStatus === 'answered') {
            session.responded = 1;
        } else if (['no-answer', 'busy', 'failed', 'canceled'].includes(callStatus)) {
            session.responded = 0;
        }
    }

    const terminalStatuses = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];

    if (terminalStatuses.includes(callStatus)) {
        const callerNumber = callToCallerNumber.get(callSid);

        if (callerNumber) {
            stopUsingCallerNumber(callerNumber);
            callToCallerNumber.delete(callSid);
            logger.info(`통화 종료 [${callStatus}] - 발신 번호 ${callerNumber} 해제 (CallSid: ${callSid})`);
        } else {
            logger.warn(`통화 종료 [${callStatus}] - CallSid ${callSid}에 매핑된 발신 번호를 찾을 수 없음`);
        }

        if (session) {
            session.endTime = new Date();
            closeAllConnections(callSid);
        }
    }

    res.status(200).send('OK');
});

// Prometheus metrics 엔드포인트
app.get('/metrics', async (req: Request, res: Response) => {
    try {
        availableCallerNumbersGauge.set(TWILIO_CALLER_NUMBERS.length - activeCallerNumbers.size);

        res.set('Content-Type', register.contentType);
        const metrics = await register.metrics();
        res.end(metrics);
    } catch (err) {
        logger.error('메트릭 수집 오류:', err);
        res.status(500).end(err);
    }
});

app.use('/call', mainRouter);

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    try {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const parts = url.pathname.split('/').filter(Boolean);

        if (parts.length < 2) {
            logger.error('WS 연결 URL이 올바르지 않습니다:', req.url);
            ws.close();
            return;
        }

        const type = parts[0];
        const sessionId = parts[1];
        const elderIdParam = parts[2];

        // This part of the code now works correctly because the prompt was saved in `/run`
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
            `WS 새 연결: type=${type}, sessionId=${sessionId}, elderId=${elderId}, prompt=${prompt ? '있음' : '없음'}`
        );

        if (type === 'call') {
            callConnections.set(sessionId, ws);

            ws.on('close', () => {
                logger.info(`WebSocket 연결 종료됨 (CallSid: ${sessionId}). 상태 콜백이 번호 해제를 처리합니다.`);
            });

            handleCallConnection(ws, OPENAI_API_KEY, WEBHOOK_URL, elderId, settingId, prompt, sessionId);
        } else if (type === 'logs') {
            frontendConnections.set(sessionId, ws);
        } else {
            logger.error(`알 수 없는 연결 type: ${type}`);
            ws.close();
        }
    } catch (err) {
        logger.error('WS connection 핸들러 오류:', err);
        ws.close();
    }
});

server.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
    logger.info(`등록된 발신 번호: ${TWILIO_CALLER_NUMBERS.join(', ')}`);
    logger.info(`총 발신 번호 개수: ${TWILIO_CALLER_NUMBERS.length}`);
});
