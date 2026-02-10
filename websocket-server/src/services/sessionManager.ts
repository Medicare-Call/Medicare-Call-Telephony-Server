import { WebSocket } from 'ws';
import AWS from 'aws-sdk';
import { Writer } from 'wav';
import { PassThrough } from 'stream';
import { VadState } from './vad.service';
import { isOpen } from '../utils/websocket.utils';

export interface Session extends VadState {
    sessionId: string;
    callSid: string;
    elderId?: number;
    settingId?: number;
    prompt?: string;
    twilioConn?: WebSocket;
    streamSid?: string;
    latestMediaTimestamp?: number;
    openAIApiKey: string;
    webhookUrl?: string;
    conversationHistory: { is_elderly: boolean; conversation: string }[];
    audioBuffer: Buffer[];
    startTime?: Date;
    endTime?: Date;
    callStatus?: string;
    responded?: number;
    pipeline?: 'realtime' | 'modular';

    // Realtime Pipeline 전용
    modelConn?: WebSocket; // GPT Realtime API 연결
    lastAssistantItem?: string;
    responseStartTimestamp?: number;

    // Modular Pipeline 전용
    transcriptBuffer?: string[]; // STT final 결과를 누적, VAD speechEnded 시 LLM에 전달
    isTTSPlaying?: boolean; // TTS 재생 중 여부
    lastAudioSentToTwilio?: number; // 마지막 오디오 Twilio 전송 시간
    wasInterrupted?: boolean; // 현재 AI 응답이 인터럽트되었는지
    currentLLMAbortController?: AbortController; // LLM 스트리밍 중단용
    pendingAIResponse?: string; // TTS 완료 대기 중인 AI 응답 (TTS 완료 시 히스토리에 저장됨)
    lastAIHistorySavedAt?: number; // 마지막 AI 응답 히스토리 저장 시간
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
        pipeline?: 'realtime' | 'modular';
    }
): Session {
    const session: Session = {
        sessionId: callSid,
        callSid: callSid,
        elderId: config.elderId,
        settingId: config.settingId,
        prompt: config.prompt,
        openAIApiKey: config.openAIApiKey,
        webhookUrl: config.webhookUrl,
        conversationHistory: [],
        audioBuffer: [],
        startTime: new Date(),
        pipeline: config.pipeline,
        // VadState 필드 초기화
        isSpeaking: false,
        vadAudioBuffer: [],
        lastVoiceTimestamp: 0,
        speechStartTimestamp: 0,
    };

    sessions.set(callSid, session);
    console.log(
        `새 세션 생성: ${callSid} (CallSid 사용, elderId: ${config.elderId || 'N/A'}, pipeline: ${
            config.pipeline || 'realtime'
        })`
    );
    return session;
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

    Promise.all([sendWebhookPromise(), uploadJsonToS3Promise(), uploadAudioToS3Promise()]).finally(() => {
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
        isActive: session.pipeline === 'modular'
            ? isOpen(session.twilioConn)
            : isOpen(session.twilioConn) && isOpen(session.modelConn),
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
            isActive: session.pipeline === 'modular'
                ? isOpen(session.twilioConn)
                : isOpen(session.twilioConn) && isOpen(session.modelConn),
        })),
    };
}
