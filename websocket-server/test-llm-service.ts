import { LLMService } from './src/services/llmService';
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
    try {
        const response = await llmService.generateResponse(systemPrompt, userMessage, history);
        console.log("\n--- Response from LLM ---");
        console.log(response);
        console.log("-------------------------\n");
    } catch (error) {
        console.error("Failed to generate response:", error);
    }
}

main();
