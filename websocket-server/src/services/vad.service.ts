import VAD from 'node-vad';
import { saveUtteranceForQA } from '../utils/test-vad';
import logger from '../config/logger';

// µ-law to 16-bit PCM 변환 함수
// 매번 실시간으로 음성 데이터 형식을 변환하게 되면 연산비용이 커서 Lookup 테이블을 사용하여 CPU-Bound 작업을 줄입니다.
function ulawToPcm16(ulawAudio: Buffer): Buffer {
    const pcm16 = Buffer.alloc(ulawAudio.length * 2);
    const pcm_lookup = [
        -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956, -23932, -22908, -21884, -20860, -19836, -18812,
        -17788, -16764, -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412, -11900, -11388, -10876, -10364,
        -9852, -9340, -8828, -8316, -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140, -5884, -5628, -5372,
        -5116, -4860, -4604, -4348, -4092, -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004, -2876, -2748,
        -2620, -2492, -2364, -2236, -2108, -2012, -1948, -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
        -1372, -1308, -1244, -1180, -1116, -1052, -988, -924, -876, -844, -812, -780, -748, -716, -684, -652,
        -620, -588, -556, -524, -492, -460, -428, -396, -372, -356, -340, -324, -308, -292, -276, -260, -244,
        -228, -212, -196, -180, -164, -148, -132, -120, -112, -104, -96, 88,
        80, 72, 64, 56, 48, 40, 32, 24, 16, 8, 0, 32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956, 23932, 22908, 21884, 20860,
        19836, 18812, 17788, 16764, 15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412, 11900, 11388, 10876,
        10364, 9852, 9340, 8828, 8316, 7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140, 5884, 5628, 5372, 5116,
        4860, 4604, 4348, 4092, 3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004, 2876, 2748, 2620, 2492, 2364,
        2236, 2108, 2012, 1948, 1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436, 1372, 1308, 1244, 1180, 1116,
        1052, 988, 924, 876, 844, 812, 780, 748, 716, 684, 652, 620, 588, 556, 524, 492, 460, 428, 396, 372,
        356, 340, 324, 308, 292, 276, 260, 244, 228, 212, 196, 180, 164, 148, 132, 120, 112, 104, -96, -88, -80,
        -72, -64, -56, -48, -40, -32, -24, -16, -8, 0,
    ];
    for (let i = 0; i < ulawAudio.length; i++) {
        pcm16.writeInt16LE(pcm_lookup[ulawAudio[i]], i * 2);
    }
    return pcm16;
}

const vad = new VAD(VAD.Mode.VERY_AGGRESSIVE);
const SILENCE_THRESHOLD = 800; // 800ms 이상 침묵이 지속되면 발화 종료로 간주

// VAD 상태를 직접 관리하기 위한 인터페이스
export interface VadState {
    isSpeaking: boolean;
    vadAudioBuffer: Buffer[];
    speechStartTimestamp: number;
    lastVoiceTimestamp: number;
}

export interface VadResult {
    speechEnded: boolean;
    utterance?: Buffer;
}

export async function processAudioWithVAD(
    vadState: VadState,
    audioChunk: Buffer,
    callSid: string
): Promise<VadResult> {
    const pcm16 = ulawToPcm16(audioChunk);
    const vadEvent = await vad.processAudio(pcm16, 8000);
    const now = Date.now();

    if (vadEvent === VAD.Event.VOICE) {
        if (!vadState.isSpeaking) {
            logger.info(`[VAD] Speech STARTED (CallSid: ${callSid})`);
            vadState.isSpeaking = true;
            vadState.speechStartTimestamp = now; // 발화 시작 시간 기록
            vadState.vadAudioBuffer = []; // 버퍼 초기화
        }
        vadState.lastVoiceTimestamp = now;
        vadState.vadAudioBuffer.push(audioChunk);
    } else if (vadEvent === VAD.Event.SILENCE) {
        if (vadState.isSpeaking) {
            vadState.vadAudioBuffer.push(audioChunk);
            const silenceDuration = now - (vadState.lastVoiceTimestamp || now);

            if (silenceDuration > SILENCE_THRESHOLD) {
                logger.info(`[VAD] Speech ENDED (silence: ${silenceDuration}ms, CallSid: ${callSid})`);
                vadState.isSpeaking = false;
                vadState.speechStartTimestamp = 0; // 발화 시작 시간 초기화

                if (vadState.vadAudioBuffer.length > 0) {
                    const completeUtterance = Buffer.concat(vadState.vadAudioBuffer);
                    vadState.vadAudioBuffer = []; // 버퍼 초기화

                    // QA를 위한 발화 저장
                    // await saveUtteranceForQA(callSid, [completeUtterance]);

                    return { speechEnded: true, utterance: completeUtterance };
                }
            }
        }
    }

    return { speechEnded: false };
}
