import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { ChatMessage, LLMCallbacks } from './openai.types';
import { LLM_DEFAULT_MODEL, LLM_DEFAULT_TEMPERATURE } from './openai.config';

export class LLMService {
    private model: ChatOpenAI;

    constructor(apiKey: string, modelName: string = LLM_DEFAULT_MODEL, temperature: number = LLM_DEFAULT_TEMPERATURE) {
        this.model = new ChatOpenAI({
            openAIApiKey: apiKey,
            modelName: modelName,
            temperature: temperature,
        });
    }

    /**
     * 스트리밍 방식으로 LLM 응답을 생성하고 토큰/문장 단위로 콜백 호출
     * @param systemPrompt 컨텍스트를 설정하기 위한 시스템 프롬프트
     * @param userMessage 현재 사용자 메시지
     * @param callbacks 토큰/문장 완성 시 호출될 콜백들
     * @param history 선택적 대화 기록
     * @param abortController 스트리밍 중단용 AbortController
     */
    async streamResponse(
        systemPrompt: string,
        userMessage: string,
        callbacks: LLMCallbacks,
        history: ChatMessage[] = [],
        abortController?: AbortController
    ): Promise<void> {
        const messages: BaseMessage[] = [];

        // 시스템 프롬프트 및 대화 기록추가
        messages.push(new SystemMessage(systemPrompt));

        for (const msg of history) {
            if (msg.role === 'user') {
                messages.push(new HumanMessage(msg.content));
            } else if (msg.role === 'assistant') {
                messages.push(new AIMessage(msg.content));
            } else if (msg.role === 'system') {
                messages.push(new SystemMessage(msg.content));
            }
        }

        // 현재 사용자 메시지 추가
        messages.push(new HumanMessage(userMessage));

        let fullResponse = '';
        let isFirstToken = true;

        try {
            // AbortController signal 전달
            const streamOptions = abortController ? { signal: abortController.signal } : undefined;
            const stream = await this.model.stream(messages, streamOptions);

            for await (const chunk of stream) {
                // 중단 체크
                if (abortController?.signal.aborted) {
                    break;
                }

                const content = typeof chunk.content === 'string'
                    ? chunk.content
                    : '';

                if (!content) continue;

                if (isFirstToken) {
                    isFirstToken = false;
                    if (callbacks.onFirstToken) {
                        callbacks.onFirstToken();
                    }
                }

                // 토큰 단위 콜백 호출
                if (callbacks.onToken) {
                    callbacks.onToken(content);
                }

                fullResponse += content;
            }

            if (callbacks.onComplete) {
                callbacks.onComplete(fullResponse.trim());
            }

        } catch (error) {
            // AbortError는 정상적인 중단으로 처리
            if ((error as Error).name === 'AbortError') {
                console.log("LLM 스트리밍 중단됨");
                if (callbacks.onError) {
                    callbacks.onError(error as Error);
                }
                return;
            }

            console.error("LLM 스트리밍 응답 생성 중 오류 발생:", error);
            if (callbacks.onError) {
                callbacks.onError(error as Error);
            }
            throw error;
        }
    }
}
