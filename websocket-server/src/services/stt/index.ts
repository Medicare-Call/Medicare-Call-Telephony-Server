import { STTService } from './rtzr.service';
import { DEFAULT_STT_CONFIG } from './rtzr.config';

export const sttService = new STTService(DEFAULT_STT_CONFIG);

export { STTService } from './rtzr.service';
export type { STTConfig, STTCallbacks, STTSession } from './rtzr.types';
export { DEFAULT_STT_CONFIG } from './rtzr.config';
