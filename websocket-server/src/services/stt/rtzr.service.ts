import WebSocket from 'ws';
import logger from '../../config/logger';
import { STTConfig, STTCallbacks, STTSession } from './rtzr.types';
import { RTZR_AUTH_URL, RTZR_WS_URL } from './rtzr.config';

/**
 * 리턴제로 WebSocket 스트리밍 STT 서비스
 */
export class STTService {
    private config: Required<STTConfig>;
    private sessions: Map<string, STTSession> = new Map();
    private authToken: string | null = null;
    private tokenExpiry: number = 0;

    constructor(config: STTConfig) {
        this.config = {
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            sampleRate: config.sampleRate || 8000,
            useItn: config.useItn ?? true,
            useDisfluencyFilter: config.useDisfluencyFilter ?? true,
            useProfanityFilter: config.useProfanityFilter ?? false,
        };

        if (!this.config.clientId || !this.config.clientSecret) {
            throw new Error('리턴제로 STT client_id와 client_secret를 설정해주세요.');
        }

        logger.info('STT 서비스 초기화 완료', {
            sampleRate: this.config.sampleRate,
        });
    }

    /**
     * 리턴제로 API 인증 토큰 발급 및 캐싱
     * 유효한 토큰이 있으면 재사용하고, 만료되었으면 새로 발급
     * @returns {Promise<string>} 액세스 토큰
     * @throws {Error} 인증 실패 시
     * @private
     */
    private async authenticate(): Promise<string> {
        // 토큰이 유효하면 재사용
        if (this.authToken && Date.now() < this.tokenExpiry) {
            return this.authToken;
        }

        try {
            const response = await fetch(RTZR_AUTH_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    client_id: this.config.clientId,
                    client_secret: this.config.clientSecret,
                }),
            });

            if (!response.ok) {
                throw new Error(`인증 실패: ${response.status} ${response.statusText}`);
            }

            const data = (await response.json()) as { access_token: string; expire_at: number };
            this.authToken = data.access_token;
            this.tokenExpiry = data.expire_at;

            logger.info('STT 인증 토큰 발급 완료');
            return this.authToken;
        } catch (error) {
            logger.error('STT 인증 실패:', error);
            throw error;
        }
    }

    /**
     * 세션별 STT 스트리밍 시작 (통화당 1개 WebSocket 연결)
     * 통화 시작 시 호출해서 WebSocket 연결을 유지하고, 
     * sendAudio()로 실시간 오디오를 전송하면 onTranscript 콜백으로 결과를 받음
     *
     * @param {string} sessionId - 세션 ID (callSid)
     * @param {STTCallbacks} callbacks - 결과 처리를 위한 콜백 함수들
     * @returns {Promise<void>}
     * @throws {Error} WebSocket 연결 또는 인증 실패 시
     */
    async startSTT(sessionId: string, callbacks: STTCallbacks): Promise<void> {
        if (this.sessions.has(sessionId)) {
            logger.warn(`STT 세션이 이미 존재합니다: ${sessionId}`);
            return;
        }

        try {
            // 1. 인증 토큰 발급
            const token = await this.authenticate();

            // 2. WebSocket URL 생성
            const params = new URLSearchParams({
                sample_rate: this.config.sampleRate.toString(),
                encoding: 'MULAW',
                use_itn: this.config.useItn.toString(),
                use_disfluency_filter: this.config.useDisfluencyFilter.toString(),
                use_profanity_filter: this.config.useProfanityFilter.toString(),
            });

            const wsUrl = `${RTZR_WS_URL}?${params.toString()}`;

            // 3. WebSocket 연결
            const ws = new WebSocket(wsUrl, {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            // 4. WebSocket 연결 완료 대기
            await new Promise<void>((resolve, reject) => {
                ws.on('open', () => {
                    logger.info(`[STT] WebSocket 연결 완료: ${sessionId}`);
                    resolve();
                });

                ws.on('error', (error) => {
                    logger.error(`[STT] WebSocket 연결 실패: ${sessionId}`, error);
                    reject(error);
                });
            });

            // 5. 이벤트 핸들러 설정
            ws.on('message', (data: WebSocket.Data) => {
                try {
                    const response = JSON.parse(data.toString()) as {
                        seq: number;
                        start_at: number;
                        duration: number;
                        final: boolean;
                        alternatives: Array<{
                            text: string;
                            confidence: number;
                        }>;
                    };

                    const text = response.alternatives[0]?.text || '';
                    const isFinal = response.final;

                    // 텍스트가 있으면 콜백 호출
                    if (text) {
                        callbacks.onTranscript(text, isFinal);

                        if (isFinal) {
                            logger.debug(`[STT] 최종 결과 (seq: ${response.seq}): ${text}`);
                        } else {
                            logger.debug(`[STT] 중간 결과 (seq: ${response.seq}): ${text}`);
                        }
                    }
                } catch (error) {
                    logger.error('[STT] 응답 파싱 실패:', error);
                    if (callbacks.onError) {
                        callbacks.onError(error as Error);
                    }
                }
            });

            ws.on('error', (error) => {
                logger.error(`[STT] WebSocket 에러: ${sessionId}`, error);
                if (callbacks.onError) {
                    callbacks.onError(error);
                }
            });

            ws.on('close', () => {
                logger.info(`[STT] WebSocket 연결 종료: ${sessionId}`);
                this.sessions.delete(sessionId);
                if (callbacks.onClose) {
                    callbacks.onClose();
                }
            });

            // 6. 세션 저장
            this.sessions.set(sessionId, {
                ws,
                callbacks,
                isActive: true,
            });

            logger.info(`[STT] 스트리밍 시작: ${sessionId}`);
        } catch (error) {
            logger.error(`[STT] 시작 실패: ${sessionId}`, error);
            if (callbacks.onError) {
                callbacks.onError(error as Error);
            }
            throw error;
        }
    }

    /**
     * 오디오 청크 전송
     * VAD에서 변환된 MULAW 버퍼를 전송
     * @param sessionId 세션 ID
     * @param audioChunk MULAW 오디오 버퍼
     */
    sendAudio(sessionId: string, audioChunk: Buffer): void {
        const session = this.sessions.get(sessionId);
        if (!session || !session.isActive) {
            logger.warn(`[STT] 활성 세션 없음: ${sessionId}`);
            return;
        }

        if (session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(audioChunk);
        } else {
            logger.warn(`[STT] WebSocket 연결 끊김: ${sessionId}`);
        }
    }

    /**
     * STT 스트리밍 종료 (EOS 신호 전송)
     * @param sessionId 세션 ID
     */
    stopSTT(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.warn(`[STT] 세션 없음: ${sessionId}`);
            return;
        }

        if (session.ws.readyState === WebSocket.OPEN) {
            session.ws.send('EOS');
            logger.info(`[STT] EOS 신호 전송: ${sessionId}`);

            // 잠시 후 연결 종료
            setTimeout(() => {
                session.ws.close();
                this.sessions.delete(sessionId);
            }, 500);
        }

        session.isActive = false;
    }

    /**
     * 모든 세션 종료
     */
    stopAllSessions(): void {
        logger.info(`[STT] 모든 세션 종료 (${this.sessions.size}개)`);
        this.sessions.forEach((session, sessionId) => {
            this.stopSTT(sessionId);
        });
    }

    /**
     * 세션 활성 상태 확인
     */
    isSessionActive(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        return session?.isActive ?? false;
    }
}
