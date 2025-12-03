import { STTService } from './stt.service';
import { DEFAULT_STT_CONFIG } from './stt.config';

// STT 서비스 싱글톤 인스턴스
export const sttService = new STTService(DEFAULT_STT_CONFIG);

// 타입 및 클래스 re-export
export { STTService } from './stt.service';
export type { STTConfig, STTCallbacks, STTSession } from './stt.types';
export { DEFAULT_STT_CONFIG } from './stt.config';
