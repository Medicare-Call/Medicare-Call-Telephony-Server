import WebSocket from 'ws';

/**
 * 리턴제로 VITO STT API 설정
 */
export interface STTConfig {
    clientId: string;
    clientSecret: string;
    sampleRate?: number; // 기본: 8000
    useItn?: boolean; // Inverse Text Normalization (숫자 정규화)
    useDisfluencyFilter?: boolean; // 간투사 필터
    useProfanityFilter?: boolean; // 욕설 필터
}

/**
 * STT 결과 콜백 인터페이스
 */
export interface STTCallbacks {
    /**
     * 음성 인식 결과 콜백
     * @param text - 인식된 텍스트
     * @param isFinal - 문장 완료 여부 (true: 해당 문장 완료, false: 중간 결과)
     */
    onTranscript: (text: string, isFinal: boolean) => void;

    /**
     * 에러 발생 시 콜백
     */
    onError?: (error: Error) => void;

    /**
     * WebSocket 연결 종료 시 콜백
     */
    onClose?: () => void;
}

/**
 * STT 세션 (통화당 1개의 WebSocket 연결)
 */
export interface STTSession {
    ws: WebSocket;
    callbacks: STTCallbacks;
    isActive: boolean;
}
