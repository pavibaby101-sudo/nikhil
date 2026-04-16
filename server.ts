import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

// Correct initialization according to @google/genai SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Helper for Groq
async function callGroq(systemInstruction: string, messages: any[]) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "llama-3.1-8b-instant", // Ultra-fast model
        messages: [
          { role: "system", content: systemInstruction },
          ...messages.map(m => ({ 
            role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user', 
            content: typeof m.parts?.[0]?.text === 'string' ? m.parts[0].text : m.content || "" 
          }))
        ],
        max_tokens: 1024,
        temperature: 0.7
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("Groq API failed:", e);
    return null;
  }
}

// Helper for NVIDIA
async function callNvidia(systemInstruction: string, messages: any[]) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "meta/llama-3.1-405b-instruct",
        messages: [
          { role: "system", content: systemInstruction },
          ...messages.map(m => ({ 
            role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user', 
            content: typeof m.parts?.[0]?.text === 'string' ? m.parts[0].text : m.content || "" 
          }))
        ],
        max_tokens: 1024,
        temperature: 0.7
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("Nvidia API failed:", e);
    return null;
  }
}

app.post("/api/chat", async (req, res) => {
  const { systemInstruction, messages } = req.body;

  // 1. Try Groq (Fastest)
  const groqResp = await callGroq(systemInstruction, messages);
  if (groqResp) return res.json({ text: groqResp });

  // 2. Try Gemini
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite-preview", // Fastest Gemini model
      contents: messages,
      config: {
        systemInstruction,
        temperature: 0.7,
      }
    });
    return res.json({ text: response.text });
  } catch (error: any) {
    console.warn("Gemini failed:", error.message);
    
    // 3. Try NVIDIA
    const nvidiaResp = await callNvidia(systemInstruction, messages);
    if (nvidiaResp) return res.json({ text: nvidiaResp });

    return res.status(503).json({ error: "All providers busy" });
  }
});

app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO" as any],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Zephyr" }
          }
        }
      }
    });
    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    res.json({ audio: audioData });
  } catch (error) {
    console.error("TTS failed:", error);
    res.status(500).json({ error: "TTS failed" });
  }
});

app.post("/api/learn", async (req, res) => {
  const { userMessage, aiResponse, currentFacts } = req.body;
  try {
    const systemInstruction = `Analyze this exchange. Extract new facts about the user.
    Current Facts:
    ${currentFacts.map((f: any) => f.fact).join('\n')}
    Return a JSON array of objects: { "fact": string, "category": string, "confidence": number (0-1) }.
    De-duplicate against current facts. Only include facts with confidence > 0.6.
    Categories: preference, project, relation, habit, personal, other.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite-preview",
      contents: [{ parts: [{ text: `Exchange:\nUser: ${userMessage}\nAI: ${aiResponse}` }] }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              fact: { type: Type.STRING },
              category: { type: Type.STRING },
              confidence: { type: Type.NUMBER }
            },
            required: ["fact", "category", "confidence"]
          }
        }
      }
    });
    
    res.json({ facts: JSON.parse(response.text || "[]") });
  } catch (error) {
    console.error("Learning failed:", error);
    res.status(500).json({ error: "Learning failed" });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
