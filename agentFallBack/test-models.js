#!/usr/bin/env node

const { GoogleGenerativeAI } = require('@google/generative-ai');

async function listModels() {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    
    if (!apiKey) {
        console.error('Error: GEMINI_API_KEY or GOOGLE_AI_API_KEY environment variable is required');
        process.exit(1);
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        
        console.log('Testing available models...');
        
        // Try different model names
        const models = [
            'gemini-1.5-flash',
            'gemini-1.5-pro',
            'gemini-pro',
            'gemini-pro-vision',
            'text-bison-001',
            'chat-bison-001'
        ];
        
        for (const modelName of models) {
            try {
                console.log(`Testing model: ${modelName}`);
                const model = genAI.getGenerativeModel({ model: modelName });
                const result = await model.generateContent('Hello');
                console.log(`✅ ${modelName} - SUCCESS`);
                console.log(`Response: ${result.response.text().substring(0, 100)}...`);
                console.log('---');
                break; // Stop at first successful model
            } catch (error) {
                console.log(`❌ ${modelName} - ${error.message}`);
                console.log('---');
            }
        }
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

listModels();
