import { RawData, WebSocket } from 'ws';
import AWS from 'aws-sdk';
import { Writer } from 'wav';
import { PassThrough } from 'stream';

interface Session {
    sessionId: string;
    callSid: string;
    elderId?: number;
    settingId?: number;
    prompt?: string;
    twilioConn?: WebSocket;
    modelConn?: WebSocket;
    streamSid?: string;
    lastAssistantItem?: string;
    responseStartTimestamp?: number;
    latestMediaTimestamp?: number;
    openAIApiKey: string;
    webhookUrl?: string;
    conversationHistory: { is_elderly: boolean; conversation: string }[];
    audioBuffer: Buffer[];
    startTime?: Date;
    callStatus?: string;
    responded?: number;
    endTime?: Date;
}

let sessions: Map<string, Session> = new Map();
const closingSessions = new Set<string>();

export function getSession(sessionId: string): Session | undefined {
    return sessions.get(sessionId);
}

export function createSession(
    callSid: string,
    config: {
        openAIApiKey: string;
        elderId?: number;
        settingId?: number;
        prompt?: string;
        webhookUrl?: string;
    }
): Session {
    const session: Session = {
        sessionId: callSid, // sessionId = callSid
        callSid: callSid, // CallSid 명시적 저장
        elderId: config.elderId,
        settingId: config.settingId,
        prompt: config.prompt,
        openAIApiKey: config.openAIApiKey,
        webhookUrl: config.webhookUrl,
        conversationHistory: [],
        audioBuffer: [],
        startTime: new Date(), // 통화 시작 시간 기록
    };

    sessions.set(callSid, session);
    console.log(`새 세션 생성: ${callSid} (CallSid 사용, elderId: ${config.elderId || 'N/A'})`);
    return session;
}

// === 전화 연결 처리 함수 ===
export function handleCallConnection(
    ws: WebSocket,
    openAIApiKey: string,
    webhookUrl?: string,
    elderId?: number,
    settingId?: number,
    prompt?: string,
    callSid?: string
): string {
    const sessionId = callSid || `fallback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const session = getSession(sessionId);
    if (!session) {
        console.error(
            `[Error] WebSocket 연결 시 세션을 찾을 수 없습니다: ${sessionId}. 통화가 먼저 생성되어야 합니다.`
        );
        ws.close();
        return sessionId;
    }

    // 기존 세션에 WebSocket 연결을 추가합니다.
    session.twilioConn = ws;

    ws.on('message', (data) => handleTwilioMessage(sessionId, data));
    ws.on('error', () => ws.close());
    ws.on('close', () => closeAllConnections(sessionId)); // closeAllConnections는 status-callback에서 주로 호출됩니다.

    console.log(`WebSocket 연결 완료 - CallSid: ${sessionId}`);
    return sessionId;
}

// === 실시간 대화 처리  ===
function handleTwilioMessage(sessionId: string, data: RawData): void {
    const session = getSession(sessionId);
    if (!session) return;

    const msg = parseMessage(data);
    if (!msg) return;

    // media 이벤트가 아닌 경우만 로그 출력
    if (msg.event !== 'media') {
        console.log('Twilio 메시지:', msg.event, `(CallSid: ${session.callSid})`);
    }

    switch (msg.event) {
        case 'start':
            console.log(`통화 시작 (CallSid: ${session.callSid}), streamSid: ${msg.start.streamSid}`);
            session.streamSid = msg.start.streamSid;
            session.latestMediaTimestamp = 0;
            session.lastAssistantItem = undefined;
            session.responseStartTimestamp = undefined;

            // OpenAI 연결 시도
            connectToOpenAI(sessionId);
            break;

        case 'media':
            // 실시간 음성 데이터를 OpenAI로 전달
            session.latestMediaTimestamp = msg.media.timestamp;

            const audioChunk = Buffer.from(msg.media.payload, 'base64');
            session.audioBuffer.push(audioChunk);

            if (isOpen(session.modelConn)) {
                jsonSend(session.modelConn, {
                    type: 'input_audio_buffer.append',
                    audio: msg.media.payload,
                });
            }
            break;

        case 'stop':
        case 'close':
            console.log(`통화 종료 신호 수신 (CallSid: ${session.callSid})`);
            closeAllConnections(sessionId);
            break;
    }
}

// === OpenAI 연결 함수 ===
function connectToOpenAI(sessionId: string): void {
    const session = getSession(sessionId);
    if (!session || !session.twilioConn || !session.streamSid || !session.openAIApiKey) {
        return;
    }

    if (isOpen(session.modelConn)) return; // 이미 연결됨

    console.log(`OpenAI 연결 중... (CallSid: ${session.callSid})`);

    session.modelConn = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
        headers: {
            Authorization: `Bearer ${session.openAIApiKey}`,
            'OpenAI-Beta': 'realtime=v1',
        },
    });

    session.modelConn.on('open', () => {
        console.log(`OpenAI 연결 완료 (CallSid: ${session.callSid})`);

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
            sendUserMessage(sessionId, session.prompt);
        }
    });

    session.modelConn.on('message', (data) => {
        const ts = Date.now();
        handleOpenAIMessage(sessionId, data);
    });
    session.modelConn.on('error', (error) => {
        console.error(`OpenAI 연결 오류 (CallSid: ${session.callSid}):`, error);
    });
    session.modelConn.on('close', () => {
        console.log(`OpenAI 연결 종료 (CallSid: ${session.callSid})`);
    });
}

// === 사용자 메시지 전송 ===
function sendUserMessage(sessionId: string, text: string): void {
    const session = getSession(sessionId);
    if (!session || !isOpen(session.modelConn)) return;

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

// === OpenAI 메시지 처리 ===
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
            const t = Date.now();
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
                            console.log(`AI:`, aiResponse);
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
            const ts = Date.now();
            console.log(`[[STT] 인식 완료] ${ts}:`);
            // 사용자 음성 인식 완료 - 텍스트 저장
            if (event.transcript) {
                console.log(`사용자:`, event.transcript);
                session.conversationHistory.push({
                    is_elderly: true,
                    conversation: event.transcript,
                });
            }
            break;
    }
}

// === 응답 중단 처리 ===
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

function mapTwilioStatusToDtoStatus(twilioStatus?: string): string {
    switch (twilioStatus) {
        // 성공적으로 완료된 통화
        case 'completed':
        case 'answered':
        case 'in-progress': // 'in-progress'는 통화가 진행중임을 의미하며, 종료 시점에서는 'completed'로 처리
            return 'completed';

        // 실패한 통화
        case 'failed':
        case 'canceled':
            return 'failed';

        // 통화 중
        case 'busy':
            return 'busy';

        // 부재중
        case 'no-answer':
            return 'no-answer';

        // 예외 처리: 예상치 못한 상태값일 경우 'failed'로 처리하여 서버에 기록
        default:
            console.warn(`[Status Mapping] Unexpected Twilio status: "${twilioStatus}". Mapping to "failed".`);
            return 'failed';
    }
}

// === 웹훅 전송 함수 ===
export async function sendToWebhook(sessionId: string): Promise<void> {
    const session = getSession(sessionId);
    if (!session) {
        console.error(`웹훅 전송 실패: 세션을 찾을 수 없음 (ID: ${sessionId})`);
        return;
    }
    const webhookUrl = session.webhookUrl || process.env.WEBHOOK_URL;

    if (!webhookUrl) {
        console.log('웹훅 URL이 설정되지 않음');
        return;
    }

    const transcriptionSegments = session.conversationHistory.map((item) => ({
        speaker: item.is_elderly ? '어르신' : 'AI',
        text: item.conversation,
    }));

    // DTO 형식에 맞게 응답 여부 기본값 설정
    let respondedValue: number;
    if (session.responded !== undefined) {
        respondedValue = session.responded;
    } else {
        // 응답 여부가 설정되지 않았다면, 대화 기록 유무로 판단
        respondedValue = session.conversationHistory.length > 0 ? 1 : 0;
    }

    const formattedData = {
        elderId: session.elderId,
        settingId: session.settingId || 1,
        startTime: session.startTime?.toISOString(),
        endTime: session.endTime?.toISOString() || new Date().toISOString(),
        status: mapTwilioStatusToDtoStatus(session.callStatus),
        responded: respondedValue, // Byte 타입에 맞게 number 전송
        transcription: {
            language: 'ko',
            fullText: transcriptionSegments,
        },
    };

    console.log(`웹훅 전송 데이터 (CallSid: ${session.callSid}):`, JSON.stringify(formattedData, null, 2));

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formattedData),
        });

        if (response.ok) {
            console.log(`웹훅 전송 성공 (CallSid: ${session.callSid})`);
        } else {
            const errorBody = await response.text();
            console.error(`웹훅 전송 실패 (CallSid: ${session.callSid}):`, response.status, errorBody);
        }
    } catch (error) {
        console.error(`웹훅 전송 중 오류 발생 (CallSid: ${session.callSid}):`, error);
    }
}

// === 통화 종료 처리 ===
export function closeAllConnections(sessionId: string): void {
    const session = getSession(sessionId);
    if (!session) return;

    if ((session as any)._closed || closingSessions.has(sessionId)) {
        console.log(`이미 종료 처리 중이거나 완료된 세션 (CallSid: ${session.callSid}) → 중복 호출 방지`);
        return;
    }
    closingSessions.add(sessionId);
    (session as any)._closed = true;

    console.log(`세션 종료 처리 시작 (CallSid: ${session.callSid})...`);

    const sendWebhookPromise = async () => {
        try {
            await sendToWebhook(sessionId);
        } catch (error) {
            console.error(`웹훅 전송 Promise 실패 (CallSid: ${session.callSid}):`, error);
        }
    };

    const uploadJsonToS3Promise = async () => {
        if (session.conversationHistory && session.conversationHistory.length > 0) {
            try {
                await uploadConversationToS3(sessionId, session.conversationHistory);
            } catch (error) {
                console.error(`(S3-JSON) 업로드 Promise 실패 (CallSid: ${session.callSid}):`, error);
            }
        }
    };

    const uploadAudioToS3Promise = async () => {
        if (session.audioBuffer && session.audioBuffer.length > 0) {
            try {
                await uploadAudioToS3(sessionId, session.audioBuffer);
            } catch (error) {
                console.error(`(S3-Audio) 업로드 Promise 실패 (CallSid: ${session.callSid}):`, error);
            }
        }
    };

    Promise.all([sendWebhookPromise, uploadJsonToS3Promise(), uploadAudioToS3Promise()]).finally(() => {
        if (session.twilioConn) {
            session.twilioConn.close();
            session.twilioConn = undefined;
        }
        if (session.modelConn) {
            session.modelConn.close();
            session.modelConn = undefined;
        }

        sessions.delete(sessionId);
        closingSessions.delete(sessionId);
        console.log(`세션 정리 완료 (CallSid: ${session.callSid})`);
    });
}

// S3에 대화 기록 업로드
async function uploadConversationToS3(sessionId: string, conversationHistory: any[]): Promise<void> {
    // ... (기존 JSON 업로드 로직과 동일) ...
    const s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION,
    });
    const bucketName = process.env.S3_BUCKET_NAME;

    if (!bucketName) {
        console.error('S3_BUCKET_NAME 환경변수가 설정되지 않았습니다.');
        return;
    }
    const fileContent = JSON.stringify(conversationHistory, null, 2);
    const fileName = `${sessionId}.json`;
    const params: AWS.S3.PutObjectRequest = {
        Bucket: bucketName,
        Key: `conversations/${fileName}`,
        Body: fileContent,
        ContentType: 'application/json',
    };
    try {
        await s3.putObject(params).promise();
        console.log(`(S3-JSON) 대화 기록 업로드 성공: ${params.Key} (CallSid: ${sessionId})`);
    } catch (error) {
        console.error(`(S3-JSON) 대화 기록 업로드 실패 (CallSid: ${sessionId}):`, error);
    }
}

async function uploadAudioToS3(sessionId: string, audioChunks: Buffer[]): Promise<void> {
    const s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION,
    });
    const bucketName = process.env.S3_BUCKET_NAME;

    if (!bucketName) {
        console.error('S3_BUCKET_NAME 환경변수가 설정되지 않았습니다.');
        return;
    }

    // Twilio Media Stream은 8000Hz, 8-bit μ-law 형식
    const wavEncoder = new Writer({
        sampleRate: 8000,
        channels: 1,
        bitDepth: 8,
        format: 7, // 7 for μ-law
    });

    const passthrough = new PassThrough();
    wavEncoder.pipe(passthrough);

    audioChunks.forEach((chunk) => {
        wavEncoder.write(chunk);
    });
    wavEncoder.end();

    const fileName = `${sessionId}.wav`;
    const params: AWS.S3.PutObjectRequest = {
        Bucket: bucketName,
        Key: `audio/${fileName}`, // 오디오 파일은 audio/ 폴더에 저장
        Body: passthrough,
        ContentType: 'audio/wav',
    };

    try {
        await s3.upload(params).promise();
        console.log(`(S3-Audio) 오디오 파일 업로드 성공: ${params.Key} (CallSid: ${sessionId})`);
    } catch (error) {
        console.error(`(S3-Audio) 오디오 파일 업로드 실패 (CallSid: ${sessionId}):`, error);
    }
}

// === 유틸리티 함수들 ===
function parseMessage(data: RawData): any {
    try {
        return JSON.parse(data.toString());
    } catch {
        return null;
    }
}

function jsonSend(ws: WebSocket | undefined, obj: unknown): void {
    if (!isOpen(ws)) return;
    ws.send(JSON.stringify(obj));
}

function isOpen(ws?: WebSocket): ws is WebSocket {
    return !!ws && ws.readyState === WebSocket.OPEN;
}

// === 상태 조회 함수들 ===
export function getSessionStatus(sessionId: string) {
    const session = getSession(sessionId);
    if (!session) {
        return { exists: false };
    }

    return {
        exists: true,
        sessionId: session.sessionId,
        callSid: session.callSid,
        elderId: session.elderId,
        conversationCount: session.conversationHistory.length,
        isActive: isOpen(session.twilioConn) && isOpen(session.modelConn),
    };
}

export function getAllActiveSessions() {
    return {
        totalSessions: sessions.size,
        activeSessions: Array.from(sessions.values()).map((session) => ({
            sessionId: session.sessionId,
            callSid: session.callSid,
            elderId: session.elderId,
            conversationCount: session.conversationHistory.length,
            isActive: isOpen(session.twilioConn) && isOpen(session.modelConn),
        })),
    };
}
