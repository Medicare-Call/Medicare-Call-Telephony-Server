import WebSocket from 'ws';
import logger from '../../config/logger';
import { ElevenLabsConfig, defaultConfig, buildWebSocketUrl } from './elevenlabs.config';
import { ElevenLabsSession, ElevenLabsInputMessage, ElevenLabsOutputMessage, ElevenLabsStreamResult, ElevenLabsCallbacks } from './elevenlabs.types';

export class ElevenLabsService {
    private config: ElevenLabsConfig;
    private sessions: Map<string, ElevenLabsSession> = new Map();

    constructor(config?: Partial<ElevenLabsConfig>) {
        this.config = { ...defaultConfig, ...config };

        logger.info('[ElevenLabs] 서비스 초기화', {
            voiceId: this.config.voiceId,
            modelId: this.config.modelId,
            outputFormat: this.config.outputFormat,
        });
    }

    /**
     * 통화 시작 시 ElevenLabs WebSocket 연결 생성
     * 통화당 웹소켓 연결 1개 유지
     * @param {string} sessionId - 세션 ID (callSid)
     * @param {WebSocket} twilioConn - Twilio WebSocket 연결
     * @param {string} streamSid - Twilio 스트림 ID
     * @returns {Promise<void>}
     * @throws {Error} WebSocket 연결 실패 또는 타임아웃 시
     */
    async startSession(
        sessionId: string,
        twilioConn: WebSocket,
        streamSid: string
    ): Promise<void> {
        const existingSession = this.sessions.get(sessionId);
        if (existingSession) {
            if (existingSession.isActive && existingSession.ws.readyState === WebSocket.OPEN) {
                logger.warn(`[ElevenLabs] 활성 세션이 이미 존재, 재사용: ${sessionId}`);
                return;
            }

            logger.debug(`[ElevenLabs] 비활성 세션 정리 후 새로 생성: ${sessionId}`);
            if (existingSession.ws.readyState === WebSocket.OPEN) {
                existingSession.ws.close();
            }
            this.sessions.delete(sessionId);
        }

        const wsUrl = buildWebSocketUrl(this.config);
        const ws = new WebSocket(wsUrl);

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('ElevenLabs WebSocket 연결 타임아웃'));
            }, 10000);

            ws.on('open', () => {
                clearTimeout(timeout);

                // BOS (Beginning of Stream) 메시지 전송
                const initMessage: ElevenLabsInputMessage = {
                    text: ' ',
                    voice_settings: {
                        stability: this.config.stability || 0.5,
                        similarity_boost: this.config.similarityBoost || 0.75,
                        speed: this.config.speed || 0.8,
                    },
                    chunk_length_schedule: [50, 100, 150, 200],
                    xi_api_key: this.config.apiKey,
                };
                ws.send(JSON.stringify(initMessage));
                logger.info(`[ElevenLabs] WebSocket 연결 완료: ${sessionId}`);
                resolve();
            });

            ws.on('error', (error) => {
                clearTimeout(timeout);
                logger.error(`[ElevenLabs] 연결 실패: ${sessionId}`, error);
                reject(error);
            });
        });

        const session: ElevenLabsSession = {
            ws,
            isActive: true,
            isMuted: false,
            twilioConn,
            streamSid,
            buffer: Buffer.alloc(0),
            totalChunks: 0,
            totalBytes: 0,
            isFlushing: false,
        };

        // 오디오 청크 수신 시 즉시 Twilio로 전송
        ws.on('message', (data: WebSocket.Data) => {
            this.handleAudioChunk(sessionId, data);
        });

        ws.on('close', () => {
            logger.debug(`[ElevenLabs] 연결 종료: ${sessionId}`);
            const closingSession = this.sessions.get(sessionId);
            if (closingSession) {
                closingSession.isActive = false;
                this.sessions.delete(sessionId);
            }
        });

        ws.on('error', (error) => {
            logger.error(`[ElevenLabs] WebSocket 에러: ${sessionId}`, error);
        });

        this.sessions.set(sessionId, session);
    }

    /**
     * 새 응답 시작 전 상태 초기화 및 콜백 등록
     * LLM 응답 시작 전에 호출해야 함
     * @param {string} sessionId - 세션 ID
     * @param {ElevenLabsCallbacks} callbacks - TTS 콜백
     */
    prepareForNewResponse(sessionId: string, callbacks?: ElevenLabsCallbacks): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        session.isMuted = false;
        session.isFlushing = false;
        session.firstChunkTimestamp = undefined;
        session.buffer = Buffer.alloc(0);
        session.callbacks = callbacks;
        if (session.flushCompletionTimer) {
            clearTimeout(session.flushCompletionTimer);
            session.flushCompletionTimer = undefined;
        }

        logger.debug(`[ElevenLabs] 새 응답 준비 완료: ${sessionId}`);
    }

    /**
     * LLM 토큰을 즉시 ElevenLabs로 전송
     * llmService의 onToken 콜백에서 호출됨
     * @param {string} sessionId - 세션 ID
     * @param {string} token - LLM에서 생성된 토큰
     */
    sendToken(sessionId: string, token: string): void {
        const session = this.sessions.get(sessionId);
        if (!session || !session.isActive) {
            logger.warn(`[ElevenLabs] sendToken 실패 - 세션 없음 또는 비활성: ${sessionId}`);
            return;
        }

        if (session.ws.readyState === WebSocket.OPEN) {
            const message: ElevenLabsInputMessage = { text: token, try_trigger_generation: true };
            session.ws.send(JSON.stringify(message));
            logger.debug(`[ElevenLabs] 토큰 전송 (${token.length}자): ${sessionId}`);
        } else {
            logger.warn(`[ElevenLabs] sendToken 실패 - WebSocket 닫힘 (state: ${session.ws.readyState}): ${sessionId}`);
        }
    }

    /**
     * LLM 응답 완료 시 flush 신호 전송
     * ElevenLabs에 남은 텍스트 처리 완료 요청
     * @param {string} sessionId - 세션 ID
     */
    flush(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session || !session.isActive) {
            logger.warn(`[ElevenLabs] flush 실패 - 세션 없음 또는 비활성: ${sessionId}`);
            return;
        }

        if (session.ws.readyState === WebSocket.OPEN) {
            const message: ElevenLabsInputMessage = { text: '', flush: true };
            session.ws.send(JSON.stringify(message));
            session.isFlushing = true;

            // flush 이후 500ms 동안 오디오 청크가 없으면 완료로 판단
            this.startFlushCompletionTimer(sessionId);

            logger.debug(`[ElevenLabs] Flush 전송: ${sessionId}`);
        } else {
            logger.warn(`[ElevenLabs] Flush 실패 - WebSocket 닫힘 (state: ${session.ws.readyState}): ${sessionId}`);
        }
    }

    /**
     * ElevenLabs에서 오디오 청크 수신 시 처리
     * 160 bytes 단위로 분할하여 Twilio로 즉시 전송
     * @param {string} sessionId - 세션 ID
     * @param {WebSocket.Data} data - ElevenLabs에서 수신한 데이터
     */
    private handleAudioChunk(sessionId: string, data: WebSocket.Data): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        // 인터럽트 상태면 오디오 무시 (Twilio clear가 이미 전송된 오디오 처리)
        if (session.isMuted) {
            return;
        }

        try {
            const response: ElevenLabsOutputMessage = JSON.parse(data.toString());

            if (response.error) {
                logger.error(`[ElevenLabs] 에러 응답: ${response.error}`);
                return;
            }

            if (!response.audio) {
                return;
            }

            // flush 중이면 오디오 수신할 때마다 타이머 리셋
            if (session.isFlushing) {
                this.startFlushCompletionTimer(sessionId);
            }

            // 첫 청크 타임스탬프 기록
            if (!session.firstChunkTimestamp) {
                session.firstChunkTimestamp = Date.now();
                logger.debug(`[ElevenLabs] 첫 오디오 청크 수신: ${sessionId}`);
            }

            // base64 디코딩
            const audioChunk = Buffer.from(response.audio, 'base64');

            // 버퍼에 추가
            session.buffer = Buffer.concat([session.buffer, audioChunk]);

            // 160 bytes 단위 Twilio 전송
            while (session.buffer.length >= 160) {
                // 전송 중에도 지속적으로 인터럽트 체크
                if (session.isMuted) {
                    session.buffer = Buffer.alloc(0);
                    return;
                }

                const chunk = session.buffer.subarray(0, 160);
                session.buffer = session.buffer.subarray(160);

                this.sendToTwilio(session, chunk);
                session.totalChunks++;
                session.totalBytes += 160;
            }

        } catch (error) {
            logger.error(`[ElevenLabs] 청크 처리 실패:`, error);
        }
    }

    /**
     * flush 완료 타이머 시작/리셋
     * 500ms 동안 오디오 청크가 없으면 onStreamComplete 호출
     */
    private startFlushCompletionTimer(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        if (session.flushCompletionTimer) {
            clearTimeout(session.flushCompletionTimer);
        }

        session.flushCompletionTimer = setTimeout(() => {
            session.isFlushing = false;
            session.flushCompletionTimer = undefined;

            this.flushRemainingBuffer(sessionId);

            if (session.callbacks?.onStreamComplete) {
                logger.debug(`[ElevenLabs] Flush 완료 (타이머): ${sessionId}`);
                session.callbacks.onStreamComplete();
            }
        }, 500);
    }

    /**
     * 남은 버퍼 강제 전송
     * @param {string} sessionId - 세션 ID
     */
    private flushRemainingBuffer(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session || session.buffer.length === 0 || session.isMuted) return;

        // 남은 버퍼가 있으면 패딩 후 전송
        const padded = Buffer.alloc(160, 0xff);  // ulaw silence
        session.buffer.copy(padded);
        this.sendToTwilio(session, padded);
        session.buffer = Buffer.alloc(0);
    }

    /**
     * Twilio로 오디오 청크 전송
     * @param {ElevenLabsSession} session - ElevenLabs 세션
     * @param {Buffer} chunk - 160 bytes ulaw 오디오 청크
     */
    private sendToTwilio(session: ElevenLabsSession, chunk: Buffer): void {
        if (session.twilioConn.readyState !== WebSocket.OPEN) {
            return;
        }

        const payload = chunk.toString('base64');
        const message = {
            event: 'media',
            streamSid: session.streamSid,
            media: { payload },
        };

        session.twilioConn.send(JSON.stringify(message));

        // 오디오 전송 시간 콜백 호출 (인터럽트 판단용)
        if (session.callbacks?.onAudioSentToTwilio) {
            session.callbacks.onAudioSentToTwilio(Date.now());
        }
    }

    /**
     * Twilio 버퍼 클리어 (사용자 인터럽트 시)
     * @param {string} sessionId - 세션 ID
     */
    clearTwilioStream(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        if (session.twilioConn.readyState === WebSocket.OPEN) {
            const message = {
                event: 'clear',
                streamSid: session.streamSid,
            };
            session.twilioConn.send(JSON.stringify(message));
        }

        // 버퍼 초기화
        session.buffer = Buffer.alloc(0);
        logger.debug(`[ElevenLabs] Twilio 스트림 클리어: ${sessionId}`);
    }

    /**
     * 인터럽트 처리 (오디오 전송 차단, 연결 유지)
     * @param {string} sessionId - 세션 ID
     */
    interruptStream(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        // 오디오 전송 차단 및 내부 버퍼 & 콜백 초기화
        session.isMuted = true;
        session.isFlushing = false;
        session.buffer = Buffer.alloc(0);
        session.callbacks = undefined;
        if (session.flushCompletionTimer) {
            clearTimeout(session.flushCompletionTimer);
            session.flushCompletionTimer = undefined;
        }

        // ElevenLabs 서버에 flush 요청
        if (session.ws.readyState === WebSocket.OPEN) {
            const message: ElevenLabsInputMessage = { text: '', flush: true };
            session.ws.send(JSON.stringify(message));
        }

        logger.debug(`[ElevenLabs] 스트림 인터럽트: ${sessionId}`);
    }

    /**
     * 세션 종료
     * @param {string} sessionId - 세션 ID
     */
    stopSession(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        session.isActive = false;

        if (session.ws.readyState === WebSocket.OPEN) {
            const message: ElevenLabsInputMessage = { text: '' };
            session.ws.send(JSON.stringify(message));
            session.ws.close();
        }

        this.sessions.delete(sessionId);
        logger.debug(`[ElevenLabs] 세션 종료: ${sessionId}`);
    }

    /**
     * 세션 통계 조회
     * @param {string} sessionId - 세션 ID
     * @returns {ElevenLabsStreamResult | null} 세션 통계 또는 null
     */
    getSessionStats(sessionId: string): ElevenLabsStreamResult | null {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        return {
            success: true,
            totalChunks: session.totalChunks,
            totalBytes: session.totalBytes,
            durationMs: session.firstChunkTimestamp
                ? Date.now() - session.firstChunkTimestamp
                : 0,
            firstChunkTimestamp: session.firstChunkTimestamp,
        };
    }

    /**
     * 세션 활성 여부 확인
     * @param {string} sessionId - 세션 ID
     * @returns {boolean} 세션 활성 여부
     */
    isSessionActive(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        return session.isActive && session.ws.readyState === WebSocket.OPEN;
    }
}
