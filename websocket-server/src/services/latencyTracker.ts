import logger from '../config/logger';

interface PipelineTimestamps {
    VADEnd?: number;
    LLMCall?: number;
    LLMFirstToken?: number;
    TTSFirstChunk?: number;
}

class LatencyTracker {
    private sessions = new Map<string, PipelineTimestamps>();
    private enabled = true;

    start(sessionId: string): void {
        if (!this.enabled) return;
        this.sessions.set(sessionId, {});
    }

    recordVADEnd(sessionId: string): void {
        if (!this.enabled) return;
        const timings = this.sessions.get(sessionId);
        if (timings) timings.VADEnd = Date.now();
    }

    recordLLMCall(sessionId: string, callSid: string): void {
        if (!this.enabled) return;
        const timings = this.sessions.get(sessionId);
        if (!timings) return;

        timings.LLMCall = Date.now();

        if (timings.VADEnd) {
            logger.info(`[Latency] VAD 발화중지 판단 -> LLM 호출: ${timings.LLMCall - timings.VADEnd}ms (CallSid: ${callSid})`);
        }
    }

    recordLLMFirstToken(sessionId: string, callSid: string): void {
        if (!this.enabled) return;
        const timings = this.sessions.get(sessionId);
        if (!timings || timings.LLMFirstToken) return;

        timings.LLMFirstToken = Date.now();

        if (timings.LLMCall) {
            logger.info(`[Latency] LLM 호출 -> 첫 토큰 응답: ${timings.LLMFirstToken - timings.LLMCall}ms (CallSid: ${callSid})`);
        }
    }

    recordTTSFirstChunk(sessionId: string, callSid: string, timestamp: number): void {
        if (!this.enabled) return;
        const timings = this.sessions.get(sessionId);
        if (!timings || timings.TTSFirstChunk) return;

        timings.TTSFirstChunk = timestamp;

        if (timings.LLMFirstToken) {
            logger.info(`[Latency] LLM 첫 토큰 응답 -> TTS 첫 청크 발송: ${timestamp - timings.LLMFirstToken}ms (CallSid: ${callSid})`);
        }

        if (timings.VADEnd) {
            logger.info(`[Latency] End-to-End: ${timestamp - timings.VADEnd}ms (CallSid: ${callSid})`);
        }
    }

    clear(sessionId: string): void {
        this.sessions.delete(sessionId);
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }
}

export const latencyTracker = new LatencyTracker();
