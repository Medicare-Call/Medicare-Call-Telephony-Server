import { LLMService } from './src/services/llm';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error("OPENAI_API_KEY is not set in .env file");
        process.exit(1);
    }

    console.log("Initializing LLMService...");
    const llmService = new LLMService(apiKey);

    const systemPrompt = "You are a helpful assistant.";
    const userMessage = "Hello, tell me a short joke about programming.";
    const history = [
        { role: 'user' as const, content: "Hi there!" },
        { role: 'assistant' as const, content: "Hello! How can I help you today?" }
    ];

    console.log("Sending request to LLM...");
    console.log("\n--- Response from LLM ---");

    try {
        await llmService.streamResponse(systemPrompt, userMessage, {
            onToken: (token) => process.stdout.write(token),
            onComplete: () => console.log("\n-------------------------\n"),
            onError: (error) => console.error("Stream error:", error),
        }, history);
    } catch (error) {
        console.error("Failed to generate response:", error);
    }
}

main();
