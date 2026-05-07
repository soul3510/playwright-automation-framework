#!/usr/bin/env node

const { GoogleGenerativeAI } = require('@google/generative-ai');

async function main() {
    // Get API key from environment variable
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    
    if (!apiKey) {
        console.error('Error: GEMINI_API_KEY or GOOGLE_AI_API_KEY environment variable is required');
        process.exit(1);
    }

    // Initialize the AI client
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

    try {
        // Read input from stdin
        let input = '';
        process.stdin.setEncoding('utf8');
        
        for await (const chunk of process.stdin) {
            input += chunk;
        }

        if (!input.trim()) {
            console.error('Error: No input provided');
            process.exit(1);
        }

        // Generate response
        const result = await model.generateContent(input);
        const response = result.response.text();
        
        console.log(response);
        
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

main();
