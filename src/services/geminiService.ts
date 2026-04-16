import { GoogleGenAI, Type } from "@google/genai";
import { db, auth } from "../firebase";
import { collection, addDoc, query, orderBy, limit, getDocs, serverTimestamp, doc, setDoc, getDoc } from "firebase/firestore";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface Message {
  role: "user" | "model";
  content: string;
  timestamp: any;
}

export async function getConversationHistory(uid: string): Promise<Message[]> {
  const q = query(
    collection(db, "users", uid, "messages"),
    orderBy("timestamp", "asc"),
    limit(50)
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => doc.data() as Message);
}

export async function saveMessage(uid: string, role: "user" | "model", content: string) {
  await addDoc(collection(db, "users", uid, "messages"), {
    role,
    content,
    timestamp: serverTimestamp(),
    uid
  });
  
  // Update last interaction
  await setDoc(doc(db, "users", uid), {
    lastInteraction: serverTimestamp(),
    uid
  }, { merge: true });
}

export interface LearnedFact {
  fact: string;
  category: string;
  confidence: number;
  timestamp: string;
}

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
          ...messages.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.parts[0].text }))
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

async function callOpenRouter(systemInstruction: string, messages: any[]) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://aura-ai.app", // Optional
        "X-Title": "Aura AI Assistant"
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3.1-405b-instruct",
        messages: [
          { role: "system", content: systemInstruction },
          ...messages.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.parts[0].text }))
        ]
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("OpenRouter API failed:", e);
    return null;
  }
}

async function callGroq(systemInstruction: string, messages: any[]) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "llama-3.1-70b-versatile",
        messages: [
          { role: "system", content: systemInstruction },
          ...messages.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.parts[0].text }))
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

export async function generateResponse(uid: string, userMessage: string, history: Message[]) {
  const userDoc = await getDoc(doc(db, "users", uid));
  const userData = userDoc.data();
  const userName = userData?.name || "User";
  const learnedFacts: LearnedFact[] = userData?.learnedFacts || [];

  const reliableFacts = learnedFacts
    .filter(f => f.confidence > 0.7)
    .map(f => `- [${f.category}] ${f.fact}`)
    .join('\n');

  const systemInstruction = `You are Aura, a futuristic AI. 
  User: ${userName}.
  Memory: ${reliableFacts || "None"}.
  Rules: Concise (1-2 sentences). Sophisticated tone. Use memory naturally.`;

  const messages = [
    ...history.slice(-8).map(m => ({ 
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    {
      role: "user",
      parts: [{ text: userMessage }]
    }
  ];

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction, messages })
    });
    
    if (!response.ok) throw new Error("API failed");
    
    const data = await response.json();
    return data.text;
  } catch (error) {
    console.error("Chat API failed:", error);
    return "I'm experiencing high traffic. Please try again in a moment.";
  }
}

export async function learnFromInteraction(uid: string, userMessage: string, aiResponse: string) {
  try {
    const userDoc = await getDoc(doc(db, "users", uid));
    const currentFacts: LearnedFact[] = userDoc.data()?.learnedFacts || [];

    const response = await fetch("/api/learn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userMessage, aiResponse, currentFacts })
    });

    if (!response.ok) return;
    const data = await response.json();
    const newFactsRaw = data.facts;

    if (Array.isArray(newFactsRaw) && newFactsRaw.length > 0) {
      const newFacts: LearnedFact[] = newFactsRaw.map(f => ({
        ...f,
        timestamp: new Date().toISOString()
      }));

      const uniqueNewFacts = newFacts.filter(nf => 
        !currentFacts.some(cf => cf.fact.toLowerCase().includes(nf.fact.toLowerCase()) || nf.fact.toLowerCase().includes(cf.fact.toLowerCase()))
      );

      if (uniqueNewFacts.length > 0) {
        await setDoc(doc(db, "users", uid), {
          learnedFacts: [...currentFacts, ...uniqueNewFacts].slice(-100)
        }, { merge: true });
      }
    }
  } catch (error) {
    console.error("Learning process failed:", error);
  }
}

export async function generateSpeech(text: string): Promise<string | null> {
  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data.audio || null;
  } catch (error) {
    console.error("TTS API failed:", error);
    return null;
  }
}
