import { RawData, WebSocket } from 'ws';
import logger from '../config/logger';
import { getSession, closeAllConnections } from '../services/sessionManager';
import { TwilioMessage } from '../types/twilio.types';
import { parseMessage } from '../utils/websocket.utils';
import { processAudioWithVAD } from '../services/vad.service';
import { sttService, STTCallbacks } from '../services/stt';
import { LLMService, StreamCallbacks } from '../services/llmService';
import { OPENAI_API_KEY } from '../config/env';
import { elevenLabsService } from '../services/elevenlabs-tts';
import { latencyTracker } from '../services/latencyTracker';

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
    const sttCallbacks: STTCallbacks = {
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
        await sttService.startSTT(sessionId, sttCallbacks);
        logger.info(`[Modular Pipeline] STT 스트리밍 시작 완료 (CallSid: ${session.callSid})`);
    } catch (err) {
        logger.error(`[Modular Pipeline] STT 스트리밍 시작 실패 (CallSid: ${session.callSid}):`, err);
    }

    // ElevenLabs TTS 세션 시작
    try {
        await elevenLabsService.startSession(
            sessionId,
            session.twilioConn!,
            session.streamSid!
        );
        logger.info(`[Modular Pipeline] ElevenLabs TTS 세션 시작 완료 (CallSid: ${session.callSid})`);
    } catch (err) {
        logger.error(`[Modular Pipeline] ElevenLabs TTS 세션 시작 실패 (CallSid: ${session.callSid}):`, err);
    }

    // 초기 인사말 생성 및 TTS 처리
    const systemPrompt = session.prompt || '당신은 친절한 AI 어시스턴트입니다. 사용자의 질문에 간결하고 명확하게 답변해주세요.';
    const greeting = await llmService.generateInitialGreeting(systemPrompt);

    logger.info(`[Modular Pipeline] 초기 인사말 생성 완료 (CallSid: ${session.callSid}): "${greeting.substring(0, 50)}..."`);

    await sendAIResponse(sessionId, greeting);
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
    const now = Date.now();
    const recentlyPlayingTTS = session.lastAudioSentToTwilio && 
        (now - session.lastAudioSentToTwilio < 2000);
    const isTTSActive = session.isTTSPlaying || recentlyPlayingTTS;

    if (session.isSpeaking && isTTSActive && session.speechStartTimestamp > 0) {
        const speakingDuration = now - session.speechStartTimestamp;
        const hasTranscript = session.transcriptBuffer && session.transcriptBuffer.length > 0;

        if ((speakingDuration > 500 && hasTranscript) || speakingDuration > 1500) {
            handleInterrupt(sessionId);
        }
    }

    // 4. VAD가 음성을 감지한 경우 STT로 스트리밍 (실시간)
    // isSpeaking이 true이면 현재 말하는 중이므로 실시간으로 STT에 전송
    if (session.isSpeaking) {
        sttService.sendAudio(sessionId, audioChunk);
    }

    // 5. 발화가 끝났을 때 버퍼의 모든 transcript를 LLM에 전달
    if (vadResult.speechEnded) {
        latencyTracker.start(sessionId);
        latencyTracker.recordVADEnd(sessionId);
        logger.debug(`[Modular Pipeline] 발화 종료 감지 (CallSid: ${session.callSid})`);

        // 버퍼에 transcript가 있으면 LLM 처리
        if (session.transcriptBuffer && session.transcriptBuffer.length > 0) {
            const fullTranscript = session.transcriptBuffer.join(' ');
            logger.info(
                `[Modular Pipeline] 전체 발화 완료 (${session.transcriptBuffer.length}개 문장, CallSid: ${session.callSid}): "${fullTranscript}"`
            );

            // 버퍼 초기화
            session.transcriptBuffer = [];

            // LLM 처리
            handleFinalTranscript(sessionId, fullTranscript).catch(logger.error);
        } else {
            logger.debug(`[Modular Pipeline] 발화 종료되었으나 transcript 버퍼가 비어있음 (CallSid: ${session.callSid})`);
        }
    }
}

/**
 * 인터럽트 처리 - TTS 중단 및 LLM 스트리밍 중단
 */
function handleInterrupt(sessionId: string): void {
    const session = getSession(sessionId);
    if (!session) return;

    logger.info(
        `[Modular Pipeline] 인터럽트 발생 (speaking: ${Date.now() - session.speechStartTimestamp}ms, CallSid: ${session.callSid})`
    );

    // 1. 인터럽트 플래그 설정 (히스토리 저장 방지용)
    session.wasInterrupted = true;

    // 2. Twilio 버퍼 클리어
    if (session.twilioConn && session.streamSid && session.twilioConn.readyState === 1) {
        const clearMessage = {
            event: 'clear',
            streamSid: session.streamSid,
        };
        session.twilioConn.send(JSON.stringify(clearMessage));
        logger.info(`[Modular Pipeline] Twilio clear 이벤트 전송 (CallSid: ${session.callSid})`);
    }

    // 3. ElevenLabs 스트림 중단
    elevenLabsService.interruptStream(sessionId);

    // 4. LLM 스트리밍 중단
    if (session.currentLLMAbortController) {
        session.currentLLMAbortController.abort();
        session.currentLLMAbortController = undefined;
    }

    // 5. 최근 2초 이내에 저장된 AI 응답이 있으면 히스토리에서 제거 (롤백)
    const now = Date.now();
    if (session.lastAIHistorySavedAt && (now - session.lastAIHistorySavedAt < 2000)) {
        if (session.conversationHistory.length > 0) {
            const lastEntry = session.conversationHistory[session.conversationHistory.length - 1];
            if (!lastEntry.is_elderly) {
                session.conversationHistory.pop();
                logger.info(`[Modular Pipeline] 인터럽트로 인해 최근 AI 응답 히스토리에서 제거 (CallSid: ${session.callSid})`);
            }
        }
    }

    // 6. 상태 초기화
    session.isTTSPlaying = false;
    session.lastAudioSentToTwilio = undefined;
    session.pendingAIResponse = undefined;
    session.lastAIHistorySavedAt = undefined;
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

    // LLM 스트리밍 중단
    if (session.currentLLMAbortController) {
        session.currentLLMAbortController.abort();
        session.currentLLMAbortController = undefined;
    }

    // ElevenLabs TTS 세션 종료
    try {
        elevenLabsService.stopSession(sessionId);
        logger.info(`[Modular Pipeline] ElevenLabs TTS 세션 종료 완료 (CallSid: ${session.callSid})`);
    } catch (err) {
        logger.error(`[Modular Pipeline] ElevenLabs TTS 세션 종료 실패 (CallSid: ${session.callSid}):`, err);
    }

    closeAllConnections(sessionId);
}

async function handleFinalTranscript(sessionId: string, transcript: string): Promise<void> {
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

    // LLM 스트리밍 응답 처리
    await processLLMResponse(sessionId, transcript);
}

/**
 * LLM 스트리밍 응답 처리 - 토큰을 ElevenLabs로 실시간 전송
 */
async function processLLMResponse(sessionId: string, userMessage: string): Promise<void> {
    const session = getSession(sessionId);
    if (!session) return;

    try {
        // ElevenLabs 세션이 없으면 재연결
        if (!elevenLabsService.isSessionActive(sessionId)) {
            logger.info(`[Modular Pipeline] ElevenLabs 세션 재연결 (CallSid: ${session.callSid})`);
            await elevenLabsService.startSession(
                sessionId,
                session.twilioConn!,
                session.streamSid!
            );
        }

        // AbortController 생성
        const abortController = new AbortController();
        session.currentLLMAbortController = abortController;

        // 상태 초기화
        session.wasInterrupted = false;
        session.isTTSPlaying = true;
        session.pendingAIResponse = '';

        logger.debug(`[Modular Pipeline] LLM 스트리밍 시작 준비 완료 (CallSid: ${session.callSid})`);

        // ElevenLabs 콜백 설정
        elevenLabsService.prepareForNewResponse(sessionId, {
            onAudioSentToTwilio: (timestamp) => {
                session.lastAudioSentToTwilio = timestamp;
                // 첫 청크 전송 시 레이턴시 기록
                if (!session.responseStartTimestamp) {
                    session.responseStartTimestamp = timestamp;
                    latencyTracker.recordTTSFirstChunk(sessionId, session.callSid, timestamp);
                }
            },
            onStreamComplete: () => {
                // TTS 완료 시 히스토리 저장
                if (!session.wasInterrupted && session.pendingAIResponse) {
                    session.conversationHistory.push({
                        is_elderly: false,
                        conversation: session.pendingAIResponse,
                    });
                    session.lastAIHistorySavedAt = Date.now(); // 롤백용 타임스탬프
                    logger.debug(`[Modular Pipeline] AI 응답 히스토리 저장 (CallSid: ${session.callSid})`);
                } else if (session.wasInterrupted) {
                    logger.debug(`[Modular Pipeline] AI 응답 인터럽트됨 - 히스토리 스킵 (CallSid: ${session.callSid})`);
                }

                session.isTTSPlaying = false;
                session.pendingAIResponse = undefined;
                session.responseStartTimestamp = undefined;
                latencyTracker.clear(sessionId);
            }
        });

        const systemPrompt = session.prompt ||
            '당신은 친절한 AI 어시스턴트입니다. 사용자의 질문에 간결하고 명확하게 답변해주세요.';

        const history = session.conversationHistory.map(msg => ({
            role: msg.is_elderly ? 'user' as const : 'assistant' as const,
            content: msg.conversation,
        }));

        latencyTracker.recordLLMCall(sessionId, session.callSid);

        // LLM 스트리밍 콜백 설정
        const callbacks: StreamCallbacks = {
            onFirstToken: () => {
                latencyTracker.recordLLMFirstToken(sessionId, session.callSid);
            },
            onToken: (token) => {
                if (!session.wasInterrupted) {
                    elevenLabsService.sendToken(sessionId, token);
                }
            },
            onComplete: (fullResponse) => {
                session.pendingAIResponse = fullResponse;
                logger.info(`[Modular Pipeline] LLM 응답 완료 (${fullResponse.length}자, CallSid: ${session.callSid}): "${fullResponse.substring(0, 50)}..."`);

                // flush 전송하여 남은 텍스트 처리 요청
                if (!session.wasInterrupted) {
                    logger.debug(`[Modular Pipeline] ElevenLabs flush 전송 (CallSid: ${session.callSid})`);
                    elevenLabsService.flush(sessionId);
                } else {
                    logger.debug(`[Modular Pipeline] 인터럽트 상태 - flush 스킵 (CallSid: ${session.callSid})`);
                }

                session.currentLLMAbortController = undefined;
            },
            onError: (error) => {
                if (error.name === 'AbortError') {
                    logger.info(`[Modular Pipeline] LLM 스트리밍 중단됨 (CallSid: ${session.callSid})`);
                } else {
                    logger.error(`[Modular Pipeline] LLM 스트리밍 에러 (CallSid: ${session.callSid}):`, error);
                }
                session.isTTSPlaying = false;
                session.currentLLMAbortController = undefined;
            }
        };

        // LLM 스트리밍 시작
        await llmService.streamResponse(systemPrompt, userMessage, callbacks, history, abortController);

    } catch (err) {
        logger.error(`[Modular Pipeline] LLM 처리 실패 (CallSid: ${session.callSid}):`, err);
        session.isTTSPlaying = false;
        session.currentLLMAbortController = undefined;

        // 오류 발생 시 기본 응답
        await sendAIResponse(sessionId, '죄송합니다. 잠시 후 다시 말씀해주세요.');
    }
}

/**
 * AI 응답을 ElevenLabs TTS로 전송 (초기 인사말 등 단일 텍스트 전송용)
 */
async function sendAIResponse(sessionId: string, text: string): Promise<void> {
    const session = getSession(sessionId);
    if (!session) return;

    // ElevenLabs 세션이 없으면 재연결
    if (!elevenLabsService.isSessionActive(sessionId)) {
        logger.info(`[Modular Pipeline] ElevenLabs 세션 재연결 (CallSid: ${session.callSid})`);
        await elevenLabsService.startSession(
            sessionId,
            session.twilioConn!,
            session.streamSid!
        );
    }

    // 상태 초기화
    session.wasInterrupted = false;
    session.isTTSPlaying = true;
    session.pendingAIResponse = text;

    logger.debug(`[Modular Pipeline] sendAIResponse 시작 (${text.length}자, CallSid: ${session.callSid})`);

    // ElevenLabs 콜백 설정
    elevenLabsService.prepareForNewResponse(sessionId, {
        onAudioSentToTwilio: (timestamp) => {
            session.lastAudioSentToTwilio = timestamp;
            if (!session.responseStartTimestamp) {
                session.responseStartTimestamp = timestamp;
                latencyTracker.recordTTSFirstChunk(sessionId, session.callSid, timestamp);
            }
        },
        onStreamComplete: () => {
            // TTS 완료 시 히스토리 저장
            if (!session.wasInterrupted && session.pendingAIResponse) {
                session.conversationHistory.push({
                    is_elderly: false,
                    conversation: session.pendingAIResponse,
                });
                session.lastAIHistorySavedAt = Date.now(); // 롤백용 타임스탬프
                logger.info(`[Modular Pipeline] AI 응답 히스토리 저장 (CallSid: ${session.callSid})`);
            } else if (session.wasInterrupted) {
                logger.info(`[Modular Pipeline] AI 응답 인터럽트됨 - 히스토리 스킵 (CallSid: ${session.callSid})`);
            }

            session.isTTSPlaying = false;
            session.pendingAIResponse = undefined;
            session.responseStartTimestamp = undefined;
            latencyTracker.clear(sessionId);
        }
    });

    // ElevenLabs로 텍스트 전송
    elevenLabsService.sendToken(sessionId, text);
    elevenLabsService.flush(sessionId);
}
