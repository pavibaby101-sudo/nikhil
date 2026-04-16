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

export async function generateResponse(uid: string, userMessage: string, history: Message[]) {
  // If Groq API key is available, we could use it here for even faster text.
  // For now, we use Gemini Flash Lite which is already very fast.
  const model = "gemini-3.1-flash-lite-preview";
  
  const userDoc = await getDoc(doc(db, "users", uid));
  const userData = userDoc.data();
  const userName = userData?.name || "User";
  const learnedFacts = userData?.learnedFacts || [];

  const systemInstruction = `You are Aura, a futuristic and highly intelligent AI voice assistant. 
  Your personality is sophisticated, helpful, and slightly witty, similar to Jarvis or TARS.
  The user's name is ${userName}.
  
  LEARNED FACTS ABOUT USER:
  ${learnedFacts.length > 0 ? learnedFacts.map((f: string) => `- ${f}`).join('\n') : "No specific facts learned yet."}

  Always respond in a natural, conversational tone. 
  Keep responses very concise (1-2 sentences) for fast voice delivery.
  You have access to the user's conversation history and you learn from interactions.`;

  const contents = [
    ...history.slice(-6).map(m => ({ 
      role: m.role,
      parts: [{ text: m.content }]
    })),
    {
      role: "user",
      parts: [{ text: userMessage }]
    }
  ];

  const result = await ai.models.generateContent({
    model,
    contents,
    config: {
      systemInstruction,
      temperature: 0.7,
    }
  });

  return result.text || "I'm sorry, I couldn't process that.";
}

export async function learnFromInteraction(uid: string, userMessage: string, aiResponse: string) {
  try {
    // Use Flash Lite for learning to avoid rate limits and maintain speed
    const model = "gemini-3.1-flash-lite-preview";
    const userDoc = await getDoc(doc(db, "users", uid));
    const currentFacts = userDoc.data()?.learnedFacts || [];

    const prompt = `Analyze the following exchange between a user and an AI assistant. 
    Extract any new, relevant facts about the user (preferences, projects, names, dates, habits).
    
    Current known facts:
    ${currentFacts.join('\n')}
    
    Exchange:
    User: ${userMessage}
    AI: ${aiResponse}
    
    Return a JSON array of strings containing ONLY the new facts to add. If no new facts are found, return an empty array [].
    Do not repeat existing facts. Keep facts concise.`;

    const result = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: { type: Type.STRING }
        }
      }
    });

    const text = result.text;
    if (!text) return;

    const newFacts = JSON.parse(text);
    if (Array.isArray(newFacts) && newFacts.length > 0) {
      await setDoc(doc(db, "users", uid), {
        learnedFacts: [...currentFacts, ...newFacts].slice(-50)
      }, { merge: true });
    }
  } catch (error: any) {
    // Silently handle rate limits for background tasks
    if (error?.status === "RESOURCE_EXHAUSTED" || error?.message?.includes("429")) {
      console.warn("Learning process paused due to rate limits.");
    } else {
      console.error("Learning process failed:", error);
    }
  }
}

export async function generateSpeech(text: string): Promise<string | null> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: `Say naturally: ${text}` }] }],
      config: {
        responseModalities: ["AUDIO" as any],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Zephyr" }, // Zephyr sounds sophisticated
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    return base64Audio || null;
  } catch (error) {
    console.error("Speech generation failed:", error);
    return null;
  }
}
