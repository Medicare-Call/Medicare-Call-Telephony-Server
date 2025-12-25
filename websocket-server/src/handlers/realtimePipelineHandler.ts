import { RawData, WebSocket } from 'ws';
import logger from '../config/logger';
import { getSession, closeAllConnections } from '../services/sessionManager';
import { parseMessage, jsonSend, isOpen } from '../utils/websocket.utils';
import { TwilioMessage } from '../types/twilio.types';

export function handleRealtimePipelineConnection(
    ws: WebSocket,
    openAIApiKey: string,
    webhookUrl?: string,
    elderId?: number,
    settingId?: number,
    prompt?: string,
    callSid?: string
): string {
    const sessionId = callSid || `fallback_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    const session = getSession(sessionId);
    if (!session) {
        logger.error(
            `[Realtime Pipeline] WebSocket 연결 시 세션을 찾을 수 없습니다: ${sessionId}. 통화가 먼저 생성되어야 합니다.`
        );
        ws.close();
        return sessionId;
    }

    // 기존 세션에 WebSocket 연결 추가
    session.twilioConn = ws;

    ws.on('message', (data) => handleTwilioMessage(sessionId, data).catch(logger.error));
    ws.on('error', (err) => {
        logger.error(`[Realtime Pipeline] WebSocket 에러 (CallSid: ${sessionId}):`, err);
        ws.close();
    });
    ws.on('close', () => {
        logger.info(`[Realtime Pipeline] WebSocket 연결 종료 (CallSid: ${sessionId})`);
        closeAllConnections(sessionId);
    });

    logger.info(`[Realtime Pipeline] WebSocket 연결 완료 - CallSid: ${sessionId}`);
    return sessionId;
}

async function handleTwilioMessage(sessionId: string, data: RawData): Promise<void> {
    const session = getSession(sessionId);
    if (!session) return;

    const msg = parseMessage(data) as TwilioMessage | null;
    if (!msg) return;

    // media 이벤트가 아닌 경우만 로그 출력
    if (msg.event !== 'media') {
        logger.info(`[Realtime Pipeline] Twilio 메시지: ${msg.event} (CallSid: ${session.callSid})`);
    }

    switch (msg.event) {
        case 'start':
            logger.info(
                `[Realtime Pipeline] 통화 시작 (CallSid: ${session.callSid}), streamSid: ${msg.start?.streamSid}`
            );
            session.streamSid = msg.start?.streamSid;
            session.latestMediaTimestamp = 0;
            session.lastAssistantItem = undefined;
            session.responseStartTimestamp = undefined;

            // OpenAI 연결 시도
            connectToOpenAI(sessionId);
            break;

        case 'media':
            if (!msg.media) break;

            session.latestMediaTimestamp = parseInt(msg.media.timestamp);

            const audioChunk = Buffer.from(msg.media.payload, 'base64');

            // 전체 통화 녹음용 버퍼에 저장
            session.audioBuffer.push(audioChunk);

            // GPT Realtime API로 모든 오디오 전송
            if (isOpen(session.modelConn)) {
                jsonSend(session.modelConn, {
                    type: 'input_audio_buffer.append',
                    audio: msg.media.payload,
                });
            }
            break;

        case 'stop':
        case 'close':
            logger.info(`[Realtime Pipeline] 통화 종료 신호 수신 (CallSid: ${session.callSid})`);
            closeAllConnections(sessionId);
            break;
    }
}

function connectToOpenAI(sessionId: string): void {
    const session = getSession(sessionId);
    if (!session || !session.twilioConn || !session.streamSid || !session.openAIApiKey) {
        return;
    }

    if (isOpen(session.modelConn)) return; // 이미 연결됨

    logger.info(`[Realtime Pipeline] OpenAI 연결 중... (CallSid: ${session.callSid})`);

    session.modelConn = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
        headers: {
            Authorization: `Bearer ${session.openAIApiKey}`,
            'OpenAI-Beta': 'realtime=v1',
        },
    });

    session.modelConn.on('open', () => {
        logger.info(`[Realtime Pipeline] OpenAI 연결 완료 (CallSid: ${session.callSid})`);

        // 세션 설정
        const sessionConfig = {
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.85,
                    prefix_padding_ms: 1200,
                    silence_duration_ms: 700,
                },
                voice: 'alloy',
                input_audio_transcription: { model: 'whisper-1' },
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                input_audio_noise_reduction: { type: 'near_field' },
            },
        };

        jsonSend(session.modelConn, sessionConfig);

        // 프롬프트 전송
        if (session.prompt) {
            sendUserMessageToAI(sessionId, session.prompt);
        }
    });

    session.modelConn.on('message', (data) => {
        handleOpenAIMessage(sessionId, data);
    });
    session.modelConn.on('error', (error) => {
        logger.error(`[Realtime Pipeline] OpenAI 연결 오류 (CallSid: ${session.callSid}):`, error);
    });
    session.modelConn.on('close', () => {
        logger.info(`[Realtime Pipeline] OpenAI 연결 종료 (CallSid: ${session.callSid})`);
    });
}

export function sendUserMessageToAI(sessionId: string, text: string): void {
    const session = getSession(sessionId);
    if (!session || !isOpen(session.modelConn)) return;

    logger.info(`[Realtime Pipeline] 사용자 메시지: ${text}`);

    const userMessage = {
        type: 'conversation.item.create',
        item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
        },
    };

    jsonSend(session.modelConn, userMessage);
    jsonSend(session.modelConn, { type: 'response.create' });
}

function handleOpenAIMessage(sessionId: string, data: RawData): void {
    const session = getSession(sessionId);
    if (!session) return;

    const event = parseMessage(data);
    if (!event) return;

    switch (event.type) {
        case 'input_audio_buffer.speech_started':
            // 사용자 말하기 시작 - AI 응답 중단
            handleTruncation(sessionId);
            break;

        case 'response.audio.delta':
            // AI 음성 응답을 Twilio로 전달
            if (session.twilioConn && session.streamSid) {
                if (session.responseStartTimestamp === undefined) {
                    session.responseStartTimestamp = session.latestMediaTimestamp || 0;
                }
                if (event.item_id) session.lastAssistantItem = event.item_id;

                const aiAudioChunk = Buffer.from(event.delta, 'base64');
                session.audioBuffer.push(aiAudioChunk);

                jsonSend(session.twilioConn, {
                    event: 'media',
                    streamSid: session.streamSid,
                    media: { payload: event.delta },
                });

                jsonSend(session.twilioConn, {
                    event: 'mark',
                    streamSid: session.streamSid,
                });
            }
            break;

        case 'response.output_item.done':
            // AI 응답 완료 - 텍스트 저장
            const { item } = event;

            if (item.type === 'message' && item.role === 'assistant') {
                const content = item.content;

                if (content && Array.isArray(content)) {
                    for (const contentItem of content) {
                        let aiResponse = null;
                        if (contentItem.type === 'text' && contentItem.text) {
                            aiResponse = contentItem.text;
                        } else if (contentItem.type === 'audio' && contentItem.transcript) {
                            aiResponse = contentItem.transcript;
                        }

                        if (aiResponse) {
                            logger.info(`[Realtime Pipeline] AI 응답: ${aiResponse}`);
                            session.conversationHistory.push({
                                is_elderly: false,
                                conversation: aiResponse,
                            });
                        }
                    }
                }
            }
            break;

        case 'conversation.item.input_audio_transcription.completed':
            // 사용자 음성 인식 완료 - 텍스트 저장
            if (event.transcript) {
                logger.info(`[Realtime Pipeline] 사용자 발화: ${event.transcript}`);
                session.conversationHistory.push({
                    is_elderly: true,
                    conversation: event.transcript,
                });
            }
            break;
    }
}

function handleTruncation(sessionId: string): void {
    const session = getSession(sessionId);
    if (!session || !session.lastAssistantItem || session.responseStartTimestamp === undefined) {
        return;
    }

    const elapsedMs = (session.latestMediaTimestamp || 0) - (session.responseStartTimestamp || 0);
    const audio_end_ms = elapsedMs > 0 ? elapsedMs : 0;

    // OpenAI에 중단 명령
    if (isOpen(session.modelConn)) {
        jsonSend(session.modelConn, {
            type: 'conversation.item.truncate',
            item_id: session.lastAssistantItem,
            content_index: 0,
            audio_end_ms,
        });
    }

    // Twilio 스트림 클리어
    if (session.twilioConn && session.streamSid) {
        jsonSend(session.twilioConn, {
            event: 'clear',
            streamSid: session.streamSid,
        });
    }

    session.lastAssistantItem = undefined;
    session.responseStartTimestamp = undefined;
}
