import { Request, Response } from 'express';
import twilio from 'twilio';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    PUBLIC_URL,
    OPENAI_API_KEY,
    WEBHOOK_URL,
    TWILIO_CALLER_NUMBERS,
} from '../config/env';
import logger from '../config/logger';
import { createSession, getSession, closeAllConnections } from '../services/sessionManager';
import {
    getAvailableCallerNumber,
    startUsingCallerNumber,
    stopUsingCallerNumber,
    callToCallerNumber,
    getActiveCallerCount,
} from '../services/callerId.service';
import { availableCallerNumbersGauge } from '../utils/metrics';
import { register } from 'prom-client';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const twimlPath = join(__dirname, '..', 'twiml.xml');
const twimlTemplate = readFileSync(twimlPath, 'utf-8');

type PipelineType = 'realtime' | 'modular';

export const runCall = async (req: Request, res: Response) => {
    try {
        const pipeline = req.params.pipeline as PipelineType;

        if (pipeline !== 'realtime' && pipeline !== 'modular') {
            res.status(400).json({ success: false, error: 'Invalid pipeline.' });
            return;
        }

        const { elderId, settingId, phoneNumber, prompt } = req.body;

        logger.info(
            `/run/${pipeline} 요청 받음 - elderId: ${elderId}, settingId: ${settingId}, phoneNumber: ${phoneNumber}, prompt: ${
                prompt ? '있음' : '없음'
            }`
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
                activeCalls: getActiveCallerCount(),
            });
            return;
        }

        const twimlUrl = new URL(`${PUBLIC_URL}/call/twiml/${pipeline}`);
        twimlUrl.searchParams.set('elderId', elderId.toString());

        logger.info(`전화 생성 파라미터 [${pipeline}]:`, {
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
            pipeline,
        });

        startUsingCallerNumber(availableCallerNumber);
        callToCallerNumber.set(call.sid, availableCallerNumber);

        logger.info(
            `전화 연결 시작 [${pipeline}] - CallSid: ${call.sid}, elderId: ${elderId}, settingId: ${settingId}, 발신번호: ${availableCallerNumber}`
        );

        res.json({
            success: true,
            sid: call.sid,
            elderId,
            settingId,
            prompt: prompt || null,
            callerNumber: availableCallerNumber,
            availableNumbers: TWILIO_CALLER_NUMBERS.length - getActiveCallerCount(),
            pipeline,
        });
    } catch (err) {
        logger.error(`전화 실패 [${req.params.pipeline}]:`, err);
        res.status(500).json({ success: false, error: String(err) });
    }
};

export const getTwiml = (req: Request, res: Response) => {
    const pipeline = req.params.pipeline as PipelineType;

    if (pipeline !== 'realtime' && pipeline !== 'modular') {
        res.status(400).send('Invalid pipeline.');
        return;
    }

    const callSid = req.body.CallSid;
    const elderIdParam = req.query.elderId || req.body.elderId;

    let prompt = undefined;
    let settingId = undefined;
    if (callSid) {
        prompt = (global as any).promptSessions?.get(callSid);
        settingId = (global as any).settingIdSessions?.get(callSid);
        logger.info(
            `CallSid로 프롬프트 가져오기 [${pipeline}] - callSid: ${callSid}, found: ${prompt ? '있음' : '없음'}`
        );
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

    logger.info(`TwiML 요청 [${pipeline}] - CallSid: ${callSid}, elderId: ${elderId}, prompt: ${prompt ? '있음' : '없음'}`);

    const wsUrl = new URL(PUBLIC_URL);
    wsUrl.protocol = 'wss:';
    wsUrl.pathname = `/call/${callSid}/${elderId}/${pipeline}`;
    if (settingId) {
        wsUrl.searchParams.set('settingId', settingId.toString());
    }

    const wsUrlString = wsUrl.toString().replace(/&/g, '&amp;');
    logger.info(`생성된 WebSocket URL [${pipeline}]: ${wsUrlString}`);

    const twimlContent = twimlTemplate.replace('{{WS_URL}}', wsUrlString);
    res.set('Content-Type', 'text/xml; charset=utf-8').send(twimlContent);
};

export const statusCallback = (req: Request, res: Response) => {
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
};

export const getMetrics = async (req: Request, res: Response) => {
    try {
        availableCallerNumbersGauge.set(TWILIO_CALLER_NUMBERS.length - getActiveCallerCount());

        res.set('Content-Type', register.contentType);
        const metrics = await register.metrics();
        res.end(metrics);
    } catch (err) {
        logger.error('메트릭 수집 오류:', err);
        res.status(500).end(err);
    }
};
