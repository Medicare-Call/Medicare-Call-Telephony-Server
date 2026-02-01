import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface StreamCallbacks {
    onFirstToken?: () => void;
    onToken?: (token: string) => void;
    onComplete?: (fullResponse: string) => void;
    onError?: (error: Error) => void;
}

export class LLMService {
    private model: ChatOpenAI;

    constructor(apiKey: string, modelName: string = "gpt-4o-mini", temperature: number = 0.7) {
        this.model = new ChatOpenAI({
            openAIApiKey: apiKey,
            modelName: modelName,
            temperature: temperature,
        });
    }

    /**
     * 대화 기록과 현재 사용자 메시지를 기반으로 LLM 응답을 생성
     * @param systemPrompt 컨텍스트를 설정하기 위한 시스템 프롬프트
     * @param userMessage 현재 사용자 메시지
     * @param history 선택적 대화 기록
     * @returns AI의 응답 텍스트
     */
    async generateResponse(
        systemPrompt: string,
        userMessage: string,
        history: ChatMessage[] = []
    ): Promise<string> {
        const messages: BaseMessage[] = [];

        // 시스템 프롬프트 추가
        messages.push(new SystemMessage(systemPrompt));

        // 대화 기록 추가
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

        try {
            const response = await this.model.invoke(messages);

            if (typeof response.content === 'string') {
                return response.content;
            } else {
                // 필요한 경우 복합 콘텐츠 유형 처리, 현재는 결합
                return Array.isArray(response.content)
                    ? response.content.map(c => (typeof c === 'string' ? c : JSON.stringify(c))).join(' ')
                    : JSON.stringify(response.content);
            }
        } catch (error) {
            console.error("LLM 응답 생성 중 오류 발생:", error);
            throw error;
        }
    }

    /**
     * 초기 인사말 생성 (시스템 프롬프트 기반, 사용자 입력 없이)
     * 통화 시작 시 AI가 먼저 말을 걸도록 하는 용도
     * @param systemPrompt 시스템 프롬프트 (역할 및 지시사항)
     * @returns AI의 초기 인사말
     */
    async generateInitialGreeting(systemPrompt: string): Promise<string> {
        return this.generateResponse(systemPrompt, '');
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
        callbacks: StreamCallbacks,
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
