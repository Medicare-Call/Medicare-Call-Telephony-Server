import { RawData, WebSocket } from 'ws';
import logger from '../config/logger';
import { getSession, closeAllConnections } from '../services/sessionManager';
import { TwilioMessage } from '../types/twilio.types';
import { parseMessage } from '../utils/websocket.utils';
import { processAudioWithVAD } from '../services/vad.service';
import { sttService, STTCallbacks } from '../services/stt';
import { LLMService } from '../services/llmService';
import { OPENAI_API_KEY } from '../config/env';
import { ttsStreamer } from '../services/tts';

// LLM 서비스 인스턴스
const llmService = new LLMService(OPENAI_API_KEY);

export function handleModularPipelineConnection(
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
            `[Modular Pipeline] WebSocket 연결 시 세션을 찾을 수 없습니다: ${sessionId}. 통화가 먼저 생성되어야 합니다.`
        );
        ws.close();
        return sessionId;
    }

    session.twilioConn = ws;

    ws.on('message', (data) => handleTwilioMessage(sessionId, data).catch(logger.error));
    ws.on('error', (err) => {
        logger.error(`[Modular Pipeline] WebSocket 에러 (CallSid: ${sessionId}):`, err);
        ws.close();
    });
    ws.on('close', () => {
        logger.info(`[Modular Pipeline] WebSocket 연결 종료 (CallSid: ${sessionId})`);
        closeAllConnections(sessionId);
    });

    logger.info(`[Modular Pipeline] WebSocket 연결 완료 - CallSid: ${sessionId}`);
    return sessionId;
}

async function handleTwilioMessage(sessionId: string, data: RawData): Promise<void> {
    const session = getSession(sessionId);
    if (!session) return;

    const msg = parseMessage(data);
    if (!msg) return;

    if (msg.event !== 'media') {
        // logger.info(`[Modular Pipeline] Twilio 메시지: ${msg.event} (CallSid: ${session.callSid})`);
    }

    switch (msg.event) {
        case 'start':
            await handleStreamStart(sessionId, msg);
            break;

        case 'media':
            await handleMediaMessage(sessionId, msg);
            break;

        case 'stop':
        case 'close':
            await handleStreamStop(sessionId);
            break;
    }
}

async function handleStreamStart(sessionId: string, msg: TwilioMessage): Promise<void> {
    const session = getSession(sessionId);
    if (!session || !msg.start) return;

    logger.info(`[Modular Pipeline] 통화 시작 (CallSid: ${session.callSid}), streamSid: ${msg.start.streamSid}`);
    session.streamSid = msg.start.streamSid;
    session.latestMediaTimestamp = 0;
    session.lastAssistantItem = undefined;
    session.responseStartTimestamp = undefined;
    session.transcriptBuffer = []; // transcript 버퍼 초기화

    // STT 콜백 설정
    const callbacks: STTCallbacks = {
        onTranscript: (text: string, isFinal: boolean) => {
            if (isFinal) {
                logger.info(`[Modular Pipeline] STT 최종 결과 - 버퍼에 저장 (CallSid: ${session.callSid}): "${text}"`);
                if (!session.transcriptBuffer) {
                    session.transcriptBuffer = [];
                }
                session.transcriptBuffer.push(text);
            } else {
                logger.debug(`[Modular Pipeline] STT 중간 결과 (CallSid: ${session.callSid}): "${text}"`);
            }
        },
        onError: (error: Error) => {
            logger.error(`[Modular Pipeline] STT 에러 (CallSid: ${session.callSid}):`, error);
        },
        onClose: () => {
            logger.info(`[Modular Pipeline] STT 연결 종료 (CallSid: ${session.callSid})`);
        },
    };

    // STT 스트리밍 시작
    try {
        await sttService.startSTT(sessionId, callbacks);
        logger.info(`[Modular Pipeline] STT 스트리밍 시작 완료 (CallSid: ${session.callSid})`);
    } catch (err) {
        logger.error(`[Modular Pipeline] STT 스트리밍 시작 실패 (CallSid: ${session.callSid}):`, err);
    }

    // 초기 인사말 생성
    const systemPrompt = session.prompt || '당신은 친절한 AI 어시스턴트입니다. 사용자의 질문에 간결하고 명확하게 답변해주세요.';
    const greeting = await llmService.generateInitialGreeting(systemPrompt);

    logger.info(`[Modular Pipeline] 초기 인사말 생성 완료 (CallSid: ${session.callSid}): "${greeting.substring(0, 50)}..."`);

    // TTS 처리
    const ttsResult = await sendTTSResponse(sessionId, greeting);

    // TTS가 성공적으로 완료되었을 때만 대화 히스토리에 추가
    if (ttsResult && ttsResult.success) {
        session.conversationHistory.push({
            is_elderly: false,
            conversation: greeting,
        });
        logger.info(`[Modular Pipeline] 초기 인사말을 히스토리에 저장 (CallSid: ${session.callSid})`);
    }
}

async function handleMediaMessage(sessionId: string, msg: TwilioMessage): Promise<void> {
    const session = getSession(sessionId);
    if (!session || !msg.media) return;

    session.latestMediaTimestamp = parseInt(msg.media.timestamp);

    const audioChunk = Buffer.from(msg.media.payload, 'base64');

    // 1. 전체 통화 녹음용 버퍼
    session.audioBuffer.push(audioChunk);

    // 2. VAD 처리
    const vadResult = await processAudioWithVAD(session, audioChunk, session.callSid);

    // 3. 사용자 발화 감지 시 TTS 중단
    if (session.isSpeaking && session.isTTSPlaying && session.speechStartTimestamp > 0) {
        const now = Date.now();
        const speakingDuration = now - session.speechStartTimestamp;

        // TTS 중단 조건:
        // 1. 500ms 이상 발화
        // 2. transcriptBuffer에 뭔가 있음 (STT가 인식한 의미 있는 발화)
        const hasTranscript = session.transcriptBuffer && session.transcriptBuffer.length > 0;

        if (speakingDuration > 500 && hasTranscript) {
            logger.info(
                `[Modular Pipeline] 사용자 발화 감지 (speaking: ${speakingDuration}ms, transcript 개수: ${session.transcriptBuffer?.length || 0}) - TTS 중단 (CallSid: ${session.callSid})`
            );

            // Twilio 버퍼 클리어
            ttsStreamer.clearTwilioStream(session.twilioConn!, session.streamSid!);

            // 진행 중인 스트리밍 중단
            ttsStreamer.abortCurrentStream();

            // 플래그 초기화
            session.isTTSPlaying = false;
        }
    }

    // 4. VAD가 음성을 감지한 경우 STT로 스트리밍 (실시간)
    // isSpeaking이 true이면 현재 말하는 중이므로 실시간으로 STT에 전송
    if (session.isSpeaking) {
        sttService.sendAudio(sessionId, audioChunk);
    }

    // 5. 발화가 끝났을 때 버퍼의 모든 transcript를 LLM에 전달
    if (vadResult.speechEnded) {
        // 레이턴시 측정: VAD 발화 종료 시점을 로컬 변수로 저장 (세션에 저장 시 다음 발화에 의해 덮어씌워짐)
        const vadEndTimestamp = Date.now();
        logger.info(`[Modular Pipeline] 발화 종료 감지 (CallSid: ${session.callSid})`);

        // 버퍼에 transcript가 있으면 LLM 처리
        if (session.transcriptBuffer && session.transcriptBuffer.length > 0) {
            const fullTranscript = session.transcriptBuffer.join(' ');
            logger.info(
                `[Modular Pipeline] 전체 발화 완료 (${session.transcriptBuffer.length}개 문장, CallSid: ${session.callSid}): "${fullTranscript}"`
            );

            // 버퍼 초기화
            session.transcriptBuffer = [];

            // LLM 처리 - VAD 종료 시점을 파라미터로 함께 전달
            handleFinalTranscript(sessionId, fullTranscript, vadEndTimestamp).catch(logger.error);
        } else {
            logger.warn(`[Modular Pipeline] 발화 종료되었으나 transcript 버퍼가 비어있음 (CallSid: ${session.callSid})`);
        }
    }
}

async function handleStreamStop(sessionId: string): Promise<void> {
    const session = getSession(sessionId);
    if (!session) return;

    logger.info(`[Modular Pipeline] 통화 종료 신호 수신 (CallSid: ${session.callSid})`);

    // STT 스트리밍 종료
    try {
        sttService.stopSTT(sessionId);
        logger.info(`[Modular Pipeline] STT 스트리밍 종료 완료 (CallSid: ${session.callSid})`);
    } catch (err) {
        logger.error(`[Modular Pipeline] STT 스트리밍 종료 실패 (CallSid: ${session.callSid}):`, err);
    }

    closeAllConnections(sessionId);
}

async function handleFinalTranscript(sessionId: string, transcript: string, vadEndTimestamp: number): Promise<void> {
    const session = getSession(sessionId);
    if (!session) return;

    if (!transcript || transcript.trim().length === 0) {
        logger.warn(`[Modular Pipeline] 빈 transcription, 건너뜀 (CallSid: ${session.callSid})`);
        return;
    }

    // 대화 히스토리에 추가
    session.conversationHistory.push({
        is_elderly: true,
        conversation: transcript,
    });

    // LLM 처리 - VAD 종료 시점 전달
    await processLLMResponse(sessionId, transcript, vadEndTimestamp);
}

async function processLLMResponse(sessionId: string, userMessage: string, vadEndTimestamp: number): Promise<void> {
    const session = getSession(sessionId);
    if (!session) return;

    try {
        logger.info(`[Modular Pipeline] LLM 처리 시작 (CallSid: ${session.callSid})`);
        const startTime = Date.now();

        // session에 저장된 시스템 프롬프트 항상 첨부
        const systemPrompt = session.prompt ||
            '당신은 친절한 AI 어시스턴트입니다. 사용자의 질문에 간결하고 명확하게 답변해주세요.';

        // 대화 히스토리를 LLMService 형식으로 변환
        const history = session.conversationHistory.map(msg => ({
            role: msg.is_elderly ? 'user' as const : 'assistant' as const,
            content: msg.conversation,
        }));

        // LLM 응답 생성
        const llmResponse = await llmService.generateResponse(systemPrompt, userMessage, history);

        const llmLatency = Date.now() - startTime;
        logger.info(`[Modular Pipeline] LLM 완료 (${llmLatency}ms, CallSid: ${session.callSid}): "${llmResponse.substring(0, 100)}..."`);

        // TTS 처리 - VAD 종료 시점 전달
        const ttsResult = await sendTTSResponse(sessionId, llmResponse, vadEndTimestamp);

        // TTS가 성공적으로 완료되었을 때만 대화 히스토리에 추가
        if (ttsResult && ttsResult.success) {
            session.conversationHistory.push({
                is_elderly: false,
                conversation: llmResponse,
            });
            logger.info(`[Modular Pipeline] AI 응답을 히스토리에 저장 (CallSid: ${session.callSid})`);
        } else {
            logger.warn(`[Modular Pipeline] TTS 중단됨 - 히스토리에 저장하지 않음 (CallSid: ${session.callSid})`);
        }
    } catch (err) {
        logger.error(`[Modular Pipeline] LLM 처리 실패 (CallSid: ${session.callSid}):`, err);
        // 오류 발생 시 기본 응답
        await sendTTSResponse(sessionId, '죄송합니다. 잠시 후 다시 말씀해주세요.');
    }
}

async function sendTTSResponse(sessionId: string, text: string, vadEndTimestamp?: number): Promise<{ success: boolean } | undefined> {
    const session = getSession(sessionId);
    if (!session || !session.twilioConn || !session.streamSid) return undefined;

    try {
        // 이전 TTS가 재생 중이면 중단 (Interrupt)
        if (session.isTTSPlaying) {
            logger.info(`[Modular Pipeline] 이전 TTS 재생 중단 (CallSid: ${session.callSid})`);

            // 1. Twilio 버퍼 클리어
            ttsStreamer.clearTwilioStream(session.twilioConn, session.streamSid);

            // 2. 진행 중인 스트리밍 중단
            ttsStreamer.abortCurrentStream();

            // 짧은 대기 시간을 두어 이전 스트리밍이 완전히 중단되도록 함
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        session.isTTSPlaying = true;

        logger.info(`[Modular Pipeline] TTS 처리 시작 (CallSid: ${session.callSid}): "${text.substring(0, 50)}..."`);

        // TTSStreamer를 사용하여 텍스트를 TTS로 변환하고 Twilio로 스트리밍
        const result = await ttsStreamer.streamTextToTwilio(text, {
            streamSid: session.streamSid,
            twilioConn: session.twilioConn,
            chunkSize: 160,        // 20ms per chunk for 8kHz ulaw
            chunkIntervalMs: 20,   // 20ms 간격으로 청크 전송
        });

        if (result.success) {
            logger.info(
                `[Modular Pipeline] TTS 완료 (${result.durationMs}ms, ${result.totalChunks} chunks, ${result.totalBytes} bytes, CallSid: ${session.callSid})`
            );
        } else {
            logger.error(`[Modular Pipeline] TTS 스트리밍 실패 (CallSid: ${session.callSid}): ${result.error}`);
        }

        return result;
    } catch (err) {
        logger.error(`[Modular Pipeline] TTS 처리 실패 (CallSid: ${session.callSid}):`, err);
        return { success: false };
    } finally {
        session.isTTSPlaying = false;
    }
}
