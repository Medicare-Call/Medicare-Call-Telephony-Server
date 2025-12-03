import { RTZR_CLIENT_ID, RTZR_CLIENT_SECRET } from '../../config/env';
import { STTConfig } from './stt.types';

export const RTZR_AUTH_URL = 'https://openapi.vito.ai/v1/authenticate';
export const RTZR_WS_URL = 'wss://openapi.vito.ai/v1/transcribe:streaming';

/**
 * 기본 STT 설정 (리턴제로 STT API)
 */
export const DEFAULT_STT_CONFIG: Required<STTConfig> = {
    clientId: RTZR_CLIENT_ID,
    clientSecret: RTZR_CLIENT_SECRET,
    sampleRate: 8000, // Twilio 제공 샘플레이트
    useItn: true, // 숫자 정규화 활성화
    useDisfluencyFilter: true, // 간투사 필터 활성화
    useProfanityFilter: false, // 욕설 필터 비활성화
};
